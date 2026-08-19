import {
  mergeConsecutive,
  type ParsedTextUtterance,
} from '@/lib/server/transcript-text-parse';

/**
 * LLM "parsing recipe" engine for the import-text fallback.
 *
 * The model never re-emits transcript text (that verbatim echo caused the
 * 2026-08-18 8-minute-timeout incident — output tokens scaled 1:1 with file
 * size). Instead it returns a SMALL recipe describing the file's structure,
 * and this module applies the recipe to the original text in pure code:
 *
 *  - 'line-regex': one header regex with named groups (`speaker` required,
 *    `h`/`m`/`s` optional timestamp parts, `text` optional for inline
 *    headers), applied line-by-line. Preferred whenever the file has any
 *    per-line structure.
 *  - 'anchors': an ordered list of speaker turns, each identified by a short
 *    verbatim quote (anchor) of the turn's start; turns are sliced out of the
 *    source between consecutive located anchors. For prose with no line
 *    structure.
 *
 * Both paths merge consecutive same-speaker turns (same helper as the
 * deterministic fast path) and return coverage stats so the caller can reject
 * bad recipes and ask the model for ONE corrective retry.
 *
 * No `server-only` marker: pure module, unit-tested directly with bun.
 */

export interface LineRegexRecipe {
  kind: 'line-regex';
  /** JS regex source (no slashes). Named groups: speaker (required), h/m/s
   * (optional timestamp parts), text (optional, inline-prefix only). */
  headerRegex: string;
  /** 'own-line': header on its own line, speech on following lines.
   * 'inline-prefix': header matches at line start, remainder is the speech. */
  headerStyle: 'own-line' | 'inline-prefix';
  flags?: string;
  /** Example source lines the model claims the regex matches (debug only). */
  evidence?: string[];
}

export interface AnchorTurn {
  speaker: string;
  /** Short verbatim quote of the START of the turn (≤ 80 chars). */
  anchor: string;
}

export interface AnchorsRecipe {
  kind: 'anchors';
  turns: AnchorTurn[];
}

/** The content has no speaker turns AT ALL (meeting minutes, notes, an
 * agenda, a report). Imports as paragraph blocks under a neutral speaker —
 * the sibl_minutes.rtf case: an honest 1-anchor recipe used to die on the
 * ≥3-anchor bar because the engine had no way to say "not a conversation". */
export interface DocumentRecipe {
  kind: 'document';
}

export type ParseRecipe = LineRegexRecipe | AnchorsRecipe | DocumentRecipe;

export const MAX_HEADER_REGEX_CHARS = 300;
export const MAX_ANCHOR_TURNS = 2000;
/** Anchors are supposed to be ≤80 chars; tolerate slop up to this hard cap
 * (an over-long anchor is truncated — still a valid prefix of the turn). */
const MAX_ANCHOR_CHARS = 200;
/** Regexes only ever see this many chars of a line — bounds backtracking on
 * pathological inputs (e.g. an entire prose document on one line). */
const REGEX_LINE_HEAD = 2000;
/** Validation bars (applied by applyRecipeWithValidation). */
export const LINE_REGEX_MIN_TURNS = 5;
export const LINE_REGEX_MIN_RATIO = 0.6;
export const ANCHORS_MIN_TURNS = 3;
export const ANCHORS_MIN_RATIO = 0.8;

export interface LineRegexApplied {
  /** Turns after same-speaker merging. */
  utterances: ParsedTextUtterance[];
  /** Turn count BEFORE merging (the validation bar counts these). */
  rawTurnCount: number;
  /** (header + continuation lines) / non-blank lines. */
  matchedLineRatio: number;
  /** Up to 5 non-blank lines that were not consumed (truncated, for the
   * corrective-retry failure report). */
  unmatchedSamples: string[];
}

function groupsToMs(g: Record<string, string | undefined>): number | null {
  if (g.h == null && g.m == null && g.s == null) return null;
  const num = (v?: string) => (v != null && /^\d+$/.test(v) ? Number(v) : 0);
  return (num(g.h) * 3600 + num(g.m) * 60 + num(g.s)) * 1000;
}

/**
 * Apply a line-regex recipe. Throws on an invalid recipe (regex too long,
 * doesn't compile, missing `speaker` group, bad headerStyle); returns
 * utterances + coverage stats otherwise — validation against the bars is the
 * caller's job (see applyRecipeWithValidation).
 */
export function applyLineRegexRecipe(text: string, recipe: LineRegexRecipe): LineRegexApplied {
  const source = recipe.headerRegex;
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('headerRegex is missing');
  }
  if (source.length > MAX_HEADER_REGEX_CHARS) {
    throw new Error(
      `headerRegex is too long (${source.length} chars, max ${MAX_HEADER_REGEX_CHARS})`
    );
  }
  if (recipe.headerStyle !== 'own-line' && recipe.headerStyle !== 'inline-prefix') {
    throw new Error(`headerStyle must be 'own-line' or 'inline-prefix'`);
  }
  if (!source.includes('(?<speaker>')) {
    throw new Error('headerRegex must contain a named group (?<speaker>…)');
  }
  // Keep only flags that are safe for stateless per-line exec ('g'/'y' would
  // make exec stateful across lines).
  const flags = [...new Set((recipe.flags ?? '').split(''))]
    .filter((f) => 'imsu'.includes(f))
    .join('');
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch (err) {
    throw new Error(
      `headerRegex does not compile: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`
    );
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const utterances: ParsedTextUtterance[] = [];
  const unmatchedSamples: string[] = [];
  let current: ParsedTextUtterance | null = null;
  let nonBlank = 0;
  let consumed = 0;
  let rawTurnCount = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    nonBlank++;
    const head = line.length > REGEX_LINE_HEAD ? line.slice(0, REGEX_LINE_HEAD) : line;
    const m = re.exec(head);
    const isHeader = m != null && (recipe.headerStyle === 'own-line' || m.index === 0);
    if (isHeader && m) {
      if (current && current.text) utterances.push(current);
      const g = m.groups ?? {};
      const speaker = (g.speaker ?? '').trim().slice(0, 80) || 'Speaker 1';
      let inlineText = '';
      if (recipe.headerStyle === 'inline-prefix') {
        // Remainder of the line is the speech; a (?<text>) group wins when
        // present. The regex only saw `head`, so re-append any tail the cap
        // hid from a text group (slice-remainder already uses the full line).
        inlineText =
          g.text != null
            ? g.text + (line.length > head.length ? line.slice(head.length) : '')
            : line.slice(m.index + m[0].length);
      }
      current = { speaker, text: inlineText.trim(), startMs: groupsToMs(g) };
      rawTurnCount++;
      consumed++;
    } else if (current) {
      // Continuation of the current turn's speech.
      current.text = current.text ? `${current.text} ${line}` : line;
      consumed++;
    } else if (unmatchedSamples.length < 5) {
      unmatchedSamples.push(line.slice(0, 160));
    }
  }
  if (current && current.text) utterances.push(current);

  return {
    utterances: mergeConsecutive(utterances),
    rawTurnCount,
    matchedLineRatio: nonBlank === 0 ? 0 : consumed / nonBlank,
    unmatchedSamples,
  };
}

export interface AnchorsApplied {
  /** Turns after same-speaker merging. No timestamps → startMs null. */
  utterances: ParsedTextUtterance[];
  /** Anchors actually located (BEFORE merging). */
  locatedCount: number;
  /** located / total turns in the recipe. */
  locatedRatio: number;
  /** Up to 5 anchors that could not be located in forward order. */
  unlocatedSamples: string[];
}

/**
 * Apply an anchors recipe: locate each turn's anchor sequentially with
 * indexOf (forward-only from just past the previous match), slice each turn's
 * text from its anchor start to the next located anchor. Unlocatable anchors
 * are skipped. Throws on an invalid recipe (no turns / too many turns).
 */
export function applyAnchorsRecipe(text: string, recipe: AnchorsRecipe): AnchorsApplied {
  const turns = Array.isArray(recipe.turns) ? recipe.turns : [];
  if (turns.length === 0) throw new Error('anchors recipe has no turns');
  if (turns.length > MAX_ANCHOR_TURNS) {
    throw new Error(`anchors recipe has too many turns (${turns.length}, max ${MAX_ANCHOR_TURNS})`);
  }

  const located: Array<{ speaker: string; index: number }> = [];
  const unlocatedSamples: string[] = [];
  let pos = 0;
  for (const t of turns) {
    const anchor =
      typeof t?.anchor === 'string' ? t.anchor.slice(0, MAX_ANCHOR_CHARS) : '';
    if (!anchor.trim()) {
      if (unlocatedSamples.length < 5) unlocatedSamples.push('(empty anchor)');
      continue;
    }
    const idx = text.indexOf(anchor, pos);
    if (idx < 0) {
      if (unlocatedSamples.length < 5) unlocatedSamples.push(anchor.slice(0, 80));
      continue;
    }
    located.push({
      speaker: (typeof t.speaker === 'string' ? t.speaker : '').trim().slice(0, 80) || 'Speaker 1',
      index: idx,
    });
    pos = idx + 1; // forward-only; minimal advance keeps adjacent short turns findable
  }

  const utterances: ParsedTextUtterance[] = [];
  for (let i = 0; i < located.length; i++) {
    const end = i + 1 < located.length ? located[i + 1]!.index : text.length;
    const turnText = text
      .slice(located[i]!.index, end)
      .replace(/\s+/g, ' ')
      .trim();
    if (turnText) utterances.push({ speaker: located[i]!.speaker, text: turnText, startMs: null });
  }

  return {
    utterances: mergeConsecutive(utterances),
    locatedCount: located.length,
    locatedRatio: located.length / turns.length,
    unlocatedSamples,
  };
}

/** Speaker name document imports land under — also whitelisted by the fast
 * path's attendee filter shape (it's not a real participant). */
export const DOCUMENT_SPEAKER = 'Notes';

/**
 * Apply a document recipe: one utterance per non-blank line (minutes and
 * notes are line/bullet structured, so this reads as scannable blocks), with
 * run-on paragraphs kept whole. Deliberately NOT merged — every block shares
 * the same speaker and mergeConsecutive would collapse the lot into one wall.
 */
export function applyDocumentRecipe(text: string): ParsedTextUtterance[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ speaker: DOCUMENT_SPEAKER, text: line, startMs: null }));
}

export type RecipeApplication =
  | { ok: true; utterances: ParsedTextUtterance[] }
  | { ok: false; failure: string };

/**
 * Apply a model-returned recipe and enforce the validation bars:
 * line-regex → ≥5 turns AND matchedLineRatio ≥ 0.6;
 * anchors → ≥3 located turns AND locatedRatio ≥ 0.8;
 * document → no bars (nothing to game — output is the source verbatim).
 * Never throws — invalid/failed recipes come back as { ok: false, failure }
 * with a report the caller can feed into the model's corrective retry.
 */
export function applyRecipeWithValidation(text: string, recipe: unknown): RecipeApplication {
  if (!recipe || typeof recipe !== 'object') {
    return { ok: false, failure: 'the response had no "recipe" object' };
  }
  const kind = (recipe as { kind?: unknown }).kind;
  try {
    if (kind === 'line-regex') {
      const r = applyLineRegexRecipe(text, recipe as LineRegexRecipe);
      const pct = Math.round(r.matchedLineRatio * 100);
      if (r.rawTurnCount < LINE_REGEX_MIN_TURNS || r.matchedLineRatio < LINE_REGEX_MIN_RATIO) {
        const samples = r.unmatchedSamples.length
          ? `; example unmatched lines: ${r.unmatchedSamples.map((s) => JSON.stringify(s)).join(', ')}`
          : '';
        return {
          ok: false,
          failure: `your line-regex recipe produced ${r.rawTurnCount} turns and matched ${pct}% of non-blank lines (need at least ${LINE_REGEX_MIN_TURNS} turns and ${LINE_REGEX_MIN_RATIO * 100}%)${samples}`,
        };
      }
      return { ok: true, utterances: r.utterances };
    }
    if (kind === 'anchors') {
      const r = applyAnchorsRecipe(text, recipe as AnchorsRecipe);
      const pct = Math.round(r.locatedRatio * 100);
      if (r.locatedCount < ANCHORS_MIN_TURNS || r.locatedRatio < ANCHORS_MIN_RATIO) {
        const samples = r.unlocatedSamples.length
          ? `; example anchors not found in forward order: ${r.unlocatedSamples.map((s) => JSON.stringify(s)).join(', ')}`
          : '';
        return {
          ok: false,
          failure: `only ${r.locatedCount} of your ${Array.isArray((recipe as AnchorsRecipe).turns) ? (recipe as AnchorsRecipe).turns.length : 0} anchors (${pct}%) could be located verbatim in the source in forward order (need at least ${ANCHORS_MIN_TURNS} located and ${ANCHORS_MIN_RATIO * 100}%)${samples}`,
        };
      }
      return { ok: true, utterances: r.utterances };
    }
    if (kind === 'document') {
      const utterances = applyDocumentRecipe(text);
      if (utterances.length === 0) {
        return { ok: false, failure: 'the source has no non-blank content to import as a document' };
      }
      return { ok: true, utterances };
    }
    return { ok: false, failure: `unknown recipe kind ${JSON.stringify(kind)}` };
  } catch (err) {
    return {
      ok: false,
      failure: `the recipe could not be applied: ${String(err instanceof Error ? err.message : err).slice(0, 300)}`,
    };
  }
}

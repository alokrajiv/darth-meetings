/**
 * The DECISIONS around merged versions, pure (docs/transcription-merge-spec.md
 * §3 + Amendment A): parsing the run mode and merge options off a request
 * body, which of two versions is the base when a merge-mode run lands, what
 * to warn about on an explicit merge, and when two versions share speaker
 * labels.
 *
 * Everything that touches Postgres or AssemblyAI lives in
 * `lib/server/transcription-runs.ts`; it asks this module what to do and
 * does it. No db, no clock, no `server-only`.
 */

import type { MergeOptions } from '@/lib/transcript-merge';
import type { TranscriptionRunMode } from '@/lib/transcriptions';

export const RUN_MODES: TranscriptionRunMode[] = ['replace', 'helper', 'merge'];

/**
 * `mode` off a request body. Absent = 'replace' (every caller before the
 * merge spec). An UNKNOWN value is an error, never a silent 'replace': a
 * caller who asked for a merge and got a replace would have a forced
 * Indonesian pass shown raw — the English translated — which is exactly what
 * the mode exists to prevent.
 */
export function parseRunMode(raw: unknown): { ok: true; mode: TranscriptionRunMode } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, mode: 'replace' };
  if (typeof raw === 'string' && (RUN_MODES as string[]).includes(raw)) {
    return { ok: true, mode: raw as TranscriptionRunMode };
  }
  return { ok: false, error: `mode must be one of ${RUN_MODES.join(', ')}` };
}

/** Bounds per option — wide enough for any experiment, narrow enough to stay meaningful. */
const OPTION_BOUNDS: Record<keyof MergeOptions, { min: number; max: number; int: boolean }> = {
  utteranceThreshold: { min: 0, max: 1, int: false },
  wordThreshold: { min: 0, max: 1, int: false },
  window: { min: 1, max: 100, int: true },
  minRun: { min: 1, max: 1000, int: true },
  island: { min: 0, max: 100, int: true },
};

/**
 * `mergeOptions` / `options` off a request body. Absent = defaults. A field
 * that is present but wrong is refused with the field's name rather than
 * quietly replaced by the default: `--threshold 7.5` must say so.
 */
export function parseMergeOptions(
  raw: unknown
): { ok: true; options: MergeOptions } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, options: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'merge options must be an object' };
  }
  const out: MergeOptions = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const b = OPTION_BOUNDS[key as keyof MergeOptions];
    if (!b) return { ok: false, error: `unknown merge option ${key}` };
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < b.min || value > b.max) {
      return { ok: false, error: `${key} must be a number between ${b.min} and ${b.max}` };
    }
    if (b.int && !Number.isInteger(value)) return { ok: false, error: `${key} must be a whole number` };
    out[key as keyof MergeOptions] = value;
  }
  return { ok: true, options: out };
}

/** What orientation needs to know about a version. */
export interface MergeCandidate {
  id: string;
  status: 'processing' | 'completed' | 'error';
  /** The language the result is in. */
  languageCode: string | null;
  /** `payload.speech_model_used` — the model that actually ran. */
  modelUsed: string | null;
}

export const isEnglish = (code: string | null | undefined): boolean =>
  !!code && code.toLowerCase().startsWith('en');

export type MergeOrientation =
  | { kind: 'merge'; base: string; fill: string }
  /** Do not merge; keep the new run as a helper. `why` goes to the log. */
  | { kind: 'helper'; why: string };

/**
 * Amendment A §2 — a merge-mode run has landed; which way round?
 *
 * By LANGUAGE, not by "which one was active": the English pass is always the
 * base (its word confidence is the signal the merge reads, and its
 * diarization is the skeleton). Auto-detect can land on either language, so
 * both "active is English, run forced `id`" and "active is Indonesian, run
 * `auto-en`" must come out English-base.
 *
 * Exactly one side must be English. Both English or neither: there is no
 * signal to merge on, so the new run is kept as a helper — never shown raw.
 * (Among English candidates the spec prefers one that RAN on 3.5 Pro; with
 * exactly one English side that preference has nothing to choose between,
 * so it only surfaces in the log line.)
 */
export function orientMerge(
  activeAtStart: MergeCandidate | null,
  fresh: MergeCandidate
): MergeOrientation {
  if (!activeAtStart) {
    return { kind: 'helper', why: 'the version active at the start is gone' };
  }
  if (activeAtStart.id === fresh.id) {
    return { kind: 'helper', why: 'the new version was already the active one' };
  }
  if (activeAtStart.status !== 'completed') {
    return { kind: 'helper', why: `the version active at the start is ${activeAtStart.status}` };
  }
  if (fresh.status !== 'completed') {
    return { kind: 'helper', why: `the new version is ${fresh.status}` };
  }
  const a = isEnglish(activeAtStart.languageCode);
  const f = isEnglish(fresh.languageCode);
  if (a && f) {
    return { kind: 'helper', why: 'both versions are English — nothing to fill from' };
  }
  if (!a && !f) {
    return {
      kind: 'helper',
      why:
        `neither version is English (${activeAtStart.languageCode ?? '?'} / ${fresh.languageCode ?? '?'}) — ` +
        'run an auto-en pass to get a base',
    };
  }
  return a
    ? { kind: 'merge', base: activeAtStart.id, fill: fresh.id }
    : { kind: 'merge', base: fresh.id, fill: activeAtStart.id };
}

/**
 * Amendment A §3 — an EXPLICIT merge keeps base/fill exactly as given, but
 * says out loud when they look the wrong way round.
 */
export function mergeWarnings(base: MergeCandidate, fill: MergeCandidate): string[] {
  const w: string[] = [];
  if (!isEnglish(base.languageCode)) w.push('base is not an English version');
  if (isEnglish(fill.languageCode)) w.push('fill is English');
  if (
    base.languageCode &&
    fill.languageCode &&
    base.languageCode.toLowerCase() === fill.languageCode.toLowerCase()
  ) {
    w.push('base and fill are in the same language');
  }
  if (isEnglish(base.languageCode) && base.modelUsed && base.modelUsed !== 'universal-3-5-pro') {
    w.push(`base ran on ${base.modelUsed}, not universal-3-5-pro`);
  }
  return w;
}

/**
 * The diarization "label space" a version lives in. A merged version keeps
 * its base's utterances and speaker letters (§1), so it shares the base's
 * space — and a merge of a merge, the base's base's. Two versions with the
 * same space can show the same confirmed speaker names; any other pair
 * cannot ("A" of one job is not "A" of another).
 *
 * `mergeBaseOf(id)` answers the `requested.merge.base` of a merged version,
 * null for anything else. The walk is capped so a corrupt cycle cannot hang.
 */
export function labelSpaceOf(id: string, mergeBaseOf: (id: string) => string | null): string {
  let cur = id;
  for (let i = 0; i < 16; i++) {
    const next = mergeBaseOf(cur);
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** One utterance of `GET …/transcriptions/:tid/content`. */
export interface ContentUtterance {
  start: number;
  end: number;
  speaker: string;
  text: string;
  merged?: boolean;
}

/**
 * A version's utterances as the content route serves them. `names` (label →
 * confirmed name) is passed ONLY when the version shares the active
 * version's label space; then a confirmed name replaces its label, the same
 * way `darth-cli meetings text` renders it. An empty name is "not named".
 */
export function contentUtterances(
  payload: { utterances?: Array<{ start: number; end: number; speaker: string; text: string; merged?: boolean }> },
  names: Map<string, string> | null
): ContentUtterance[] {
  return (payload.utterances ?? []).map((u) => {
    const named = names?.get(u.speaker)?.trim();
    return {
      start: u.start,
      end: u.end,
      speaker: named || u.speaker,
      text: u.text,
      ...(u.merged ? { merged: true } : {}),
    };
  });
}

/** The models a run may ask for (the submit ids). */
const RUN_SPEECH_MODELS = ['universal', 'universal-3-5-pro'] as const;
/** AssemblyAI language codes are 'en', 'zh', 'en_us' — never free text. */
const LANGUAGE_RE = /^[a-z]{2}(_[a-z]{2})?$/i;

/** A run request body, parsed (POST …/retranscribe and POST /api/recordings/:id/transcribe). */
export interface ParsedRunBody {
  speechModel?: (typeof RUN_SPEECH_MODELS)[number];
  languageCode?: string;
  reason?: string;
  force: boolean;
  mode: TranscriptionRunMode;
  mergeOptions: MergeOptions;
}

/**
 * Lenient where it always was (an unknown model or language reads as "the
 * default" — every caller before Phase 2 posted no body at all), STRICT on
 * the two fields that decide what is shown when the run lands: a bad `mode`
 * or `mergeOptions` is a 400, never a silent 'replace'.
 */
export function parseRunBody(raw: unknown): { ok: true; body: ParsedRunBody } | { ok: false; error: string } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const model = typeof b.speechModel === 'string' ? b.speechModel : null;
  const lang = typeof b.languageCode === 'string' ? b.languageCode.trim() : null;
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : undefined;
  const mode = parseRunMode(b.mode);
  if (!mode.ok) return mode;
  const opts = parseMergeOptions(b.mergeOptions);
  if (!opts.ok) return opts;
  return {
    ok: true,
    body: {
      speechModel: (RUN_SPEECH_MODELS as readonly string[]).includes(model ?? '')
        ? (model as ParsedRunBody['speechModel'])
        : undefined,
      languageCode:
        lang === 'auto' || lang === 'auto-en' || (lang && LANGUAGE_RE.test(lang)) ? lang : undefined,
      reason: reason || undefined,
      force: b.force === true,
      mode: mode.mode,
      mergeOptions: opts.options,
    },
  };
}

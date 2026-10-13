/**
 * Merge two transcriptions of ONE recording into a third — the fix for
 * mixed-language calls (docs/transcription-merge-spec.md §1).
 *
 * AssemblyAI picks one language per file. On an English + Indonesian call the
 * English pass garbles every Indonesian turn into invented Vietnamese / Thai,
 * and a forced-Indonesian pass translates every English turn — each pass is
 * right exactly where the other is wrong. The English pass's OWN word
 * confidence says which is which (0.85–0.98 on English, < 0.75 on the garbled
 * stretches), so the merge keeps the BASE pass as the skeleton and swaps in
 * the FILL pass's words only where the base was unsure.
 *
 * The one property everything downstream leans on: the output has the SAME
 * utterances as the base — same count, order, speaker label, start and end.
 * Utterance edits are keyed by index and speaker names by the base's
 * diarization letters, so both stay valid on the merged version (that is what
 * makes the annotation carry-over in db-ops/transcriptions.ts safe). Only the
 * words, the text and the confidence of a touched utterance change.
 *
 * Pure: no db, no clock, no `server-only`. A port of the offline prototype
 * that produced the numbers in the spec (row 1134: 34 garbled lines → 0) —
 * keep it faithful; the thresholds were tuned on real data.
 */

import type { TranscriptResponse } from '@/lib/format';

export interface MergeOptions {
  /** Whole utterance swapped when its mean word confidence is below this. */
  utteranceThreshold?: number;
  /** Rolling-mean threshold for partial spans. */
  wordThreshold?: number;
  /** Rolling window, in words, centred on the word being judged. */
  window?: number;
  /** A partial span must cover at least this many base words. */
  minRun?: number;
  /** Good islands of at most this many words between bad words are absorbed. */
  island?: number;
}

export interface MergeStats {
  /** Base utterances considered. */
  utterances: number;
  /** Utterances where at least one span was replaced by fill words. */
  utterancesTouched: number;
  /** …of which the whole utterance was swapped. */
  utterancesWhole: number;
  /** Audio time covered by the replaced spans. */
  swappedMs: number;
  /** The base's audio duration (or its last utterance end when it has none). */
  durationMs: number;
  /** Fill words that made it into the output. */
  fillWordsUsed: number;
}

export const DEFAULT_MERGE_OPTIONS: Required<MergeOptions> = {
  utteranceThreshold: 0.75,
  wordThreshold: 0.75,
  window: 6,
  minRun: 6,
  island: 4,
};

/** A word as AssemblyAI returns it, plus where the merge got it from. */
export type MergeWord = NonNullable<TranscriptResponse['words']>[number] & {
  /** 'fill' on words that came from the fill pass; absent on base words. */
  source?: 'fill';
};

/** An utterance with its words — AAI sends them; the shared TS type omits them. */
export type MergeUtterance = NonNullable<TranscriptResponse['utterances']>[number] & {
  words?: MergeWord[];
  confidence?: number;
  /** True on utterances the merge rewrote. */
  merged?: boolean;
};

/** The merge's own record on the payload; the ids are filled in by the caller. */
export interface PayloadMergeInfo {
  baseTranscriptionId: string | null;
  fillTranscriptionId: string | null;
  fillLanguage: string | null;
  options: Required<MergeOptions>;
  stats: MergeStats;
}

export type MergedTranscript = TranscriptResponse & {
  utterances?: MergeUtterance[];
  words?: MergeWord[];
  merge?: PayloadMergeInfo;
};

/** Options with the defaults filled in. Unknown / non-finite values fall back. */
export function resolveMergeOptions(opts?: MergeOptions): Required<MergeOptions> {
  const pick = (v: number | undefined, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : d;
  return {
    utteranceThreshold: pick(opts?.utteranceThreshold, DEFAULT_MERGE_OPTIONS.utteranceThreshold),
    wordThreshold: pick(opts?.wordThreshold, DEFAULT_MERGE_OPTIONS.wordThreshold),
    window: Math.max(1, Math.round(pick(opts?.window, DEFAULT_MERGE_OPTIONS.window))),
    minRun: Math.max(1, Math.round(pick(opts?.minRun, DEFAULT_MERGE_OPTIONS.minRun))),
    island: Math.max(0, Math.round(pick(opts?.island, DEFAULT_MERGE_OPTIONS.island))),
  };
}

const conf = (w: { confidence?: number }) =>
  typeof w.confidence === 'number' && Number.isFinite(w.confidence) ? w.confidence : 0;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Mean confidence over the window centred on word `i`: `[i - ⌊w/2⌋,
 * i - ⌊w/2⌋ + w)`, clipped to the utterance. Clipping (rather than padding)
 * means the first and last words are judged on the neighbours they really
 * have.
 */
export function rollingMean(words: Array<{ confidence?: number }>, i: number, window: number): number {
  const lo = Math.max(0, i - Math.floor(window / 2));
  const hi = Math.min(words.length, i - Math.floor(window / 2) + window);
  const slice: number[] = [];
  for (let k = lo; k < hi; k++) slice.push(conf(words[k]!));
  return mean(slice);
}

/**
 * A run of good words no longer than `island`, with bad words on BOTH sides,
 * becomes bad: a garbled stretch where the recogniser happened to be confident
 * about two short words ("ok", "ya") is still one garbled stretch, and leaving
 * those words in place would split it into runs too short to swap.
 */
export function absorbIslands(bad: boolean[], island: number): boolean[] {
  const out = [...bad];
  let i = 0;
  while (i < out.length) {
    if (out[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !out[j]) j++;
    // [i, j) is a good run. Absorb it only when it is bounded on both sides.
    if (i > 0 && j < out.length && j - i <= island) {
      for (let k = i; k < j; k++) out[k] = true;
    }
    i = j;
  }
  return out;
}

/** Half-open index ranges `[i, j)` of consecutive bad words at least `minRun` long. */
export function badRuns(bad: boolean[], minRun: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < bad.length) {
    if (!bad[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < bad.length && bad[j]) j++;
    if (j - i >= minRun) runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** One span of an utterance to replace: base word indices and the time window. */
interface Span {
  /** Base word indices `[from, to)`. */
  from: number;
  to: number;
  /** Time window `[lo, hi)` in ms that fill words are matched against. */
  lo: number;
  hi: number;
  whole: boolean;
}

function spansOf(u: MergeUtterance, o: Required<MergeOptions>): Span[] {
  const ws = u.words ?? [];
  const n = ws.length;
  if (n === 0) return [];
  if (mean(ws.map(conf)) < o.utteranceThreshold) {
    return [{ from: 0, to: n, lo: u.start, hi: u.end, whole: true }];
  }
  const bad = absorbIslands(
    ws.map((_, i) => rollingMean(ws, i, o.window) < o.wordThreshold),
    o.island
  );
  // A span runs from its first bad word's start to the NEXT word's start —
  // so the gap after the last bad word belongs to the span, and a fill word
  // spoken in it is not lost. At the utterance edges the utterance's own
  // bounds stand in.
  return badRuns(bad, o.minRun).map(([i, j]) => ({
    from: i,
    to: j,
    lo: i === 0 ? u.start : ws[i]!.start,
    hi: j === n ? u.end : ws[j]!.start,
    whole: false,
  }));
}

/** Every word of a payload in time order: top-level `words`, else the utterances'. */
function allWords(p: TranscriptResponse): MergeWord[] {
  const top = (p.words ?? []) as MergeWord[];
  if (top.length > 0) return top;
  return ((p.utterances ?? []) as MergeUtterance[]).flatMap((u) => u.words ?? []);
}

const mid = (w: { start: number; end: number }) => (w.start + w.end) / 2;

/**
 * Merge `fill` into `base`. Returns a NEW payload (the inputs are not
 * touched) and what was done.
 *
 * Conservative by construction: a span with no fill words in it keeps the
 * base words — a garbled line is better than a blank one — and an utterance
 * the base was sure about is never touched at all.
 */
export function mergeTranscripts(
  base: TranscriptResponse,
  fill: TranscriptResponse,
  opts?: MergeOptions
): { payload: MergedTranscript; stats: MergeStats } {
  const o = resolveMergeOptions(opts);
  // structuredClone: a deep copy, so the stored base payload is never
  // mutated in memory under another reader.
  const payload = structuredClone(base) as MergedTranscript;
  const utterances = (payload.utterances ?? []) as MergeUtterance[];

  // Fill words sorted by midpoint, each usable ONCE. Midpoint assignment
  // already puts a word in at most one half-open span; the `used` set is the
  // belt to that braces for utterances that overlap in time.
  const fillWords = [...allWords(fill)].sort((a, b) => mid(a) - mid(b));
  const used = new Set<number>();

  const lastEnd = utterances.reduce((m, u) => Math.max(m, u.end ?? 0), 0);
  const stats: MergeStats = {
    utterances: utterances.length,
    utterancesTouched: 0,
    utterancesWhole: 0,
    swappedMs: 0,
    durationMs:
      typeof base.audio_duration === 'number' && base.audio_duration > 0
        ? Math.round(base.audio_duration * 1000)
        : lastEnd,
    fillWordsUsed: 0,
  };

  for (const u of utterances) {
    const ws = u.words ?? [];
    const spans = spansOf(u, o);
    if (spans.length === 0) continue;

    // Rebuild the word list span by span, left to right.
    const out: MergeWord[] = [];
    let cursor = 0;
    let touched = false;
    let whole = false;
    for (const span of spans) {
      for (let k = cursor; k < span.from; k++) out.push(ws[k]!);
      const picked: MergeWord[] = [];
      for (let f = 0; f < fillWords.length; f++) {
        if (used.has(f)) continue;
        const m = mid(fillWords[f]!);
        if (m < span.lo) continue;
        if (m >= span.hi) break;
        used.add(f);
        picked.push({ ...fillWords[f]!, speaker: u.speaker, source: 'fill' });
      }
      if (picked.length === 0) {
        // Nothing heard there by the fill pass — keep what the base had.
        for (let k = span.from; k < span.to; k++) out.push(ws[k]!);
      } else {
        out.push(...picked);
        touched = true;
        whole = whole || span.whole;
        stats.swappedMs += Math.max(0, span.hi - span.lo);
        stats.fillWordsUsed += picked.length;
      }
      cursor = span.to;
    }
    for (let k = cursor; k < ws.length; k++) out.push(ws[k]!);

    if (!touched) continue;
    u.words = out;
    u.text = out.map((w) => w.text).join(' ');
    u.confidence = mean(out.map(conf));
    u.merged = true;
    stats.utterancesTouched++;
    if (whole) stats.utterancesWhole++;
  }

  // Top-level fields follow the utterances — but only when something moved,
  // so a merge that changed nothing is byte-for-byte the base (plus `merge`).
  if (stats.utterancesTouched > 0) {
    const words = utterances.flatMap((u) => u.words ?? []);
    payload.words = words;
    payload.text = utterances.map((u) => u.text).join(' ');
    payload.confidence = mean(words.map(conf));
  }

  payload.merge = {
    baseTranscriptionId: null,
    fillTranscriptionId: null,
    fillLanguage: fill.language_code ?? null,
    options: o,
    stats,
  };
  return { payload, stats };
}

/** One touched utterance, before and after — the dry-run preview. */
export interface MergePreviewLine {
  start: number;
  speaker: string;
  before: string;
  after: string;
}

/**
 * The touched utterances side by side, at most `max`, texts truncated to
 * `maxChars`. Indices line up by construction (§1), so `before` is simply the
 * base utterance at the same index.
 */
export function mergePreview(
  base: TranscriptResponse,
  merged: MergedTranscript,
  max = 40,
  maxChars = 300
): MergePreviewLine[] {
  const cut = (s: string) => (s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s);
  const before = base.utterances ?? [];
  const out: MergePreviewLine[] = [];
  for (const [i, u] of ((merged.utterances ?? []) as MergeUtterance[]).entries()) {
    if (!u.merged) continue;
    out.push({
      start: u.start,
      speaker: u.speaker,
      before: cut(before[i]?.text ?? ''),
      after: cut(u.text ?? ''),
    });
    if (out.length >= max) break;
  }
  return out;
}

import type { MeetUtterance } from '@/lib/format';
import { windowDensity, type AlignmentVote } from '@/lib/meet-align-vote';

/**
 * The pooled-room rule's release valve: ask the AUDIO whether one Meet name
 * really has two voices behind it.
 *
 * ## What it is for
 *
 * `lib/server/meet-align.ts` drops every suggestion of a Meet name that
 * decisively wins two or more diarized labels: Meet attributes per DEVICE, so
 * that shape is what a meeting-room mic looks like, and naming all of those
 * speakers after the device's owner would be wrong. The rule infers "two
 * voices" from the alignment alone, which is the weakest possible evidence —
 * and it costs real coverage (measured 2026-09-22: 48 labels dropped, of the
 * 23 with a confirmed name 9 would have been RIGHT).
 *
 * The shared-mic eval (docs/eval-shared-mic-2026-09-21.md) answers the same
 * question from audio: cut 8 x 5 s snippets of that name's own DENSE caption
 * windows, embed them with the ECAPA sidecar, and take `split` — the cosine
 * between the two best cluster centroids. `split >= 0.45` is one voice
 * (held out: precision 0.89 / recall 0.80 per participant, ~1.2 s of CPU).
 *
 * So: the rule fires, the valve checks, and only a confident "one voice"
 * keeps the winning suggestion. Anything else — no media, a shifted
 * timeline, too little dense speech, a sidecar the check cannot see — drops
 * exactly as today. **Silence is never read as "single voice."**
 *
 * ## The measured verdict
 *
 * On the same 46 prod rows it does NOT pay (docs/eval-meet-align-voice-valve-
 * 2026-09-22.md): 17 of the 19 pooled groups are checkable, 15 of them score
 * `split < 0.45` — the rooms really are shared — and at 0.45 the valve rescues
 * one name that the owner's own labels say is WRONG and none that are right.
 * It ships behind `MW_MEET_ALIGN_VOICE_VALVE`, default OFF, because the
 * mechanism is sound and cheap and the corpus is small (9 right / 14 wrong
 * labels in total); re-run the eval before turning it on.
 *
 * This module is pure and dependency-free (no `server-only`): planning, the
 * split statistic and the verdict are all testable without a sidecar, and
 * `runVoiceValve` takes the embedder as an argument.
 *
 * PRIVACY: everything here is times and numbers. Snippets are AUDIO ONLY —
 * the sidecar's `/embed-batch` passes `-vn` — and nothing is ever enrolled:
 * the embeddings are compared to each other inside one meeting and thrown
 * away.
 */

/** A window must be at least this full of its speaker to be worth cutting
 * audio from — the shared-mic eval's hard "dense entry" cut. */
export const DENSE_MIN_DENSITY_CHARS_PER_S = 12;

/** ... and long enough to hold a snippet with room on both sides. */
export const DENSE_MIN_SPAN_MS = 3000;

/** A name with less dense speech than this gets NO verdict (eval §3). */
export const MIN_DENSE_WINDOWS = 4;
export const MIN_DENSE_MS = 60_000;

/** L = 5 s, K = 8: the eval's operating point. */
export const SNIPPET_MS = 5000;
export const MAX_SNIPPETS = 8;

/** Never cut across a window's edges — caption windows start and end mid-turn. */
export const SNIPPET_EDGE_MS = 400;

/** `split` needs two snippets on each side to mean anything. Fewer embeddings
 * than this come back → "no opinion" → drop, as today. */
export const MIN_SNIPPETS_FOR_OPINION = 4;

/** `split` at or above this is ONE voice, so the pooled-room rule was a false
 * alarm. Below it (or no opinion) the drop stands. */
export const SINGLE_VOICE_SPLIT = 0.45;

/** Budget: at most this many checks per meeting per pass (~1.2 s CPU each). */
export const MAX_CHECKS_PER_MEETING = 3;

/** Below this share of Meet window time landing on ANY diarized speech the
 * two transcripts are not on one timeline and nothing here can be trusted
 * (eval §6, row 914). */
export const MIN_TIMELINE_ALIGNMENT = 0.5;

/** One Meet name and the diarized labels the pooled-room rule just dropped. */
export interface PooledGroup {
  name: string;
  entries: Array<{ speaker: string; vote: AlignmentVote }>;
}

export interface ValveContext {
  meetUtterances: MeetUtterance[];
  aaiUtterances: Array<{ speaker: string; start: number; end: number }>;
  /** There is a local file to cut snippets from. */
  hasLocalMedia: boolean;
  /** `combinedParts` / `videoParts` / a re-cut upload: the sidecar and the
   * media are on different timelines, so a snippet cut at a Meet window's ms
   * is not that window's audio. */
  timelineShifted: boolean;
}

export type ValveSkipReason =
  | 'no-media'
  | 'timeline-shift'
  | 'misaligned'
  | 'not-dense'
  | 'too-few-snippets'
  | 'cap';

export interface ValveCandidate {
  name: string;
  /** The label that keeps the name if the check says one voice: the one
   * holding the most density-weighted time under it. */
  winner: string;
  winnerVote: AlignmentVote;
  denseWindows: number;
  denseMs: number;
  /** MEETING-time snippets; the caller maps them into its file. */
  snippets: Array<{ startMs: number; endMs: number }>;
}

export interface ValvePlan {
  candidates: ValveCandidate[];
  skipped: Array<{ name: string; reason: ValveSkipReason }>;
  /** Share of Meet window time that lands on any diarized speech. */
  alignment: number;
}

export type ValveVerdict = 'single-voice' | 'more-than-one-voice' | 'no-opinion';

export interface ValveCheck {
  candidate: ValveCandidate;
  split: number | null;
  embeddings: number;
  verdict: ValveVerdict;
}

type Window = [number, number];

function merge(windows: Window[]): Window[] {
  const out: Window[] = [];
  for (const [s, e] of [...windows].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function totalMs(windows: Window[]): number {
  return windows.reduce((sum, [s, e]) => sum + (e - s), 0);
}

function overlapMs(a: Window[], b: Window[]): number {
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i]![0], b[j]![0]);
    const e = Math.min(a[i]![1], b[j]![1]);
    if (e > s) total += e - s;
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return total;
}

/**
 * How much of the sidecar's time lands on diarized speech at all. A row whose
 * Meet transcript sits on another timeline scores near zero here, and every
 * window the valve would cut would be the wrong audio.
 */
export function timelineAlignment(
  aaiUtterances: Array<{ start: number; end: number }>,
  meetUtterances: MeetUtterance[]
): number {
  const meet = merge(meetUtterances.filter((m) => m.end > m.start).map((m): Window => [m.start, m.end]));
  if (meet.length === 0) return 0;
  const aai = merge(aaiUtterances.filter((u) => u.end > u.start).map((u): Window => [u.start, u.end]));
  return overlapMs(meet, aai) / Math.max(totalMs(meet), 1);
}

/**
 * The windows of one Meet name that are that person talking almost
 * continuously — long enough and full enough (the eval's hard cut, on the
 * same density `meet-align-vote.ts` weights with). Merged, so two adjacent
 * caption flushes are one stretch of audio.
 */
export function denseWindowsFor(meetUtterances: MeetUtterance[], name: string): Window[] {
  const windows: Window[] = [];
  for (const m of meetUtterances) {
    if (m.speaker !== name) continue;
    const span = m.end - m.start;
    if (span < DENSE_MIN_SPAN_MS) continue;
    if (windowDensity(span, m.text.length) < DENSE_MIN_DENSITY_CHARS_PER_S) continue;
    windows.push([m.start, m.end]);
  }
  return merge(windows);
}

/**
 * Up to `k` windows SPREAD ACROSS the meeting: bin the timeline into k
 * slices and take the longest window in each, then top up with the longest
 * remaining. A room where one person holds the first half and another the
 * second is only caught when the snippets are spread out — taking the k
 * longest windows would sample one speaker.
 *
 * Ported from `tmp/shared-mic-eval/embed_eval.py:pick_windows` so the
 * production check samples the same audio the eval measured.
 */
export function pickSnippetWindows(windows: Window[], k: number, needMs: number): Window[] {
  const roomy = windows.filter(([s, e]) => e - s >= needMs + 2 * SNIPPET_EDGE_MS);
  const ok = roomy.length > 0 ? roomy : windows.filter(([s, e]) => e - s >= needMs);
  if (ok.length <= k) return ok;
  const lo = ok[0]![0];
  const hi = ok[ok.length - 1]![1];
  const span = Math.max(hi - lo, 1);
  const chosen: Window[] = [];
  const used = new Set<number>();
  for (let i = 0; i < k; i++) {
    const b0 = lo + (span * i) / k;
    const b1 = lo + (span * (i + 1)) / k;
    let pick = -1;
    for (let j = 0; j < ok.length; j++) {
      if (used.has(j)) continue;
      const w = ok[j]!;
      if (w[0] < b0 || w[0] >= b1) continue;
      if (pick < 0 || w[1] - w[0] > ok[pick]![1] - ok[pick]![0]) pick = j;
    }
    if (pick >= 0) {
      used.add(pick);
      chosen.push(ok[pick]!);
    }
  }
  const byLength = ok
    .map((w, j) => ({ w, j }))
    .sort((a, b) => b.w[1] - b.w[0] - (a.w[1] - a.w[0]));
  for (const { w, j } of byLength) {
    if (chosen.length >= k) break;
    if (used.has(j)) continue;
    used.add(j);
    chosen.push(w);
  }
  return chosen.sort((a, b) => a[0] - b[0]);
}

/** The middle `SNIPPET_MS` of each picked window, kept off its edges. */
export function snippetsFor(windows: Window[]): Array<{ startMs: number; endMs: number }> {
  return pickSnippetWindows(windows, MAX_SNIPPETS, SNIPPET_MS).map(([s, e]) => {
    const mid = Math.floor((s + e) / 2);
    const start = Math.max(
      0,
      Math.max(s + SNIPPET_EDGE_MS, Math.min(mid - SNIPPET_MS / 2, e - SNIPPET_EDGE_MS - SNIPPET_MS))
    );
    return { startMs: Math.round(start), endMs: Math.round(start) + SNIPPET_MS };
  });
}

/**
 * Which pooled names the valve will spend CPU on, and why it will not spend
 * it on the others. Ordered by dense speech (most first), capped at
 * `MAX_CHECKS_PER_MEETING`.
 */
export function planValveChecks(groups: PooledGroup[], ctx: ValveContext): ValvePlan {
  const alignment = timelineAlignment(ctx.aaiUtterances, ctx.meetUtterances);
  const skipped: Array<{ name: string; reason: ValveSkipReason }> = [];
  const blanket: ValveSkipReason | null = !ctx.hasLocalMedia
    ? 'no-media'
    : ctx.timelineShifted
      ? 'timeline-shift'
      : alignment < MIN_TIMELINE_ALIGNMENT
        ? 'misaligned'
        : null;
  if (blanket) {
    return { candidates: [], skipped: groups.map((g) => ({ name: g.name, reason: blanket })), alignment };
  }

  const eligible: ValveCandidate[] = [];
  for (const group of groups) {
    const windows = denseWindowsFor(ctx.meetUtterances, group.name);
    if (windows.length < MIN_DENSE_WINDOWS || totalMs(windows) < MIN_DENSE_MS) {
      skipped.push({ name: group.name, reason: 'not-dense' });
      continue;
    }
    const snippets = snippetsFor(windows);
    if (snippets.length < MIN_SNIPPETS_FOR_OPINION) {
      skipped.push({ name: group.name, reason: 'too-few-snippets' });
      continue;
    }
    const winner = [...group.entries].sort((a, b) => b.vote.overlapMs - a.vote.overlapMs)[0];
    if (!winner) continue;
    eligible.push({
      name: group.name,
      winner: winner.speaker,
      winnerVote: winner.vote,
      denseWindows: windows.length,
      denseMs: totalMs(windows),
      snippets,
    });
  }

  eligible.sort((a, b) => b.denseMs - a.denseMs);
  const candidates = eligible.slice(0, MAX_CHECKS_PER_MEETING);
  for (const over of eligible.slice(MAX_CHECKS_PER_MEETING)) {
    skipped.push({ name: over.name, reason: 'cap' });
  }
  return { candidates, skipped, alignment };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm > 0 ? dot / norm : 0;
}

function centroid(vectors: number[][]): number[] {
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] = sum[i]! + (v[i] ?? 0);
  return sum.map((x) => x / vectors.length);
}

/**
 * `split`: the LOWEST cosine any 2-way partition of these snippets achieves
 * between its cluster centroids, with at least two snippets per side. Low =
 * the snippets disagree with each other = more than one voice.
 *
 * Exactly `tmp/shared-mic-eval/analyse.py:stats_for` — including its
 * small-n fallback to the minimum pairwise cosine, and its enumeration of
 * every partition (at most 8 snippets, so 127 masks).
 *
 * null when there is not even a pair to compare.
 */
export function splitScore(embeddings: number[][]): number | null {
  const n = embeddings.length;
  if (n < 2) return null;
  let minPair = 1;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      minPair = Math.min(minPair, cosine(embeddings[i]!, embeddings[j]!));
    }
  }
  if (n < 4) return minPair;
  let best = 1;
  for (let mask = 1; mask < 1 << (n - 1); mask++) {
    const a: number[][] = [];
    const b: number[][] = [];
    for (let i = 0; i < n; i++) {
      // The last snippet is pinned to side B so each partition is seen once.
      if (i < n - 1 && (mask >> i) & 1) a.push(embeddings[i]!);
      else b.push(embeddings[i]!);
    }
    if (a.length < 2 || b.length < 2) continue;
    best = Math.min(best, cosine(centroid(a), centroid(b)));
  }
  return best;
}

export function verdictFor(split: number | null, embeddings: number): ValveVerdict {
  if (split === null || embeddings < MIN_SNIPPETS_FOR_OPINION) return 'no-opinion';
  return split >= SINGLE_VOICE_SPLIT ? 'single-voice' : 'more-than-one-voice';
}

/**
 * Run the planned checks, one at a time (the sidecar is single-threaded and
 * this is fire-and-forget work). `embed` gets one candidate's snippets and
 * returns one L2-normalised embedding per snippet it managed to cut; an empty
 * array or a throw is "no opinion", never "one voice".
 */
export async function runVoiceValve(
  plan: ValvePlan,
  embed: (candidate: ValveCandidate) => Promise<number[][]>,
  onCheck?: (check: ValveCheck) => void
): Promise<ValveCheck[]> {
  const checks: ValveCheck[] = [];
  for (const candidate of plan.candidates) {
    let embeddings: number[][] = [];
    try {
      embeddings = await embed(candidate);
    } catch {
      embeddings = [];
    }
    const split = embeddings.length >= MIN_SNIPPETS_FOR_OPINION ? splitScore(embeddings) : null;
    const check: ValveCheck = {
      candidate,
      split,
      embeddings: embeddings.length,
      verdict: verdictFor(split, embeddings.length),
    };
    checks.push(check);
    onCheck?.(check);
  }
  return checks;
}

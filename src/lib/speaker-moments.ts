/**
 * WHEN each diarized speaker is talking — the timestamps the speaker-ID pass
 * grabs video frames at. Pure, client-safe.
 *
 * Why (2026-09-25, transcript 980, a 48-min Teams call recorded with video):
 * the pass ran 22 s, named 2 of 5 voices, and never had a reason to look at
 * the moments that answer the question. Teams and Meet both highlight the
 * ACTIVE speaker's tile (Teams draws a coloured border and names every tile),
 * so a frame taken a few seconds into a long utterance of voice B shows whose
 * tile is lit while B talks. Several such frames spread across the meeting
 * that agree on one name bind the voice to the person — the one thing a
 * roster alone cannot do.
 */

export interface MomentUtterance {
  start: number;
  end: number;
  speaker: string;
}

export interface SpeakingMoments {
  /** Meeting-time ms to look at, chronological. */
  moments: number[];
  /** Total speech of this speaker, ms. */
  talkMs: number;
  lines: number;
}

/** Utterances shorter than this rarely hold a highlight long enough to catch. */
export const MOMENT_MIN_UTTERANCE_MS = 2500;
/** How far into an utterance to look: past the highlight's onset lag, well before it ends. */
export const MOMENT_OFFSET_MS = 3000;
/** Two moments closer than this mostly show the same screen. */
export const MOMENT_MIN_GAP_MS = 60_000;

/**
 * Up to `count` moments for `speaker`: the longest qualifying utterance in
 * each of `count` equal slices of the meeting (so a screen share or a layout
 * change in one part does not decide everything), topped up with the next
 * longest ones at least a minute from those already picked. A speaker with
 * no utterance ≥ 2.5 s gets their single longest one, whatever its length.
 * Each moment is 3 s into its utterance (or its middle, when shorter than 6 s).
 */
export function speakingMoments(
  utterances: readonly MomentUtterance[],
  speaker: string,
  count = 4
): SpeakingMoments {
  const mine = utterances.filter((u) => u.speaker === speaker && u.end > u.start);
  const talkMs = mine.reduce((s, u) => s + (u.end - u.start), 0);
  if (mine.length === 0 || count <= 0) return { moments: [], talkMs, lines: mine.length };

  const dur = (u: MomentUtterance) => u.end - u.start;
  let pool = mine.filter((u) => dur(u) >= MOMENT_MIN_UTTERANCE_MS);
  if (pool.length === 0) pool = [[...mine].sort((a, b) => dur(b) - dur(a))[0]!];

  const t0 = Math.min(...utterances.map((u) => u.start));
  const t1 = Math.max(...utterances.map((u) => u.end));
  const span = Math.max(1, t1 - t0);
  const picked: MomentUtterance[] = [];
  const farEnough = (u: MomentUtterance) =>
    picked.every((p) => Math.abs(p.start - u.start) >= MOMENT_MIN_GAP_MS);

  for (let i = 0; i < count; i++) {
    const lo = t0 + (span * i) / count;
    const hi = t0 + (span * (i + 1)) / count;
    const inSlice = pool
      .filter((u) => u.start >= lo && u.start < hi && farEnough(u))
      .sort((a, b) => dur(b) - dur(a));
    if (inSlice[0]) picked.push(inSlice[0]);
  }
  for (const u of [...pool].sort((a, b) => dur(b) - dur(a))) {
    if (picked.length >= count) break;
    if (!picked.includes(u) && farEnough(u)) picked.push(u);
  }

  const moments = picked
    .map((u) => Math.round(u.start + Math.min(MOMENT_OFFSET_MS, dur(u) / 2)))
    .sort((a, b) => a - b);
  return { moments, talkMs, lines: mine.length };
}

/** "12:46" for prompt text. */
export function clockOf(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

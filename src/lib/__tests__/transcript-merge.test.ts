import { describe, expect, test } from 'bun:test';
import {
  absorbIslands,
  badRuns,
  mergePreview,
  mergeTranscripts,
  rollingMean,
  type MergeUtterance,
} from '@/lib/transcript-merge';
import type { TranscriptResponse } from '@/lib/format';

/**
 * The pure merge (docs/transcription-merge-spec.md §1). SYNTHETIC fixtures
 * only — invented words on an invented timeline; no customer text belongs in
 * this repo. Every word is 300 ms long and words follow each other with no
 * gap, so a span's time window is easy to read off an index.
 */

const WORD_MS = 300;

interface W {
  text: string;
  conf: number;
}

/** An utterance of `words` starting at `startMs`. */
function utt(speaker: string, startMs: number, words: W[]): MergeUtterance {
  const ws = words.map((w, i) => ({
    text: w.text,
    start: startMs + i * WORD_MS,
    end: startMs + (i + 1) * WORD_MS,
    confidence: w.conf,
    speaker,
  }));
  return {
    speaker,
    start: startMs,
    end: startMs + words.length * WORD_MS,
    text: ws.map((w) => w.text).join(' '),
    words: ws,
    confidence: ws.reduce((a, w) => a + w.confidence, 0) / Math.max(1, ws.length),
  };
}

const good = (n: number, prefix = 'en'): W[] =>
  Array.from({ length: n }, (_, i) => ({ text: `${prefix}${i}`, conf: 0.95 }));

function payload(utterances: MergeUtterance[], extra: Partial<TranscriptResponse> = {}): TranscriptResponse {
  const words = utterances.flatMap((u) => u.words ?? []);
  return {
    id: 'job-synthetic',
    status: 'completed',
    created: '2026-10-13T00:00:00Z',
    language_code: 'en',
    speech_model_used: 'universal-3-5-pro',
    utterances,
    words,
    text: utterances.map((u) => u.text).join(' '),
    confidence: words.reduce((a, w) => a + w.confidence, 0) / Math.max(1, words.length),
    audio_duration: 60,
    ...extra,
  } as TranscriptResponse;
}

/** A fill pass: contiguous `fill<i>` words over [startMs, endMs), one speaker letter of its own. */
function fillOver(startMs: number, endMs: number, prefix = 'id'): MergeUtterance {
  const n = Math.floor((endMs - startMs) / WORD_MS);
  return utt('Z', startMs, Array.from({ length: n }, (_, i) => ({ text: `${prefix}${i}`, conf: 0.9 })));
}

const utterancesOf = (p: TranscriptResponse) => (p.utterances ?? []) as MergeUtterance[];

describe('helpers', () => {
  test('rollingMean is centred and clipped at the edges', () => {
    const ws = [1, 1, 1, 0, 0, 0, 1, 1].map((c) => ({ confidence: c }));
    // window 6 at i=3 covers 0..5 → 3/6
    expect(rollingMean(ws, 3, 6)).toBeCloseTo(0.5);
    // at i=0 only 0..2 exist → all 1
    expect(rollingMean(ws, 0, 6)).toBeCloseTo(1);
  });

  test('absorbIslands only absorbs short good runs bounded by bad on BOTH sides', () => {
    const T = true;
    const F = false;
    expect(absorbIslands([T, F, F, T], 4)).toEqual([T, T, T, T]);
    // too long an island stays good
    expect(absorbIslands([T, F, F, F, F, F, T], 4)).toEqual([T, F, F, F, F, F, T]);
    // a good run at the edge is not bounded on both sides
    expect(absorbIslands([F, F, T, T], 4)).toEqual([F, F, T, T]);
  });

  test('badRuns keeps runs of at least minRun', () => {
    expect(badRuns([true, true, false, true, true, true], 3)).toEqual([[3, 6]]);
  });
});

describe('mergeTranscripts', () => {
  test('confident English is left untouched — byte for byte apart from the merge record', () => {
    const base = payload([utt('A', 0, good(10)), utt('B', 3000, good(8))]);
    const fill = payload([fillOver(0, 5400)], { language_code: 'id' });
    const { payload: out, stats } = mergeTranscripts(base, fill);
    expect(stats.utterancesTouched).toBe(0);
    const { merge, ...rest } = out;
    expect(rest).toEqual(base);
    expect(merge?.fillLanguage).toBe('id');
    expect(merge?.baseTranscriptionId).toBeNull();
  });

  test('a garbled utterance (mean 0.5) is swapped whole for the fill words in its window', () => {
    const garbled: W[] = Array.from({ length: 8 }, (_, i) => ({ text: `xx${i}`, conf: 0.5 }));
    const base = payload([utt('A', 0, good(10)), utt('B', 3000, garbled), utt('A', 5400, good(5))]);
    const fill = payload([fillOver(0, 7000)], { language_code: 'id' });
    const { payload: out, stats } = mergeTranscripts(base, fill);
    const u = utterancesOf(out);

    expect(stats.utterancesTouched).toBe(1);
    expect(stats.utterancesWhole).toBe(1);
    expect(u[1]!.merged).toBe(true);
    // Fill words whose midpoint is in [3000, 5400): 8 of them (id10..id17).
    expect(u[1]!.words!.map((w) => w.text)).toEqual(
      Array.from({ length: 8 }, (_, i) => `id${10 + i}`)
    );
    expect(u[1]!.words!.every((w) => w.source === 'fill' && w.speaker === 'B')).toBe(true);
    expect(u[1]!.text).toBe(u[1]!.words!.map((w) => w.text).join(' '));
    expect(u[1]!.confidence).toBeCloseTo(0.9);
    expect(stats.swappedMs).toBe(2400);
    expect(stats.fillWordsUsed).toBe(8);
    // Neighbours untouched.
    expect(u[0]!.merged).toBeUndefined();
    expect(u[2]!.text).toBe(base.utterances![2]!.text);
  });

  test('a 7-word low run inside a confident utterance is a PARTIAL swap', () => {
    const words: W[] = [
      ...good(10),
      ...Array.from({ length: 7 }, (_, i) => ({ text: `xx${i}`, conf: 0.4 })),
      ...good(10, 'tail'),
    ];
    const base = payload([utt('A', 0, words)]);
    const fill = payload([fillOver(0, 27 * WORD_MS)], { language_code: 'id' });
    const { payload: out, stats } = mergeTranscripts(base, fill);
    const ws = utterancesOf(out)[0]!.words!;

    expect(stats.utterancesTouched).toBe(1);
    expect(stats.utterancesWhole).toBe(0);
    // The English head and tail survive; the garbled middle is gone.
    expect(ws.slice(0, 5).map((w) => w.text)).toEqual(['en0', 'en1', 'en2', 'en3', 'en4']);
    expect(ws.at(-1)!.text).toBe('tail9');
    expect(ws.some((w) => w.text.startsWith('xx'))).toBe(false);
    expect(ws.filter((w) => w.source === 'fill').length).toBe(stats.fillWordsUsed);
    expect(stats.fillWordsUsed).toBeGreaterThanOrEqual(7);
  });

  test('a 2-word dip is NOT swapped (shorter than minRun)', () => {
    const words: W[] = [...good(10), { text: 'dip0', conf: 0.4 }, { text: 'dip1', conf: 0.4 }, ...good(10, 'tail')];
    const base = payload([utt('A', 0, words)]);
    const fill = payload([fillOver(0, 22 * WORD_MS)], { language_code: 'id' });
    const { stats, payload: out } = mergeTranscripts(base, fill);
    expect(stats.utterancesTouched).toBe(0);
    expect(utterancesOf(out)[0]!.text).toBe(base.utterances![0]!.text);
  });

  test('a short confident island between two bad stretches is absorbed into one span', () => {
    // bad(5) good(3) bad(5): each bad run alone is < minRun 6 at a strict
    // window of 1; the island joins them into one 13-word span.
    const words: W[] = [
      ...good(6),
      ...Array.from({ length: 5 }, (_, i) => ({ text: `xa${i}`, conf: 0.1 })),
      { text: 'ok0', conf: 0.99 },
      { text: 'ok1', conf: 0.99 },
      { text: 'ok2', conf: 0.99 },
      ...Array.from({ length: 5 }, (_, i) => ({ text: `xb${i}`, conf: 0.1 })),
      ...good(6, 'tail'),
    ];
    const base = payload([utt('A', 0, words)]);
    const fill = payload([fillOver(0, words.length * WORD_MS)], { language_code: 'id' });
    const opts = { window: 1, utteranceThreshold: 0 };
    const { payload: out, stats } = mergeTranscripts(base, fill, opts);
    const ws = utterancesOf(out)[0]!.words!;
    expect(stats.utterancesTouched).toBe(1);
    // The island words are replaced too: one contiguous fill stretch.
    expect(ws.some((w) => w.text.startsWith('ok'))).toBe(false);
    expect(ws.filter((w) => w.source === 'fill').map((w) => w.text)).toEqual(
      Array.from({ length: 13 }, (_, i) => `id${6 + i}`)
    );
    // Without the island rule nothing qualifies.
    const strict = mergeTranscripts(base, fill, { ...opts, island: 0 });
    expect(strict.stats.utterancesTouched).toBe(0);
  });

  test('an empty fill window keeps the base words (never blanks a line)', () => {
    const garbled: W[] = Array.from({ length: 8 }, (_, i) => ({ text: `xx${i}`, conf: 0.3 }));
    const base = payload([utt('A', 0, garbled)]);
    const fill = payload([fillOver(10_000, 12_000)], { language_code: 'id' });
    const { payload: out, stats } = mergeTranscripts(base, fill);
    expect(stats.utterancesTouched).toBe(0);
    expect(utterancesOf(out)[0]!.text).toBe(base.utterances![0]!.text);
  });

  test('a fill word on the boundary of two swapped utterances lands in exactly one', () => {
    const garbled = (p: string): W[] => Array.from({ length: 4 }, (_, i) => ({ text: `${p}${i}`, conf: 0.2 }));
    const base = payload([utt('A', 0, garbled('a')), utt('B', 1200, garbled('b'))]);
    // Fill words straddle the 1200 ms boundary: one runs 1050..1350 (mid 1200).
    const fill = payload([
      {
        speaker: 'Z',
        start: 0,
        end: 2400,
        text: '',
        words: [
          { text: 'f0', start: 0, end: 600, confidence: 0.9 },
          { text: 'edge', start: 1050, end: 1350, confidence: 0.9 },
          { text: 'f2', start: 1500, end: 2400, confidence: 0.9 },
        ],
      } as MergeUtterance,
    ]);
    const { payload: out, stats } = mergeTranscripts(base, fill);
    const all = utterancesOf(out).flatMap((u) => u.words!.map((w) => w.text));
    expect(all.filter((t) => t === 'edge')).toEqual(['edge']);
    // Midpoint 1200 is in [1200, 2400) — the second utterance's window.
    expect(utterancesOf(out)[1]!.words!.map((w) => w.text)).toContain('edge');
    expect(stats.fillWordsUsed).toBe(3);
  });

  test('utterance count, order, speakers and bounds are the base’s (edits and names stay valid)', () => {
    const garbled: W[] = Array.from({ length: 8 }, (_, i) => ({ text: `xx${i}`, conf: 0.4 }));
    const base = payload([
      utt('A', 0, good(6)),
      utt('B', 1800, garbled),
      utt('C', 4200, good(6)),
      utt('B', 6000, garbled),
    ]);
    const fill = payload([fillOver(0, 9000)], { language_code: 'id' });
    const { payload: out } = mergeTranscripts(base, fill);
    const before = base.utterances!.map((u) => [u.speaker, u.start, u.end]);
    const after = utterancesOf(out).map((u) => [u.speaker, u.start, u.end]);
    expect(after).toEqual(before);
    // Inputs are not mutated.
    expect(base.utterances![1]!.text).toBe(garbled.map((w) => w.text).join(' '));
  });

  test('top-level fields follow the utterances; language and model stay the base’s', () => {
    const garbled: W[] = Array.from({ length: 8 }, (_, i) => ({ text: `xx${i}`, conf: 0.5 }));
    const base = payload([utt('A', 0, good(4)), utt('B', 1200, garbled)], {
      language_detection: true,
      language_confidence: 0.28,
    });
    const fill = payload([fillOver(0, 3600)], {
      language_code: 'id',
      speech_model_used: 'universal-2',
    });
    const { payload: out, stats } = mergeTranscripts(base, fill);
    const u = utterancesOf(out);
    expect(out.words).toEqual(u.flatMap((x) => x.words!));
    expect(out.text).toBe(u.map((x) => x.text).join(' '));
    expect(out.language_code).toBe('en');
    expect(out.speech_model_used).toBe('universal-3-5-pro');
    expect(out.language_confidence).toBe(0.28);
    expect(stats).toEqual({
      utterances: 2,
      utterancesTouched: 1,
      utterancesWhole: 1,
      swappedMs: 2400,
      durationMs: 60_000,
      fillWordsUsed: 8,
    });
    expect(out.merge?.stats).toEqual(stats);
    expect(out.merge?.options.utteranceThreshold).toBe(0.75);
  });

  test('preview lists touched utterances only, truncated', () => {
    const garbled: W[] = Array.from({ length: 8 }, (_, i) => ({ text: `xx${i}`, conf: 0.5 }));
    const base = payload([utt('A', 0, good(4)), utt('B', 1200, garbled)]);
    const fill = payload([fillOver(0, 3600)], { language_code: 'id' });
    const { payload: out } = mergeTranscripts(base, fill);
    const preview = mergePreview(base, out, 40, 10);
    expect(preview).toHaveLength(1);
    expect(preview[0]!.speaker).toBe('B');
    expect(preview[0]!.start).toBe(1200);
    expect(preview[0]!.before.length).toBeLessThanOrEqual(10);
    expect(preview[0]!.after.startsWith('id')).toBe(true);
  });
});

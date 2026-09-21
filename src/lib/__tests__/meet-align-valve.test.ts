import { describe, expect, test } from 'bun:test';
import type { MeetUtterance } from '../format';
import type { AlignmentVote } from '../meet-align-vote';
import {
  MAX_CHECKS_PER_MEETING,
  MAX_SNIPPETS,
  SINGLE_VOICE_SPLIT,
  SNIPPET_MS,
  denseWindowsFor,
  planValveChecks,
  runVoiceValve,
  snippetsFor,
  splitScore,
  timelineAlignment,
  verdictFor,
  type PooledGroup,
  type ValveContext,
} from '../meet-align-valve';

/**
 * The pooled-room release valve: the decision around the ECAPA check, with
 * the sidecar stubbed. Nothing here touches audio — the embeddings are made
 * up unit vectors, which is all `split` ever sees.
 *
 * The thresholds and the precondition list come from
 * docs/eval-shared-mic-2026-09-21.md §9 and the measurement in
 * docs/eval-meet-align-voice-valve-2026-09-22.md.
 */

/** A Meet window of `spanS` seconds at `density` chars/s. */
function win(speaker: string, startS: number, spanS: number, density: number): MeetUtterance {
  return {
    speaker,
    text: 'x'.repeat(Math.round(spanS * density)),
    start: startS * 1000,
    end: (startS + spanS) * 1000,
  };
}

/** `n` dense windows of `spanS` s for one name, one per minute from `fromS`. */
function denseRun(speaker: string, n: number, fromS = 0, spanS = 20, everyS = 60): MeetUtterance[] {
  return Array.from({ length: n }, (_, i) => win(speaker, fromS + i * everyS, spanS, 14));
}

function aai(speaker: string, startS: number, endS: number) {
  return { speaker, start: startS * 1000, end: endS * 1000 };
}

function vote(name: string, overlapMs: number, share = 0.8): AlignmentVote {
  return { name, share, overlapMs };
}

function group(name: string, entries: Array<[string, number]>): PooledGroup {
  return { name, entries: entries.map(([speaker, ms]) => ({ speaker, vote: vote(name, ms) })) };
}

/** A unit vector at `deg`, so the cosine between two of them is cos(Δ). */
function v(deg: number): number[] {
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

function ctxFor(meet: MeetUtterance[], over: Partial<ValveContext> = {}): ValveContext {
  // AAI speech covering the whole sidecar, so alignment is 1 unless a test
  // says otherwise.
  const end = Math.max(...meet.map((m) => m.end), 0) / 1000;
  return {
    meetUtterances: meet,
    aaiUtterances: [aai('A', 0, end)],
    hasLocalMedia: true,
    timelineShifted: false,
    ...over,
  };
}

describe('dense windows', () => {
  test('only long, full windows of THAT name survive, merged', () => {
    const meet = [
      win('Ada', 0, 20, 14), // dense
      win('Ada', 20, 20, 14), // dense and adjacent -> merges with the first
      win('Ada', 100, 20, 3), // caption flush, mostly someone else
      win('Ada', 200, 2, 30), // full but too short to cut from
      win('Bob', 300, 20, 14), // another name
    ];
    expect(denseWindowsFor(meet, 'Ada')).toEqual([[0, 40_000]]);
    expect(denseWindowsFor(meet, 'Bob')).toEqual([[300_000, 320_000]]);
  });

  test('a name nobody dense-speaks for has no windows', () => {
    expect(denseWindowsFor([win('Ada', 0, 20, 5)], 'Ada')).toEqual([]);
  });
});

describe('snippet selection', () => {
  test('at most K snippets, each SNIPPET_MS long and inside its window', () => {
    const windows = denseWindowsFor(denseRun('Ada', 12), 'Ada');
    const snippets = snippetsFor(windows);
    expect(snippets.length).toBe(MAX_SNIPPETS);
    for (const s of snippets) {
      expect(s.endMs - s.startMs).toBe(SNIPPET_MS);
      const inside = windows.some(([ws, we]) => s.startMs >= ws && s.endMs <= we);
      expect(inside).toBe(true);
    }
  });

  test('they are spread across the meeting, not taken from the front', () => {
    const windows = denseWindowsFor(denseRun('Ada', 12), 'Ada');
    const snippets = snippetsFor(windows);
    const last = snippets[snippets.length - 1]!;
    // the run is 12 minutes long; the last snippet must come from its back half
    expect(last.startMs).toBeGreaterThan(6 * 60_000);
  });

  test('windows shorter than a snippet yield nothing', () => {
    expect(snippetsFor([[0, 4000]])).toEqual([]);
  });
});

describe('timelineAlignment', () => {
  test('1 when every Meet window lands on diarized speech', () => {
    expect(timelineAlignment([aai('A', 0, 100)], [win('Ada', 0, 100, 14)])).toBe(1);
  });

  test('near 0 when the sidecar sits on another timeline', () => {
    expect(timelineAlignment([aai('A', 0, 100)], [win('Ada', 500, 100, 14)])).toBe(0);
  });
});

describe('planValveChecks preconditions', () => {
  const groups = [group('Ada', [['A', 30_000], ['B', 20_000]])];
  const meet = denseRun('Ada', 8);

  test('no local media: every group is skipped, nothing is planned', () => {
    const plan = planValveChecks(groups, ctxFor(meet, { hasLocalMedia: false }));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped).toEqual([{ name: 'Ada', reason: 'no-media' }]);
  });

  test('a shifted timeline is refused outright', () => {
    const plan = planValveChecks(groups, ctxFor(meet, { timelineShifted: true }));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('timeline-shift');
  });

  test('a sidecar that does not line up with the audio is refused', () => {
    const plan = planValveChecks(
      groups,
      ctxFor(meet, { aaiUtterances: [aai('A', 100_000, 100_030)] })
    );
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('misaligned');
  });

  test('too few dense windows: no opinion is possible, so no check', () => {
    const plan = planValveChecks(groups, ctxFor(denseRun('Ada', 3)));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('not-dense');
  });

  test('enough windows but under 60 s of dense speech is still no check', () => {
    const plan = planValveChecks(groups, ctxFor(denseRun('Ada', 6, 0, 8)));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('not-dense');
  });

  test('enough dense speech but no window long enough to cut a snippet', () => {
    // 16 windows of 4.5 s: 72 s of dense speech, none of it 5 s in one piece.
    const plan = planValveChecks(groups, ctxFor(denseRun('Ada', 16, 0, 4.5)));
    expect(plan.candidates).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('too-few-snippets');
  });

  test('a clean row plans one check, on the label holding the most time', () => {
    const plan = planValveChecks(groups, ctxFor(meet));
    expect(plan.candidates.length).toBe(1);
    const c = plan.candidates[0]!;
    expect(c.name).toBe('Ada');
    expect(c.winner).toBe('A');
    expect(c.denseWindows).toBe(8);
    expect(c.denseMs).toBe(8 * 20_000);
    expect(c.snippets.length).toBe(MAX_SNIPPETS);
    expect(plan.skipped).toEqual([]);
  });
});

describe('the per-meeting cap', () => {
  test('only the densest MAX_CHECKS_PER_MEETING names are checked', () => {
    const names = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const meet = names.flatMap((n, i) =>
      // N1 gets the most dense speech, N5 the least
      denseRun(n, 12 - i, i * 4, 20, 60)
    );
    const groups = names.map((n) => group(n, [['A', 30_000], ['B', 20_000]]));
    const plan = planValveChecks(groups, ctxFor(meet));
    expect(plan.candidates.length).toBe(MAX_CHECKS_PER_MEETING);
    expect(plan.candidates.map((c) => c.name)).toEqual(['N1', 'N2', 'N3']);
    expect(plan.skipped).toEqual([
      { name: 'N4', reason: 'cap' },
      { name: 'N5', reason: 'cap' },
    ]);
  });
});

describe('splitScore', () => {
  test('identical snippets score 1 — one voice', () => {
    expect(splitScore(Array.from({ length: 8 }, () => v(0)))).toBeCloseTo(1, 6);
  });

  test('two tight clusters score the cosine between them', () => {
    const embeddings = [...Array.from({ length: 4 }, () => v(0)), ...Array.from({ length: 4 }, () => v(80))];
    expect(splitScore(embeddings)!).toBeCloseTo(Math.cos((80 * Math.PI) / 180), 6);
  });

  test('a single outlier does not decide it — split needs two a side', () => {
    const embeddings = [...Array.from({ length: 7 }, () => v(0)), v(90)];
    // The minimum pairwise cosine here is 0 — `min` would call this two
    // voices. `split` cannot put the outlier on a side of its own, so the
    // best it manages is pairing it with one twin (centroid at 45°, cos
    // 0.707) and the verdict stays "one voice". That is exactly why the eval
    // chose `split` over `min`.
    expect(splitScore(embeddings)!).toBeCloseTo(Math.SQRT1_2, 6);
    expect(verdictFor(splitScore(embeddings), embeddings.length)).toBe('single-voice');
  });

  test('under four snippets it falls back to the minimum pairwise cosine', () => {
    expect(splitScore([v(0), v(60), v(10)])!).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 6);
  });

  test('one snippet or none has no answer', () => {
    expect(splitScore([v(0)])).toBeNull();
    expect(splitScore([])).toBeNull();
  });
});

describe('verdictFor', () => {
  test('at or above the threshold is one voice', () => {
    expect(verdictFor(SINGLE_VOICE_SPLIT, 8)).toBe('single-voice');
    expect(verdictFor(0.9, 8)).toBe('single-voice');
  });

  test('below it is more than one voice', () => {
    expect(verdictFor(SINGLE_VOICE_SPLIT - 0.001, 8)).toBe('more-than-one-voice');
  });

  test('silence is never read as one voice', () => {
    expect(verdictFor(null, 0)).toBe('no-opinion');
    expect(verdictFor(0.99, 3)).toBe('no-opinion');
  });
});

describe('runVoiceValve', () => {
  const groups = [group('Ada', [['A', 30_000], ['B', 20_000]])];
  const plan = planValveChecks(groups, ctxFor(denseRun('Ada', 8)));

  test('one voice releases the winning label', async () => {
    const checks = await runVoiceValve(plan, async (c) => {
      expect(c.snippets.length).toBe(MAX_SNIPPETS);
      return c.snippets.map(() => v(0));
    });
    expect(checks.length).toBe(1);
    expect(checks[0]!.verdict).toBe('single-voice');
    expect(checks[0]!.candidate.winner).toBe('A');
  });

  test('two voices keep the drop', async () => {
    const checks = await runVoiceValve(plan, async (c) =>
      c.snippets.map((_, i) => (i % 2 === 0 ? v(0) : v(85)))
    );
    expect(checks[0]!.verdict).toBe('more-than-one-voice');
  });

  test('a sidecar that throws is no opinion, not a rescue', async () => {
    const checks = await runVoiceValve(plan, async () => {
      throw new Error('sidecar down');
    });
    expect(checks[0]!.verdict).toBe('no-opinion');
    expect(checks[0]!.split).toBeNull();
  });

  test('too few decoded snippets is no opinion, however alike they are', async () => {
    const checks = await runVoiceValve(plan, async () => [v(0), v(0), v(0)]);
    expect(checks[0]!.verdict).toBe('no-opinion');
    expect(checks[0]!.embeddings).toBe(3);
  });

  test('nothing planned means the embedder is never called', async () => {
    let calls = 0;
    const empty = planValveChecks(groups, ctxFor(denseRun('Ada', 8), { hasLocalMedia: false }));
    const checks = await runVoiceValve(empty, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
    expect(checks).toEqual([]);
  });
});

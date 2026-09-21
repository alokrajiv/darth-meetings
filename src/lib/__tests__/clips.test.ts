import { describe, expect, test } from 'bun:test';
import {
  MAX_PROPOSALS,
  MIN_CLIP_MS,
  adoptProposals,
  calendarBoundaries,
  candidateWindows,
  clipCandidates,
  clipExtentMs,
  countEdits,
  formatDuration,
  formatTimestamp,
  holesOf,
  hostClipFor,
  mayDeleteRecordingFiles,
  meetingSpanMs,
  mergeEditMaps,
  mergeOrder,
  parseTimestampMs,
  planSplit,
  planUnsplit,
  recordingAnchorIso,
  rekeyEditMap,
  selectWindow,
  silenceBoundaries,
  speakerBoundaries,
  splitPrecondition,
  validateSplitWindow,
  windowBoundsFor,
  type ClipWindow,
} from '../clips';

const REC = '11111111-1111-5111-8111-111111111111';
const OTHER = '22222222-2222-5222-8222-222222222222';

/** The clip every meeting has until somebody splits it. */
const whole: ClipWindow = { ord: 0, recordingId: REC, fromMs: 0, toMs: null, offsetMs: 0 };
const SPAN = 3_600_000; // a one-hour recording

describe('timestamps — what darth-cli and the dialog both parse', () => {
  test('mm:ss, h:mm:ss, milliseconds', () => {
    expect(parseTimestampMs('12:40')).toBe(760_000);
    expect(parseTimestampMs('1:02:03')).toBe(3_723_000);
    expect(parseTimestampMs('0:00')).toBe(0);
    expect(parseTimestampMs('12:40.5')).toBe(760_500);
  });

  test('a bare number is ALWAYS ms — never seconds guessed from magnitude', () => {
    expect(parseTimestampMs('760000')).toBe(760_000);
    expect(parseTimestampMs(760_000)).toBe(760_000);
    expect(parseTimestampMs('90')).toBe(90);
  });

  test('anything unreadable is null, so the caller refuses instead of guessing', () => {
    for (const bad of ['', '  ', 'soon', '12:99', '-5', '1:2:3:4', null, undefined, NaN]) {
      expect(parseTimestampMs(bad as never)).toBeNull();
    }
  });

  test('printing is the inverse for whole seconds', () => {
    expect(formatTimestamp(760_000)).toBe('12:40');
    expect(formatTimestamp(3_723_000)).toBe('1:02:03');
    expect(formatDuration(1_705_000)).toBe('28m 25s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(9000)).toBe('9s');
  });
});

describe('window validation — the dialog greys out for exactly these reasons', () => {
  const base = { clips: [whole], spanMs: SPAN };

  test('a mis-drag is not a meeting', () => {
    expect(validateSplitWindow({ ...base, fromMs: 1000, toMs: 5000 })?.code).toBe(
      'window-too-short'
    );
    expect(validateSplitWindow({ ...base, fromMs: 1000, toMs: 1000 + MIN_CLIP_MS })).toBeNull();
  });

  test('the start has to come before the end', () => {
    expect(validateSplitWindow({ ...base, fromMs: 9000, toMs: 1000 })?.code).toBe('window-invalid');
    expect(validateSplitWindow({ ...base, fromMs: -1, toMs: 60_000 })?.code).toBe('window-invalid');
  });

  test('"split off everything" is a rename, not a split', () => {
    expect(validateSplitWindow({ ...base, fromMs: 0, toMs: SPAN })?.code).toBe(
      'window-covers-everything'
    );
    // …unless the window stays in both meetings, where nothing is taken away.
    expect(
      validateSplitWindow({ ...base, fromMs: 0, toMs: SPAN, keepInBoth: true })
    ).toBeNull();
  });

  test('past the end of the recording', () => {
    expect(validateSplitWindow({ ...base, fromMs: SPAN + 1000, toMs: SPAN + 90_000 })?.code).toBe(
      'window-outside'
    );
  });

  test('a range running across a hole belongs to somebody else', () => {
    // A meeting that already gave 10:00–20:00 away.
    const shrunk: ClipWindow[] = [
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 600_000, offsetMs: 0 },
      { ord: 1, recordingId: REC, fromMs: 1_200_000, toMs: null, offsetMs: 1_200_000 },
    ];
    expect(
      validateSplitWindow({ clips: shrunk, spanMs: SPAN, fromMs: 500_000, toMs: 1_300_000 })?.code
    ).toBe('window-crosses-hole');
    // Wholly inside one of the remaining stretches is fine.
    expect(
      validateSplitWindow({ clips: shrunk, spanMs: SPAN, fromMs: 1_300_000, toMs: 1_900_000 })
    ).toBeNull();
    // Wholly inside the hole is not "crosses" — it touches nothing at all.
    expect(
      validateSplitWindow({ clips: shrunk, spanMs: SPAN, fromMs: 700_000, toMs: 800_000 })?.code
    ).toBe('window-outside');
  });

  test('two recordings cannot be split yet (Phase 3b)', () => {
    expect(
      validateSplitWindow({
        clips: [whole, { ord: 1, recordingId: OTHER, fromMs: 0, toMs: null, offsetMs: SPAN }],
        spanMs: SPAN * 2,
        fromMs: 60_000,
        toMs: 120_000,
      })?.code
    ).toBe('multi-recording');
  });

  test('a meeting with no clip has nothing to take a part of', () => {
    expect(
      validateSplitWindow({ clips: [], spanMs: SPAN, fromMs: 0, toMs: 60_000 })?.code
    ).toBe('no-clip');
  });
});

describe('clip extents, spans and holes', () => {
  test('an open-ended clip runs to the meeting span', () => {
    expect(clipExtentMs(whole, SPAN)).toEqual([0, SPAN]);
    expect(clipExtentMs({ ...whole, fromMs: 600_000, offsetMs: 600_000, toMs: 900_000 }, SPAN)).toEqual([
      600_000, 900_000,
    ]);
  });

  test('the meeting span is the furthest a clip reaches, not the sum', () => {
    expect(meetingSpanMs([whole], SPAN)).toBe(SPAN);
    expect(
      meetingSpanMs(
        [
          { ord: 0, recordingId: REC, fromMs: 0, toMs: 600_000, offsetMs: 0 },
          { ord: 1, recordingId: REC, fromMs: 1_200_000, toMs: null, offsetMs: 1_200_000 },
        ],
        SPAN
      )
    ).toBe(SPAN);
  });

  test('a meeting that was never split has no hole', () => {
    expect(holesOf([whole], SPAN)).toEqual([]);
  });

  test('the hole is exactly the window that left', () => {
    expect(
      holesOf(
        [
          { ord: 0, recordingId: REC, fromMs: 0, toMs: 600_000, offsetMs: 0 },
          { ord: 1, recordingId: REC, fromMs: 1_200_000, toMs: null, offsetMs: 1_200_000 },
        ],
        SPAN
      )
    ).toEqual([{ fromMs: 600_000, toMs: 1_200_000 }]);
  });

  test('hostClipFor tells the dialog which stretch it is dragging in', () => {
    expect(hostClipFor([whole], 1000, 2000, SPAN)).toBe(whole);
    expect(hostClipFor([whole], SPAN + 1, SPAN + 2, SPAN)).toBe('outside');
  });
});

describe('the player window (ResolvedMedia.windowFromMs / windowToMs)', () => {
  test('an un-split meeting plays the whole file', () => {
    expect(windowBoundsFor([whole], REC)).toEqual({ fromMs: null, toMs: null });
  });

  test('a SOURCE that shrank still plays the whole file — the hole is separate', () => {
    const shrunk: ClipWindow[] = [
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 600_000, offsetMs: 0 },
      { ord: 1, recordingId: REC, fromMs: 1_200_000, toMs: null, offsetMs: 1_200_000 },
    ];
    expect(windowBoundsFor(shrunk, REC)).toEqual({ fromMs: null, toMs: null });
  });

  test('a split-off meeting clamps to its window', () => {
    expect(
      windowBoundsFor([{ ord: 0, recordingId: REC, fromMs: 760_000, toMs: 2_465_000, offsetMs: 0 }], REC)
    ).toEqual({ fromMs: 760_000, toMs: 2_465_000 });
  });

  test('a recording this meeting does not use has no bounds of its own', () => {
    expect(windowBoundsFor([whole], OTHER)).toEqual({ fromMs: null, toMs: null });
  });
});

describe('planSplit — the hole maths (D-D)', () => {
  test('a window out of the middle leaves the source its own timeline', () => {
    const plan = planSplit({ clips: [whole], fromMs: 760_000, toMs: 2_465_000, spanMs: SPAN });
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.created).toEqual([
      { ord: 0, recordingId: REC, fromMs: 760_000, toMs: 2_465_000, offsetMs: 0 },
    ]);
    // The tail keeps `offset_ms` = where it always was, so every `t:<ms>` in
    // the source's notes still points at the right moment.
    expect(plan.source).toEqual([
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 760_000, offsetMs: 0 },
      { ord: 1, recordingId: REC, fromMs: 2_465_000, toMs: null, offsetMs: 2_465_000 },
    ]);
    expect(plan.leavesHole).toBe(true);
    expect(holesOf(plan.source, SPAN)).toEqual([{ fromMs: 760_000, toMs: 2_465_000 }]);
  });

  test('a window flush against the START leaves one clip, not an empty one', () => {
    const plan = planSplit({ clips: [whole], fromMs: 0, toMs: 600_000, spanMs: SPAN });
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.source).toEqual([
      { ord: 0, recordingId: REC, fromMs: 600_000, toMs: null, offsetMs: 600_000 },
    ]);
    expect(plan.leavesHole).toBe(false);
    // And the source's timeline still starts at 600 s — the hole at the front
    // is what keeps its citations right.
    expect(holesOf(plan.source, SPAN)).toEqual([{ fromMs: 0, toMs: 600_000 }]);
  });

  test('a window flush against the END leaves one clip', () => {
    const plan = planSplit({ clips: [whole], fromMs: 3_000_000, toMs: SPAN, spanMs: SPAN });
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.source).toEqual([
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 3_000_000, offsetMs: 0 },
    ]);
    expect(plan.leavesHole).toBe(false);
  });

  test('keepInBoth leaves the source untouched', () => {
    const plan = planSplit({
      clips: [whole],
      fromMs: 760_000,
      toMs: 2_465_000,
      spanMs: SPAN,
      keepInBoth: true,
    });
    if ('code' in plan) throw new Error(plan.message);
    expect(plan.source).toEqual([whole]);
    expect(plan.leavesHole).toBe(false);
  });

  test('a second split, inside the tail of the first', () => {
    const first = planSplit({ clips: [whole], fromMs: 600_000, toMs: 1_200_000, spanMs: SPAN });
    if ('code' in first) throw new Error(first.message);
    const second = planSplit({ clips: first.source, fromMs: 2_000_000, toMs: 2_600_000, spanMs: SPAN });
    if ('code' in second) throw new Error(second.message);
    expect(second.recordingFromMs).toBe(2_000_000);
    expect(holesOf(second.source, SPAN)).toEqual([
      { fromMs: 600_000, toMs: 1_200_000 },
      { fromMs: 2_000_000, toMs: 2_600_000 },
    ]);
    // Every ord stays unique — it is the clip's identity, not its position.
    expect(new Set(second.source.map((c) => c.ord)).size).toBe(second.source.length);
  });

  test('meeting ms become RECORDING ms through the host clip', () => {
    // A source that already gave its first ten minutes away: meeting ms 700 s
    // sits inside the clip that starts at recording ms 600 s, offset 600 s.
    const shrunk: ClipWindow[] = [
      { ord: 0, recordingId: REC, fromMs: 600_000, toMs: null, offsetMs: 600_000 },
    ];
    const plan = planSplit({ clips: shrunk, fromMs: 700_000, toMs: 800_000, spanMs: SPAN });
    if ('code' in plan) throw new Error(plan.message);
    expect([plan.recordingFromMs, plan.recordingToMs]).toEqual([700_000, 800_000]);
  });

  test('a refusal comes back as a refusal, not a plan', () => {
    const plan = planSplit({ clips: [whole], fromMs: 0, toMs: 5000, spanMs: SPAN });
    expect('code' in plan && plan.code).toBe('window-too-short');
  });
});

describe('planUnsplit — putting it back', () => {
  const split = planSplit({ clips: [whole], fromMs: 760_000, toMs: 2_465_000, spanMs: SPAN });
  if ('code' in split) throw new Error(split.message);

  test('the two clips merge back into the one the meeting started with', () => {
    expect(planUnsplit({ sourceClips: split.source, clip: split.created[0]! })).toEqual([whole]);
  });

  test('a flush-to-the-start split merges back too', () => {
    const head = planSplit({ clips: [whole], fromMs: 0, toMs: 600_000, spanMs: SPAN });
    if ('code' in head) throw new Error(head.message);
    expect(planUnsplit({ sourceClips: head.source, clip: head.created[0]! })).toEqual([whole]);
  });

  test('a source re-clipped since the split keeps what it still holds', () => {
    // Somebody took 700 000–760 000 as well, so the head no longer meets the
    // window. The tail still does: the window goes back where it was and the
    // second hole stays — it is somebody else's meeting now.
    const moved: ClipWindow[] = [
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 700_000, offsetMs: 0 },
      { ord: 1, recordingId: REC, fromMs: 2_465_000, toMs: null, offsetMs: 2_465_000 },
    ];
    expect(planUnsplit({ sourceClips: moved, clip: split.created[0]! })).toEqual([
      { ord: 0, recordingId: REC, fromMs: 0, toMs: 700_000, offsetMs: 0 },
      // offsetMs 760 000, NOT the split-off meeting's own zero: the window
      // lands back where it was on the SOURCE's timeline.
      { ord: 1, recordingId: REC, fromMs: 760_000, toMs: null, offsetMs: 760_000 },
    ]);
  });

  test('a window flush against the start of a SHIFTED clip comes back in place', () => {
    // A meeting that itself started at recording ms 600 000 (it was split off
    // something), then gave its own first two minutes away.
    const child: ClipWindow[] = [
      { ord: 0, recordingId: REC, fromMs: 720_000, toMs: 1_200_000, offsetMs: 120_000 },
    ];
    const clip: ClipWindow = { ord: 0, recordingId: REC, fromMs: 600_000, toMs: 720_000, offsetMs: 0 };
    expect(planUnsplit({ sourceClips: child, clip })).toEqual([
      { ord: 0, recordingId: REC, fromMs: 600_000, toMs: 1_200_000, offsetMs: 0 },
    ]);
  });

  test('a source on another recording is never merged into', () => {
    expect(
      planUnsplit({
        sourceClips: [{ ord: 0, recordingId: OTHER, fromMs: 0, toMs: null, offsetMs: 0 }],
        clip: split.created[0]!,
      })
    ).toBeNull();
  });

  test('an open-ended clip is not a window that can be put back', () => {
    expect(planUnsplit({ sourceClips: split.source, clip: whole })).toBeNull();
  });
});

describe('edit re-keying, both ways (landmine #2)', () => {
  // Six utterances, the window taking 2–4.
  const starts = [0, 10_000, 20_000, 30_000, 40_000, 50_000];
  const edits = {
    '0': { text: 'zero' },
    '2': { text: 'two' },
    '3': { speaker: 'B' },
    '5': { text: 'five' },
  };

  test('from_ms inclusive, to_ms exclusive — the same rule the resolver windows by', () => {
    expect(selectWindow(starts, 20_000, 40_000)).toEqual({
      inside: [2, 3],
      outside: [0, 1, 4, 5],
    });
  });

  test('the new meeting keeps the window’s edits, renumbered from 0', () => {
    const { inside } = selectWindow(starts, 20_000, 40_000);
    expect(rekeyEditMap(edits, inside)).toEqual({ '0': { text: 'two' }, '1': { speaker: 'B' } });
  });

  test('the source keeps the rest, renumbered over its new list', () => {
    const { outside } = selectWindow(starts, 20_000, 40_000);
    expect(rekeyEditMap(edits, outside)).toEqual({ '0': { text: 'zero' }, '3': { text: 'five' } });
  });

  test('no edits in, no edits out', () => {
    expect(rekeyEditMap(null, [0, 1])).toEqual({});
    expect(rekeyEditMap({}, [0, 1])).toEqual({});
    expect(countEdits(null)).toBe(0);
    expect(countEdits(edits)).toBe(4);
  });

  test('the un-split merge order puts both halves back on one timeline', () => {
    const sourceStarts = [0, 10_000, 40_000, 50_000];
    const clipStarts = [20_000, 30_000];
    expect(mergeOrder(sourceStarts, clipStarts)).toEqual([
      { from: 'source', index: 0 },
      { from: 'source', index: 1 },
      { from: 'clip', index: 0 },
      { from: 'clip', index: 1 },
      { from: 'source', index: 2 },
      { from: 'source', index: 3 },
    ]);
  });

  test('a tie keeps the source first, so the operation is exactly reversible', () => {
    expect(mergeOrder([1000], [1000])).toEqual([
      { from: 'source', index: 0 },
      { from: 'clip', index: 0 },
    ]);
  });

  test('split then un-split is the identity on the edit map', () => {
    const { inside, outside } = selectWindow(starts, 20_000, 40_000);
    const clipEdits = rekeyEditMap(edits, inside);
    const sourceEdits = rekeyEditMap(edits, outside);
    const slots = mergeOrder(
      outside.map((i) => starts[i]!),
      inside.map((i) => starts[i]!)
    );
    expect(mergeEditMaps(sourceEdits, clipEdits, slots)).toEqual(edits);
  });
});

describe('proposal candidates (deterministic, free, tested without a model)', () => {
  const utterances = [
    { startMs: 0, endMs: 20_000, speaker: 'A' },
    { startMs: 20_000, endMs: 60_000, speaker: 'B' },
    // A 90-second silence, then a different pair of voices.
    { startMs: 150_000, endMs: 170_000, speaker: 'A' },
    { startMs: 170_000, endMs: 200_000, speaker: 'C' },
    { startMs: 200_000, endMs: 240_000, speaker: 'C' },
  ];

  test('a speaker heard from the first second is not an ENTRY boundary', () => {
    // A starts at 0 (inside the 60 s edge tolerance), so "A is first heard"
    // says nothing. A stopping 70 s before the end DOES say something.
    const out = speakerBoundaries(utterances);
    expect(out.filter((c) => c.kind === 'speaker-enter').map((c) => c.label)).toEqual([
      'Speaker C is first heard',
    ]);
  });

  test('"when Paola came in / left"', () => {
    const out = speakerBoundaries(utterances, (s) => (s === 'C' ? 'Paola' : `Speaker ${s}`));
    expect(out).toEqual([
      { atMs: 60_000, kind: 'speaker-leave', label: 'Speaker B is last heard' },
      { atMs: 170_000, kind: 'speaker-leave', label: 'Speaker A is last heard' },
      { atMs: 170_000, kind: 'speaker-enter', label: 'Paola is first heard' },
    ]);
  });

  test('a speaker who talks through the WHOLE recording is no boundary at all', () => {
    expect(
      speakerBoundaries([
        { startMs: 0, endMs: 100_000, speaker: 'A' },
        { startMs: 100_000, endMs: 240_000, speaker: 'A' },
      ])
    ).toEqual([]);
  });

  test('silences of 45 s or more are the usual seam', () => {
    expect(silenceBoundaries(utterances)).toEqual([
      { atMs: 150_000, kind: 'silence', label: '1m 30s of silence ends here' },
    ]);
    // A 44-second gap is not.
    expect(
      silenceBoundaries([
        { startMs: 0, endMs: 1000, speaker: 'A' },
        { startMs: 45_000, endMs: 46_000, speaker: 'A' },
      ])
    ).toEqual([]);
  });

  test('calendar occurrences land on the meeting timeline', () => {
    const recordingStart = Date.parse('2026-09-22T02:00:00Z');
    const out = calendarBoundaries(
      [
        {
          eventRef: 'ev1|2026-09-22T02:30:00Z',
          title: 'Gabe 1:1',
          startMs: Date.parse('2026-09-22T02:30:00Z'),
          endMs: Date.parse('2026-09-22T03:00:00Z'),
        },
      ],
      recordingStart,
      3_600_000
    );
    // The event ENDS exactly where the recording does, which is not a place
    // anything can be cut — only its start is a boundary.
    expect(out).toEqual([
      {
        atMs: 1_800_000,
        kind: 'calendar-start',
        label: '\u201cGabe 1:1\u201d starts here',
        eventRef: 'ev1|2026-09-22T02:30:00Z',
        title: 'Gabe 1:1',
      },
    ]);
  });

  test('an event that ends after the recording contributes only its start', () => {
    const recordingStart = Date.parse('2026-09-22T02:00:00Z');
    const out = calendarBoundaries(
      [
        {
          eventRef: 'ev2|x',
          title: null,
          startMs: recordingStart + 600_000,
          endMs: recordingStart + 7_200_000,
        },
      ],
      recordingStart,
      3_600_000
    );
    expect(out.map((c) => [c.atMs, c.kind])).toEqual([[600_000, 'calendar-start']]);
    expect(out[0]!.label).toContain('a calendar event');
  });

  test('a recording with no wall clock contributes no calendar boundary', () => {
    expect(calendarBoundaries([{ eventRef: 'e', title: null, startMs: 0, endMs: 1 }], null, 1000)).toEqual(
      []
    );
  });

  test('the calendar wins when a speaker arrives at the same moment', () => {
    const recordingStart = Date.parse('2026-09-22T02:00:00Z');
    const out = clipCandidates({
      utterances,
      events: [
        {
          eventRef: 'ev1|x',
          title: 'Customer call',
          startMs: recordingStart + 170_000,
          endMs: null,
        },
      ],
      recordingStartMs: recordingStart,
      spanMs: 240_000,
    });
    const at170 = out.filter((c) => Math.abs(c.atMs - 170_000) <= 15_000);
    expect(at170).toHaveLength(1);
    expect(at170[0]!.kind).toBe('calendar-start');
    expect(at170[0]!.eventRef).toBe('ev1|x');
  });

  test('boundaries at 0 or at the end are not boundaries', () => {
    const out = clipCandidates({ utterances, spanMs: 240_000 });
    expect(out.every((c) => c.atMs > 0 && c.atMs < 240_000)).toBe(true);
  });

  test('the windows are every consecutive pair, short ones dropped', () => {
    const out = candidateWindows(
      [
        { atMs: 60_000, kind: 'silence', label: 'a' },
        { atMs: 65_000, kind: 'silence', label: 'b' }, // 5 s later — too short
        { atMs: 180_000, kind: 'silence', label: 'c' },
      ],
      240_000
    );
    expect(out.map((w) => [w.fromMs, w.toMs])).toEqual([
      [0, 60_000],
      [65_000, 180_000],
      [180_000, 240_000],
    ]);
    expect(out[0]!.startedBy).toBeNull();
    expect(out[out.length - 1]!.endedBy).toBeNull();
  });

  test('no boundaries ⇒ one window ⇒ nothing to choose between', () => {
    expect(candidateWindows([], 240_000).map((w) => [w.fromMs, w.toMs])).toEqual([[0, 240_000]]);
  });
});

describe('adopting the proposer\u2019s answer — the model picks, it never invents', () => {
  const windows = candidateWindows(
    [
      { atMs: 760_000, kind: 'silence', label: '2m of silence ends here' },
      {
        atMs: 2_465_000,
        kind: 'calendar-start',
        label: '\u201cGabe 1:1\u201d starts here',
        eventRef: 'ev1|x',
        title: 'Gabe 1:1',
      },
    ],
    SPAN
  );
  const ctx = { windows, clips: [whole], spanMs: SPAN };

  test('a window the deterministic pass found is adopted, named and explained', () => {
    const out = adoptProposals(
      [
        {
          fromMs: 760_000,
          toMs: 2_465_000,
          title: 'MSFT Kerner podcast',
          reason: 'Two people, one topic, ends at a long silence',
          confidence: 0.8,
        },
      ],
      ctx
    );
    expect(out).toEqual([
      {
        fromMs: 760_000,
        toMs: 2_465_000,
        title: 'MSFT Kerner podcast',
        reason: 'Two people, one topic, ends at a long silence',
        confidence: 0.8,
        basis: 'silence',
      },
    ]);
  });

  test('a rounded timestamp snaps back to the real boundary', () => {
    const out = adoptProposals([{ fromMs: 760_400, toMs: 2_464_000 }], ctx);
    expect(out.map((p) => [p.fromMs, p.toMs])).toEqual([[760_000, 2_465_000]]);
  });

  test('an invented timestamp is DROPPED, not snapped', () => {
    expect(adoptProposals([{ fromMs: 900_000, toMs: 2_465_000 }], ctx)).toEqual([]);
  });

  test('anything the server would refuse never reaches the dialog as a preset', () => {
    // The whole recording; and a window shorter than the minimum.
    expect(adoptProposals([{ fromMs: 0, toMs: SPAN }], ctx)).toEqual([]);
    expect(
      adoptProposals([{ fromMs: 760_000, toMs: 760_000 }], ctx)
    ).toEqual([]);
  });

  test('an eventRef is only carried when the BOUNDARY had one', () => {
    const real = adoptProposals([{ fromMs: 2_465_000, toMs: SPAN, eventRef: 'ev1|x' }], ctx);
    expect(real[0]!.eventRef).toBe('ev1|x');
    expect(real[0]!.basis).toBe('calendar-start');
    // A reference the model made up, on a boundary that has none.
    const invented = adoptProposals(
      [{ fromMs: 760_000, toMs: 2_465_000, eventRef: 'ev9|made-up' }],
      ctx
    );
    expect(invented[0]!.eventRef).toBeUndefined();
  });

  test('titles and reasons fall back to something true rather than empty', () => {
    const out = adoptProposals([{ fromMs: 760_000, toMs: 2_465_000 }], ctx);
    expect(out[0]!.title).toBe('12:40 – 41:05');
    expect(out[0]!.reason).toBe('2m of silence ends here');
    expect(out[0]!.confidence).toBe(0.5);
  });

  test('junk, duplicates and an over-long list are all survivable', () => {
    expect(adoptProposals(null, ctx)).toEqual([]);
    expect(adoptProposals('[]', ctx)).toEqual([]);
    expect(adoptProposals([null, 'x', 42, {}], ctx)).toEqual([]);
    const dup = adoptProposals(
      [
        { fromMs: 760_000, toMs: 2_465_000 },
        { fromMs: 760_000, toMs: 2_465_000 },
      ],
      ctx
    );
    expect(dup).toHaveLength(1);
    expect(MAX_PROPOSALS).toBeGreaterThan(0);
  });

  test('a { proposals: [...] } envelope is read too', () => {
    const out = adoptProposals({ proposals: [{ fromMs: 760_000, toMs: 2_465_000 }] }, ctx);
    expect(out).toHaveLength(1);
  });

  test('confidence is clamped, never trusted raw', () => {
    const out = adoptProposals([{ fromMs: 760_000, toMs: 2_465_000, confidence: 7 }], ctx);
    expect(out[0]!.confidence).toBe(1);
  });
});

describe('the file-deletion rule (spec §Media — "test it hard")', () => {
  test('graph off: today’s behaviour, because nothing else can be known', () => {
    expect(mayDeleteRecordingFiles({ graphApplied: false, recordingsKept: [] })).toBe(true);
    // Even a stale list cannot make it keep files when the graph never ran —
    // there is no clip table to have an opinion.
    expect(mayDeleteRecordingFiles({ graphApplied: false, recordingsKept: ['x'] })).toBe(true);
  });

  test('the recording went with the clips: the bytes may go', () => {
    expect(mayDeleteRecordingFiles({ graphApplied: true, recordingsKept: [] })).toBe(true);
  });

  test('another meeting still clips it: the bytes stay', () => {
    expect(mayDeleteRecordingFiles({ graphApplied: true, recordingsKept: [REC] })).toBe(false);
    expect(mayDeleteRecordingFiles({ graphApplied: true, recordingsKept: [REC, OTHER] })).toBe(false);
  });

  test('a cleanup that threw keeps the files (it knows nothing about who holds them)', () => {
    expect(mayDeleteRecordingFiles({ graphApplied: true, recordingsKept: ['unknown'] })).toBe(false);
  });
});


describe('split preconditions — one answer for the menu and the route', () => {
  /** A meeting nothing is wrong with. */
  const ok = {
    enabled: true,
    trashed: false,
    status: 'completed',
    retranscribing: false,
    sharedJob: false,
    videoParts: 0,
    hasClip: true,
    spanMs: SPAN,
  };

  test('nothing in the way: null, which is what lets the menu offer it', () => {
    expect(splitPrecondition(ok)).toBeNull();
  });

  test('each blocker has its own code and its own sentence', () => {
    expect(splitPrecondition({ ...ok, enabled: false })?.code).toBe('disabled');
    expect(splitPrecondition({ ...ok, trashed: true })?.message).toMatch(/trash/i);
    expect(splitPrecondition({ ...ok, status: 'processing' })?.code).toBe('not-completed');
    expect(splitPrecondition({ ...ok, retranscribing: true })?.code).toBe('transcribing');
    expect(splitPrecondition({ ...ok, sharedJob: true })?.code).toBe('shared-job');
    expect(splitPrecondition({ ...ok, videoParts: 2 })?.code).toBe('multi-recording');
    expect(splitPrecondition({ ...ok, hasClip: false })?.code).toBe('no-clip');
  });

  test('every refusal says something — a greyed item always has a tooltip', () => {
    for (const over of [
      { enabled: false },
      { trashed: true },
      { status: 'error' },
      { retranscribing: true },
      { sharedJob: true },
      { videoParts: 1 },
      { hasClip: false },
      { spanMs: 0 },
    ]) {
      const refusal = splitPrecondition({ ...ok, ...over });
      expect(refusal).not.toBeNull();
      expect(refusal!.message.length).toBeGreaterThan(10);
    }
  });

  test('a meeting with no length on its timeline has no part to give away', () => {
    expect(splitPrecondition({ ...ok, spanMs: 0 })?.code).toBe('no-clip');
    expect(splitPrecondition({ ...ok, spanMs: Number.NaN })?.code).toBe('no-clip');
  });

  test('the trash is named as the trash, not as "still being transcribed"', () => {
    const trashed = splitPrecondition({ ...ok, trashed: true, status: 'processing' })!;
    expect(trashed.message).toMatch(/trash/i);
  });

  test('switched off wins over everything — nothing about clips is shown at all', () => {
    expect(
      splitPrecondition({ ...ok, enabled: false, trashed: true, status: 'error' })?.code
    ).toBe('disabled');
  });
});

describe('the recording anchor — a day for the calendar pre-filter', () => {
  const started = '2026-09-21T08:30:00.000Z';
  const recorded = '2026-09-21T09:00:00.000Z';
  const created = '2026-09-22T01:00:00.000Z';

  test('the recording’s own clock wins', () => {
    expect(recordingAnchorIso(started, recorded, created)).toBe(started);
  });

  test('no recording clock: the meeting’s curated moment', () => {
    expect(recordingAnchorIso(null, recorded, created)).toBe(recorded);
    expect(recordingAnchorIso(undefined, recorded, created)).toBe(recorded);
  });

  test('neither: the day it landed here, because a poor anchor beats none', () => {
    expect(recordingAnchorIso(null, null, created)).toBe(created);
  });

  test('Dates are accepted as readily as strings', () => {
    expect(recordingAnchorIso(new Date(started), null, null)).toBe(started);
  });

  test('a junk value is skipped, not returned as "Invalid Date"', () => {
    expect(recordingAnchorIso('not a date', recorded, created)).toBe(recorded);
    expect(recordingAnchorIso('', null, created)).toBe(created);
  });

  test('nothing usable at all is null', () => {
    expect(recordingAnchorIso(null, null, null)).toBeNull();
    expect(recordingAnchorIso('nope', 'never', undefined)).toBeNull();
  });
});

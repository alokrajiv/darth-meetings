/**
 * The windowed player's arithmetic (docs/recordings-phase3-clips-spec.md
 * "Media and the window").
 *
 * The scenario throughout is the scratch one: a 60-minute recording whose
 * 20:00–33:20 became its own meeting. The SOURCE keeps the whole file with a
 * hole; the SPLIT-OFF meeting plays the same bytes clamped to the window and
 * starts at 0.
 *
 * TZ-independent by construction — nothing here touches a clock.
 */
import { describe, expect, it } from 'bun:test';
import {
  clampMeetingMs,
  crossesHole,
  fileMsOf,
  holeAt,
  holesBeforeUtterance,
  meetingMsOf,
  pastWindowEnd,
  servedIsWholeFile,
  servedPlaybackForPart,
  servedPlaybackFromContext,
  windowDurationMs,
  windowFromContext,
  windowInCut,
  windowOfClips,
  type PlaybackWindow,
} from '@/lib/clip-window';
import { holesOf, type ClipWindow } from '@/lib/clips';

const RECORDING = '33333333-aaaa-4aaa-8aaa-333333333333';
const OTHER = '44444444-bbbb-4bbb-8bbb-444444444444';
const HOUR = 3_600_000;
const FROM = 1_200_000; // 20:00
const TO = 2_000_000; // 33:20

/** The split-off meeting: one clip, the window, landing at 0. */
const SPLIT_OFF: ClipWindow[] = [
  { ord: 0, recordingId: RECORDING, fromMs: FROM, toMs: TO, offsetMs: 0 },
];
/** The source after the shrink: head + tail, its own timeline kept. */
const SOURCE: ClipWindow[] = [
  { ord: 0, recordingId: RECORDING, fromMs: 0, toMs: FROM, offsetMs: 0 },
  { ord: 1, recordingId: RECORDING, fromMs: TO, toMs: null, offsetMs: TO },
];

const WINDOW: PlaybackWindow = { fromMs: FROM, toMs: TO };

describe('reading the window off the row', () => {
  it('finds the split-off meeting’s window in gmeet_context.clips', () => {
    expect(windowFromContext({ clips: SPLIT_OFF })).toEqual({ fromMs: FROM, toMs: TO });
  });

  it('gives the source no window — it still plays every second', () => {
    expect(windowFromContext({ clips: SOURCE })).toBeNull();
  });

  it('is null for a meeting that was never split (no mirror at all)', () => {
    expect(windowFromContext({})).toBeNull();
    expect(windowFromContext(null)).toBeNull();
    expect(windowFromContext(undefined)).toBeNull();
  });

  it('treats a junk mirror as absent rather than throwing', () => {
    expect(windowFromContext({ clips: [{ ord: 'x' }] })).toBeNull();
    expect(windowFromContext({ clips: 'nope' })).toBeNull();
  });

  it('agrees with the clips the API returns', () => {
    expect(windowOfClips(SPLIT_OFF)).toEqual({ fromMs: FROM, toMs: TO });
    expect(windowOfClips(SOURCE)).toBeNull();
    expect(windowOfClips([])).toBeNull();
  });

  it('places the file by the clip that lands FIRST, not by ord', () => {
    // `ord` is identity, not position: a second split can leave the tail
    // clip with the lower ord.
    const reordered: ClipWindow[] = [
      { ord: 7, recordingId: RECORDING, fromMs: FROM, toMs: TO, offsetMs: 0 },
      { ord: 2, recordingId: RECORDING, fromMs: TO, toMs: TO + 60_000, offsetMs: TO - FROM },
    ];
    expect(windowOfClips(reordered)).toEqual({ fromMs: FROM, toMs: TO + 60_000 });
  });
});

describe('meeting time ⇄ file time', () => {
  it('displays file time minus from', () => {
    expect(meetingMsOf(FROM, WINDOW)).toBe(0);
    expect(meetingMsOf(FROM + 5_000, WINDOW)).toBe(5_000);
    expect(meetingMsOf(TO, WINDOW)).toBe(TO - FROM);
  });

  it('maps a seek back into the file', () => {
    expect(fileMsOf(0, WINDOW)).toBe(FROM);
    expect(fileMsOf(5_000, WINDOW)).toBe(FROM + 5_000);
  });

  it('round-trips', () => {
    for (const ms of [0, 1, 999, 400_000, TO - FROM]) {
      expect(meetingMsOf(fileMsOf(ms, WINDOW), WINDOW)).toBe(ms);
    }
  });

  it('never shows a negative time when the element reports before the window', () => {
    // Safari can fire one `timeupdate` at 0 before the initial seek lands.
    expect(meetingMsOf(0, WINDOW)).toBe(0);
    expect(meetingMsOf(FROM - 10, WINDOW)).toBe(0);
  });

  it('is the identity with no window', () => {
    expect(meetingMsOf(1234, null)).toBe(1234);
    expect(fileMsOf(1234, null)).toBe(1234);
  });
});

describe('the scrubber spans the window and nothing else', () => {
  it('is the window length for a closed window, whatever the file is', () => {
    expect(windowDurationMs(WINDOW, HOUR)).toBe(800_000);
    expect(windowDurationMs(WINDOW, null)).toBe(800_000);
  });

  it('runs to the end of the file for an open-ended window', () => {
    expect(windowDurationMs({ fromMs: FROM, toMs: null }, HOUR)).toBe(HOUR - FROM);
    expect(windowDurationMs({ fromMs: FROM, toMs: null }, null)).toBeNull();
  });

  it('is the whole file with no window', () => {
    expect(windowDurationMs(null, HOUR)).toBe(HOUR);
    expect(windowDurationMs(null, null)).toBeNull();
  });

  it('clamps a seek to the window', () => {
    expect(clampMeetingMs(-5, WINDOW, HOUR)).toBe(0);
    expect(clampMeetingMs(900_000, WINDOW, HOUR)).toBe(800_000);
    expect(clampMeetingMs(400_000, WINDOW, HOUR)).toBe(400_000);
  });

  it('clamps to the file when there is no window', () => {
    expect(clampMeetingMs(HOUR + 1, null, HOUR)).toBe(HOUR);
    expect(clampMeetingMs(HOUR + 1, null, null)).toBe(HOUR + 1);
  });
});

describe('playback stops at the end of the window', () => {
  it('is past the end at or after `to`', () => {
    expect(pastWindowEnd(TO - 1, WINDOW)).toBe(false);
    expect(pastWindowEnd(TO, WINDOW)).toBe(true);
    expect(pastWindowEnd(TO + 250, WINDOW)).toBe(true);
  });

  it('never stops an open-ended or absent window', () => {
    expect(pastWindowEnd(HOUR, { fromMs: FROM, toMs: null })).toBe(false);
    expect(pastWindowEnd(HOUR, null)).toBe(false);
  });
});

describe('the hole the source is left with', () => {
  const holes = holesOf(SOURCE, HOUR);

  it('is exactly the window that went away', () => {
    expect(holes).toEqual([{ fromMs: FROM, toMs: TO }]);
  });

  it('is half-open — `to` is back in this meeting', () => {
    expect(holeAt(holes, FROM - 1)).toBeNull();
    expect(holeAt(holes, FROM)).toEqual({ fromMs: FROM, toMs: TO });
    expect(holeAt(holes, TO - 1)).toEqual({ fromMs: FROM, toMs: TO });
    expect(holeAt(holes, TO)).toBeNull();
  });

  it('knows when a range crosses one', () => {
    expect(crossesHole(holes, 0, FROM)).toBe(false);
    expect(crossesHole(holes, 0, FROM + 1)).toBe(true);
    expect(crossesHole(holes, TO, HOUR)).toBe(false);
  });

  it('hangs the divider above the first utterance after the hole', () => {
    const utterances = [
      { start: 0, end: 90_000 },
      { start: 500_000, end: 900_000 },
      // 20:00–33:20 left with the split
      { start: 2_100_000, end: 2_400_000 },
      { start: 2_450_000, end: 3_500_000 },
    ];
    const map = holesBeforeUtterance(utterances, holes);
    expect([...map.keys()]).toEqual([2]);
    expect(map.get(2)).toEqual({ fromMs: FROM, toMs: TO });
  });

  it('drops a hole with nothing after it — there is no row to hang it on', () => {
    const utterances = [{ start: 0, end: 90_000 }];
    expect(holesBeforeUtterance(utterances, [{ fromMs: 200_000, toMs: 300_000 }]).size).toBe(0);
  });

  it('says nothing when there are no holes or no utterances', () => {
    expect(holesBeforeUtterance([{ start: 0, end: 1 }], []).size).toBe(0);
    expect(holesBeforeUtterance([], holes).size).toBe(0);
    expect(holesBeforeUtterance(null, holes).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-02: the server serves the window CUT (lib/clip-cut.ts), so the
// player's mapping is into the cut, starting at 0.
// ---------------------------------------------------------------------------

describe('the media the server serves — a cut that starts at 0', () => {
  it('the split-off meeting needs no window at all: the bytes ARE the meeting', () => {
    const served = servedPlaybackFromContext({ clips: SPLIT_OFF }, (TO - FROM) / 1000);
    expect(served.window).toBeNull();
    // Meeting ms == served ms, so a t: chip at 5:00 seeks to 5:00 of the cut.
    expect(fileMsOf(300_000, served.window)).toBe(300_000);
    expect(meetingMsOf(300_000, served.window)).toBe(300_000);
    // …unless the bytes turn out to be the whole file: then the old window.
    expect(served.wholeFileWindow).toEqual(WINDOW);
    expect(served.cutSpanMs).toBe(TO - FROM);
  });

  it('a meeting never split, and a source with a hole in the middle, are served whole', () => {
    for (const ctx of [{}, null, { clips: SOURCE }]) {
      expect(servedPlaybackFromContext(ctx, HOUR / 1000)).toEqual({
        window: null,
        wholeFileWindow: null,
        cutSpanMs: null,
      });
    }
  });

  it('a source whose split took its LAST minutes is cut at the end and maps 1:1', () => {
    const head: ClipWindow[] = [{ ord: 0, recordingId: RECORDING, fromMs: 0, toMs: FROM, offsetMs: 0 }];
    const served = servedPlaybackFromContext({ clips: head }, FROM / 1000);
    expect(served.window).toBeNull();
    expect(served.wholeFileWindow).toEqual({ fromMs: 0, toMs: FROM });
    expect(served.cutSpanMs).toBe(FROM);
  });

  it('a source whose split took its OPENING minutes keeps its timeline: the cut starts at meeting ms `to`', () => {
    // planSplit with from = 0: the source keeps only (to → end) at offset `to`.
    const tail: ClipWindow[] = [{ ord: 1, recordingId: RECORDING, fromMs: TO, toMs: null, offsetMs: TO }];
    const served = servedPlaybackFromContext({ clips: tail }, HOUR / 1000);
    expect(served.window).toEqual({ fromMs: -TO, toMs: null });
    // An utterance at meeting 40:00 is 6:40 into the cut, and back.
    expect(fileMsOf(2_400_000, served.window)).toBe(2_400_000 - TO);
    expect(meetingMsOf(2_400_000 - TO, served.window)).toBe(2_400_000);
    // The cut's first second IS meeting `to` — the captions line up from 0.
    expect(meetingMsOf(0, served.window)).toBe(TO);
    // The scrubber still spans the meeting's own timeline (its hole included).
    expect(windowDurationMs(served.window, HOUR - TO)).toBe(HOUR);
    expect(served.cutSpanMs).toBe(HOUR - TO);
  });

  it('a clip part of a combined meeting plays its whole cut', () => {
    const parts = [
      { ord: 0, recordingId: RECORDING, fromMs: 0, toMs: null, offsetMs: 0 },
      { ord: 1, recordingId: OTHER, fromMs: FROM, toMs: TO, offsetMs: 600_000 },
    ];
    const windowed = servedPlaybackForPart(parts[1]!, parts);
    expect(windowed.window).toBeNull();
    expect(windowed.wholeFileWindow).toEqual(WINDOW);
    expect(windowed.cutSpanMs).toBe(TO - FROM);
    // A whole-recording part is served whole, exactly as before.
    expect(servedPlaybackForPart(parts[0]!, parts)).toEqual({
      window: null,
      wholeFileWindow: null,
      cutSpanMs: null,
    });
  });

  it('two clips on one recording: each is its window INSIDE the shared cut', () => {
    const parts = [
      { ord: 0, recordingId: OTHER, fromMs: 100_000, toMs: 200_000, offsetMs: 0 },
      { ord: 1, recordingId: OTHER, fromMs: 500_000, toMs: 700_000, offsetMs: 100_000 },
    ];
    // The server cuts the bounds: 100 000 → 700 000.
    expect(servedPlaybackForPart(parts[0]!, parts).window).toEqual({ fromMs: 0, toMs: 100_000 });
    expect(servedPlaybackForPart(parts[1]!, parts).window).toEqual({ fromMs: 400_000, toMs: null });
  });

  it('windowInCut re-bases a window and drops it when it IS the cut', () => {
    const cut = { fromMs: FROM, toMs: TO };
    expect(windowInCut(WINDOW, cut)).toBeNull();
    expect(windowInCut(null, cut)).toBeNull();
    expect(windowInCut({ fromMs: FROM + 1000, toMs: TO - 1000 }, cut)).toEqual({
      fromMs: 1000,
      toMs: TO - FROM - 1000,
    });
    expect(windowInCut({ fromMs: FROM, toMs: null }, { fromMs: FROM, toMs: null })).toBeNull();
  });

  it('recognises a whole file served where the cut was expected (stale cache / old server)', () => {
    const span = TO - FROM;
    expect(servedIsWholeFile(span + 180, span)).toBe(false); // a copy's trailing frame
    expect(servedIsWholeFile(HOUR, span)).toBe(true);
    expect(servedIsWholeFile(HOUR, null)).toBe(false); // unknown span: trust the cut
    expect(servedIsWholeFile(null, span)).toBe(false);
  });
});

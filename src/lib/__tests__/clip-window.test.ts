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
  windowDurationMs,
  windowFromContext,
  windowOfClips,
  type PlaybackWindow,
} from '@/lib/clip-window';
import { holesOf, type ClipWindow } from '@/lib/clips';

const RECORDING = '33333333-aaaa-4aaa-8aaa-333333333333';
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

/**
 * The pure half of the server-side clip cut (lib/clip-cut.ts): what counts as
 * windowed, the cache key, the ffmpeg argument lists, the keyframe-safety and
 * exactness verdicts, and the frame refusal. The ffmpeg run itself is
 * src/lib/server/__tests__/clip-cut-ffmpeg.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildConcatArgs,
  buildCutArgs,
  clipCutStem,
  clipMirrorNeedsCut,
  concatListBody,
  cutAttempts,
  cutIsExact,
  cutPlanOf,
  cutWindowOf,
  estimateCutBytes,
  expectedCutMs,
  expectedPlanMs,
  frameRefusal,
  isKeyframeSafe,
  keyframesFromProbe,
  secs,
} from '@/lib/clip-cut';

const FROM = 1_200_000; // 20:00
const TO = 2_000_000; // 33:20
const HOUR = 3_600_000;

describe('cutWindowOf — the bounds as one window', () => {
  test('bounds over the whole file are no window (a hole in the middle is cutPlanOf’s business)', () => {
    expect(cutWindowOf({ windowFromMs: null, windowToMs: null })).toBeNull();
    expect(cutWindowOf({ windowFromMs: 0, windowToMs: null })).toBeNull();
  });

  test('a window with a start, an end, or both is cut', () => {
    expect(cutWindowOf({ windowFromMs: FROM, windowToMs: TO })).toEqual({ fromMs: FROM, toMs: TO });
    expect(cutWindowOf({ windowFromMs: FROM, windowToMs: null })).toEqual({ fromMs: FROM, toMs: null });
    expect(cutWindowOf({ windowFromMs: 0, windowToMs: TO })).toEqual({ fromMs: 0, toMs: TO });
    expect(cutWindowOf({ windowFromMs: null, windowToMs: TO })).toEqual({ fromMs: 0, toMs: TO });
  });

  test('fractional ms are rounded so the cache key is stable', () => {
    expect(cutWindowOf({ windowFromMs: 1000.4, windowToMs: 5000.6 })).toEqual({ fromMs: 1000, toMs: 5001 });
  });
});

describe('clipCutStem — the cache key', () => {
  const base = {
    meetingId: 'abc-123_X',
    sourceFilename: 'rec-1.mp4',
    segments: [{ fromMs: FROM, toMs: TO }],
    variant: 'av' as const,
  };

  test('clips/<meeting>/<variant>.<from>-<to>.<src8>', () => {
    const k = clipCutStem(base);
    expect(k.dir).toBe('clips/abc-123_X');
    expect(k.stem).toMatch(/^av\.1200000-2000000\.[0-9a-f]{8}$/);
  });

  test('an open-ended window says "end"', () => {
    expect(clipCutStem({ ...base, segments: [{ fromMs: FROM, toMs: null }] }).stem).toMatch(/^av\.1200000-end\./);
  });

  test('everything that decides the bytes changes the key', () => {
    const k = clipCutStem(base).stem;
    expect(clipCutStem({ ...base, segments: [{ fromMs: FROM + 1, toMs: TO }] }).stem).not.toBe(k);
    expect(clipCutStem({ ...base, segments: [{ fromMs: FROM, toMs: TO + 1 }] }).stem).not.toBe(k);
    expect(clipCutStem({ ...base, sourceFilename: 'rec-2.mp4' }).stem).not.toBe(k);
    expect(clipCutStem({ ...base, variant: 'audio' }).stem).not.toBe(k);
    expect(clipCutStem({ ...base, meetingId: 'other' }).dir).not.toBe(clipCutStem(base).dir);
    // …and nothing else does: same inputs, same key.
    expect(clipCutStem({ ...base }).stem).toBe(k);
  });

  test('a crafted meeting id or a nonsense window never becomes a path', () => {
    expect(() => clipCutStem({ ...base, meetingId: '../etc' })).toThrow();
    expect(() => clipCutStem({ ...base, meetingId: 'a/b' })).toThrow();
    expect(() => clipCutStem({ ...base, segments: [{ fromMs: -1, toMs: TO }] })).toThrow();
    expect(() => clipCutStem({ ...base, segments: [{ fromMs: TO, toMs: FROM }] })).toThrow();
  });

  test('a hole in the middle: EVERY kept segment is in the key, `_`-joined', () => {
    const holed = clipCutStem({ ...base, segments: [{ fromMs: 0, toMs: FROM }, { fromMs: TO, toMs: null }] });
    expect(holed.stem).toMatch(/^av\.0-1200000_2000000-end\.[0-9a-f]{8}$/);
    // A different hole, or the same bounds without a hole, is a different cut.
    expect(
      clipCutStem({ ...base, segments: [{ fromMs: 0, toMs: FROM + 1 }, { fromMs: TO, toMs: null }] }).stem
    ).not.toBe(holed.stem);
    expect(clipCutStem({ ...base, segments: [{ fromMs: 0, toMs: null }] }).stem).not.toBe(holed.stem);
  });

  test('a plan that is not canonical is refused, never named', () => {
    const plan = (segments: Array<{ fromMs: number; toMs: number | null }>) => () =>
      clipCutStem({ ...base, segments });
    expect(plan([])).toThrow();
    expect(plan([{ fromMs: 0, toMs: null }, { fromMs: TO, toMs: null }])).toThrow(); // open end not last
    expect(plan([{ fromMs: TO, toMs: HOUR }, { fromMs: 0, toMs: FROM }])).toThrow(); // out of order
    expect(plan([{ fromMs: 0, toMs: FROM }, { fromMs: FROM, toMs: TO }])).toThrow(); // touching: merge them
    expect(plan([{ fromMs: 0, toMs: TO }, { fromMs: FROM, toMs: HOUR }])).toThrow(); // overlapping
  });
});

describe('cutPlanOf — which files are served cut, and as what', () => {
  test('a whole file (never split, or split with keepInBoth) is served as itself', () => {
    expect(cutPlanOf({ windowFromMs: null, windowToMs: null })).toBeNull();
    expect(cutPlanOf({ windowFromMs: null, windowToMs: null, keptMs: null })).toBeNull();
    // One kept segment is the bounds, nothing more.
    expect(cutPlanOf({ windowFromMs: null, windowToMs: null, keptMs: [{ fromMs: 0, toMs: null }] })).toBeNull();
  });

  test('a window is one segment', () => {
    expect(cutPlanOf({ windowFromMs: FROM, windowToMs: TO })).toEqual([{ fromMs: FROM, toMs: TO }]);
    expect(cutPlanOf({ windowFromMs: 1000.4, windowToMs: 5000.6 })).toEqual([{ fromMs: 1000, toMs: 5001 }]);
  });

  test('a source with a hole in the MIDDLE is cut too — the kept segments, in order', () => {
    // Bounds 0 → end (it still "spans" the file), but the middle is not its.
    const source = {
      windowFromMs: null,
      windowToMs: null,
      keptMs: [
        { fromMs: 0, toMs: FROM },
        { fromMs: TO, toMs: null },
      ],
    };
    expect(cutPlanOf(source)).toEqual([
      { fromMs: 0, toMs: FROM },
      { fromMs: TO, toMs: null },
    ]);
  });
});

describe('joining the segments of a hole cut', () => {
  const reencode = { mode: 'reencode-video', output: 'av', ext: 'mp4', format: 'mp4' } as const;

  test('the concat demuxer, stream-copied into the attempt’s container', () => {
    const args = buildConcatArgs({ list: '/c/x.list.1.tmp', out: '/c/x.mp4.1.tmp', attempt: reencode });
    const joined = args.join(' ');
    expect(joined).toContain('-f concat -safe 0 -i /c/x.list.1.tmp');
    expect(joined).toContain('-map 0 -c copy');
    expect(joined).toContain('-movflags +faststart');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/c/x.mp4.1.tmp']);
    const wav = buildConcatArgs({ list: 'l', out: 'o', attempt: { mode: 'copy', output: 'audio', ext: 'wav', format: 'wav' } });
    expect(wav).not.toContain('-movflags');
  });

  test('the list file quotes every path, a quote inside one included', () => {
    expect(concatListBody(['/a/s0.tmp', "/b/it's.tmp"])).toBe("file '/a/s0.tmp'\nfile '/b/it'\\''s.tmp'\n");
  });

  test('the expected length of a plan is the sum of its segments', () => {
    const plan = [
      { fromMs: 0, toMs: FROM },
      { fromMs: TO, toMs: null },
    ];
    expect(expectedPlanMs(plan, HOUR)).toBe(FROM + (HOUR - TO));
    expect(expectedPlanMs(plan, null)).toBeNull(); // open end, unknown file
    expect(expectedPlanMs([{ fromMs: FROM, toMs: TO }], null)).toBe(TO - FROM);
  });
});

describe('estimateCutBytes — the offline plan’s size before the cut exists', () => {
  test('the stored size in proportion to the kept time', () => {
    expect(estimateCutBytes({ sourceBytes: 3_600_000, sourceDurationMs: HOUR, segments: [{ fromMs: FROM, toMs: TO }] })).toBe(
      800_000
    );
    const holed = [
      { fromMs: 0, toMs: FROM },
      { fromMs: TO, toMs: null },
    ];
    expect(estimateCutBytes({ sourceBytes: 3_600_000, sourceDurationMs: HOUR, segments: holed })).toBe(
      3_600_000 - 800_000
    );
  });

  test('unknown when either length is', () => {
    expect(estimateCutBytes({ sourceBytes: null, sourceDurationMs: HOUR, segments: [{ fromMs: 0, toMs: 1 }] })).toBeNull();
    expect(estimateCutBytes({ sourceBytes: 5, sourceDurationMs: null, segments: [{ fromMs: 0, toMs: 1 }] })).toBeNull();
    expect(estimateCutBytes({ sourceBytes: 5, sourceDurationMs: 0, segments: [{ fromMs: 0, toMs: 1 }] })).toBeNull();
  });
});

describe('clipMirrorNeedsCut — the sweeper’s filter, off the row', () => {
  const R = '33333333-aaaa-4aaa-8aaa-333333333333';
  const S = '44444444-bbbb-4bbb-8bbb-444444444444';

  test('no mirror, a whole recording, or two whole recordings: nothing to cut', () => {
    expect(clipMirrorNeedsCut(null)).toBe(false);
    expect(clipMirrorNeedsCut({})).toBe(false);
    expect(clipMirrorNeedsCut({ clips: [{ ord: 0, recordingId: R, fromMs: 0, toMs: null, offsetMs: 0 }] })).toBe(false);
    expect(
      clipMirrorNeedsCut({
        clips: [
          { ord: 0, recordingId: R, fromMs: 0, toMs: null, offsetMs: 0 },
          { ord: 1, recordingId: S, fromMs: 0, toMs: null, offsetMs: 5000 },
        ],
      })
    ).toBe(false);
  });

  test('a window, or a hole in the middle, needs a cut', () => {
    expect(clipMirrorNeedsCut({ clips: [{ ord: 0, recordingId: R, fromMs: FROM, toMs: TO, offsetMs: 0 }] })).toBe(true);
    expect(
      clipMirrorNeedsCut({
        clips: [
          { ord: 0, recordingId: R, fromMs: 0, toMs: FROM, offsetMs: 0 },
          { ord: 1, recordingId: R, fromMs: TO, toMs: null, offsetMs: TO },
        ],
      })
    ).toBe(true);
    // Touching clips are one stretch: the whole file, no cut.
    expect(
      clipMirrorNeedsCut({
        clips: [
          { ord: 0, recordingId: R, fromMs: 0, toMs: FROM, offsetMs: 0 },
          { ord: 1, recordingId: R, fromMs: FROM, toMs: null, offsetMs: FROM },
        ],
      })
    ).toBe(false);
  });
});

describe('cutAttempts — what to try, best first', () => {
  test('video, keyframe-safe: stream copy into its own container, re-encode as the fallback', () => {
    const a = cutAttempts({ sourceFilename: 'm.mp4', sourceHasVideo: true, variant: 'av', audioCodec: 'aac', keyframeSafe: true });
    expect(a.map((x) => x.mode)).toEqual(['copy', 'reencode-video']);
    expect(a[0]).toMatchObject({ ext: 'mp4', format: 'mp4', output: 'av' });
    expect(a[1]).toMatchObject({ ext: 'mp4', format: 'mp4', output: 'av' });
  });

  test('video, NOT keyframe-safe: never a copy (it would carry the previous GOP)', () => {
    const a = cutAttempts({ sourceFilename: 'm.webm', sourceHasVideo: true, variant: 'av', audioCodec: 'opus', keyframeSafe: false });
    expect(a.map((x) => x.mode)).toEqual(['reencode-video']);
  });

  test('a webm copy stays webm', () => {
    const a = cutAttempts({ sourceFilename: 'm.webm', sourceHasVideo: true, variant: 'av', audioCodec: 'opus', keyframeSafe: true });
    expect(a[0]).toMatchObject({ mode: 'copy', ext: 'webm', format: 'webm' });
  });

  test('?variant=audio of a video: copy into m4a only for AAC on a keyframe-safe start, else re-encode', () => {
    expect(
      cutAttempts({ sourceFilename: 'm.mp4', sourceHasVideo: true, variant: 'audio', audioCodec: 'aac', keyframeSafe: true }).map((x) => x.mode)
    ).toEqual(['copy', 'reencode-audio']);
    // The demuxer seeks a video container to the VIDEO keyframe, so an
    // audio-only copy would start there too.
    expect(
      cutAttempts({ sourceFilename: 'm.mp4', sourceHasVideo: true, variant: 'audio', audioCodec: 'aac', keyframeSafe: false }).map((x) => x.mode)
    ).toEqual(['reencode-audio']);
    const opus = cutAttempts({ sourceFilename: 'm.webm', sourceHasVideo: true, variant: 'audio', audioCodec: 'opus', keyframeSafe: false });
    expect(opus.map((x) => x.mode)).toEqual(['reencode-audio']);
    expect(opus[0]).toMatchObject({ ext: 'm4a', output: 'audio' });
  });

  test('an audio file: -c copy into its own container, re-encode to m4a when not exact', () => {
    const m4a = cutAttempts({ sourceFilename: 'a.m4a', sourceHasVideo: false, variant: 'av', audioCodec: 'aac', keyframeSafe: true });
    expect(m4a).toEqual([
      { mode: 'copy', output: 'audio', ext: 'm4a', format: 'mp4' },
      { mode: 'reencode-audio', output: 'audio', ext: 'm4a', format: 'mp4' },
    ]);
    expect(cutAttempts({ sourceFilename: 'a.mp3', sourceHasVideo: false, variant: 'av', audioCodec: 'mp3', keyframeSafe: true })[0]).toMatchObject({ ext: 'mp3', format: 'mp3' });
    // An unknown container has no copy target at all.
    expect(cutAttempts({ sourceFilename: 'a.bin', sourceHasVideo: false, variant: 'av', audioCodec: null, keyframeSafe: true }).map((x) => x.mode)).toEqual(['reencode-audio']);
  });
});

describe('buildCutArgs — the window → ffmpeg argument builder', () => {
  const copyAv = { mode: 'copy', output: 'av', ext: 'mp4', format: 'mp4' } as const;

  test('input seek before -i, duration after it, stream copy, zero-based, faststart', () => {
    const args = buildCutArgs({ src: '/s/in.mp4', out: '/c/out.mp4.tmp', window: { fromMs: FROM, toMs: TO }, attempt: copyAv, audioTracks: 'first' });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '1200.000']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-i') + 1]).toBe('/s/in.mp4');
    expect(args[args.indexOf('-t') + 1]).toBe('800.000');
    expect(args.indexOf('-t')).toBeGreaterThan(args.indexOf('-i'));
    expect(args).toContain('copy');
    expect(args.join(' ')).toContain('-map 0:v:0? -map 0:a?');
    expect(args.join(' ')).toContain('-avoid_negative_ts make_zero');
    expect(args.join(' ')).toContain('-movflags +faststart');
    expect(args.slice(-3)).toEqual(['-f', 'mp4', '/c/out.mp4.tmp']);
  });

  test('a window from 0 has no seek; an open-ended one has no duration', () => {
    const head = buildCutArgs({ src: 's', out: 'o', window: { fromMs: 0, toMs: 5000 }, attempt: copyAv, audioTracks: 'first' });
    expect(head).not.toContain('-ss');
    expect(head[head.indexOf('-t') + 1]).toBe('5.000');
    const tail = buildCutArgs({ src: 's', out: 'o', window: { fromMs: 5000, toMs: null }, attempt: copyAv, audioTracks: 'first' });
    expect(tail).toContain('-ss');
    expect(tail).not.toContain('-t');
  });

  test('the video fallback re-encodes H.264 + AAC', () => {
    const args = buildCutArgs({ src: 's', out: 'o', window: { fromMs: 3000, toMs: 7000 }, attempt: { mode: 'reencode-video', output: 'av', ext: 'mp4', format: 'mp4' }, audioTracks: 'first' }).join(' ');
    expect(args).toContain('-c:v libx264 -preset veryfast');
    expect(args).toContain('-c:a aac');
    expect(args).not.toContain('-c copy');
  });

  test('audio renditions drop video; the soundtrack variant is the mix only, mono 64k on re-encode', () => {
    const variant = buildCutArgs({ src: 's', out: 'o', window: { fromMs: 1000, toMs: 2000 }, attempt: { mode: 'reencode-audio', output: 'audio', ext: 'm4a', format: 'mp4' }, audioTracks: 'first' }).join(' ');
    expect(variant).toContain('-map 0:a:0 -vn');
    expect(variant).toContain('-ac 1 -b:a 64k');
    const source = buildCutArgs({ src: 's', out: 'o', window: { fromMs: 1000, toMs: 2000 }, attempt: { mode: 'copy', output: 'audio', ext: 'wav', format: 'wav' }, audioTracks: 'all' }).join(' ');
    expect(source).toContain('-map 0:a? -vn');
    expect(source).toContain('-c copy');
    expect(source).not.toContain('faststart'); // not an ISO-BMFF output
  });

  test('seconds are formatted with three decimals, never exponent notation', () => {
    expect(secs(1)).toBe('0.001');
    expect(secs(36_000_000)).toBe('36000.000');
    expect(secs(-5)).toBe('0.000');
  });
});

describe('keyframe safety', () => {
  test('the top of the file is always safe', () => {
    expect(isKeyframeSafe({ fromMs: 0, keyframePtsSec: [], startTimeSec: null })).toBe(true);
  });

  test('a keyframe on the window start (within one frame) is safe', () => {
    expect(isKeyframeSafe({ fromMs: 4000, keyframePtsSec: [2, 4], startTimeSec: 0 })).toBe(true);
    expect(isKeyframeSafe({ fromMs: 4000, keyframePtsSec: [4.04], startTimeSec: 0 })).toBe(true);
  });

  test('a keyframe BEFORE the start is not — a copy would begin there', () => {
    expect(isKeyframeSafe({ fromMs: 3000, keyframePtsSec: [2, 4], startTimeSec: 0 })).toBe(false);
    expect(isKeyframeSafe({ fromMs: 3000, keyframePtsSec: [], startTimeSec: 0 })).toBe(false);
  });

  test('presentation times are counted from the file start time, as -ss does', () => {
    expect(isKeyframeSafe({ fromMs: 4000, keyframePtsSec: [5.5], startTimeSec: 1.5 })).toBe(true);
    expect(isKeyframeSafe({ fromMs: 4000, keyframePtsSec: [4], startTimeSec: 1.5 })).toBe(false);
  });

  test('ffprobe packet JSON → keyframe times; junk is ignored', () => {
    expect(
      keyframesFromProbe({
        packets: [
          { pts_time: '2.000000', flags: 'K__' },
          { pts_time: '2.040000', flags: '___' },
          { pts_time: 'N/A', flags: 'K__' },
          { pts_time: '4.000000', flags: 'K_' },
        ],
      })
    ).toEqual([2, 4]);
    expect(keyframesFromProbe(null)).toEqual([]);
    expect(keyframesFromProbe({ packets: 'nope' })).toEqual([]);
  });
});

describe('is the copy exact?', () => {
  test('expected length: the window, clipped to the file', () => {
    expect(expectedCutMs({ fromMs: 3000, toMs: 7000 }, 10_000)).toBe(4000);
    expect(expectedCutMs({ fromMs: 3000, toMs: 70_000 }, 10_000)).toBe(7000);
    expect(expectedCutMs({ fromMs: 3000, toMs: null }, 10_000)).toBe(7000);
    expect(expectedCutMs({ fromMs: 3000, toMs: 7000 }, null)).toBe(4000);
    expect(expectedCutMs({ fromMs: 3000, toMs: null }, null)).toBeNull();
  });

  test('within packet slack is exact; a copy that grabbed the previous GOP is not', () => {
    expect(cutIsExact({ actualMs: 4017, expectedMs: 4000 })).toBe(true);
    expect(cutIsExact({ actualMs: 4180, expectedMs: 4000 })).toBe(true);
    expect(cutIsExact({ actualMs: 5180, expectedMs: 4000 })).toBe(false); // keyframe 1 s early
    expect(cutIsExact({ actualMs: 2000, expectedMs: 4000 })).toBe(false);
  });

  test('an empty or unreadable output is never exact; an unknown expectation accepts any real output', () => {
    expect(cutIsExact({ actualMs: null, expectedMs: 4000 })).toBe(false);
    expect(cutIsExact({ actualMs: 0, expectedMs: null })).toBe(false);
    expect(cutIsExact({ actualMs: 1234, expectedMs: null })).toBe(true);
  });

  test('long windows get proportional slack (0.5 %)', () => {
    const hour = 3_600_000;
    expect(cutIsExact({ actualMs: hour + 15_000, expectedMs: hour })).toBe(true);
    expect(cutIsExact({ actualMs: hour + 30_000, expectedMs: hour })).toBe(false);
  });
});

describe('frameRefusal — frames outside the meeting are refused', () => {
  const windowed = { windowFromMs: FROM, windowToMs: TO };

  test('inside the window is served', () => {
    expect(frameRefusal({ media: windowed, fileMs: FROM, meetingMs: 0 })).toBeNull();
    expect(frameRefusal({ media: windowed, fileMs: TO - 1, meetingMs: TO - FROM - 1 })).toBeNull();
  });

  test('before the window, and from its end on (half-open), is refused', () => {
    expect(frameRefusal({ media: windowed, fileMs: FROM - 1, meetingMs: 0 })).toBe('before-window');
    expect(frameRefusal({ media: windowed, fileMs: TO, meetingMs: TO - FROM })).toBe('after-window');
    expect(frameRefusal({ media: windowed, fileMs: TO + 60_000, meetingMs: TO - FROM + 60_000 })).toBe('after-window');
  });

  test('a whole file serves every moment — except a hole split off into another meeting', () => {
    const whole = { windowFromMs: null, windowToMs: null };
    expect(frameRefusal({ media: whole, fileMs: 0, meetingMs: 0 })).toBeNull();
    const holes = [{ fromMs: FROM, toMs: TO }];
    expect(frameRefusal({ media: whole, fileMs: FROM, meetingMs: FROM, holes })).toBe('in-hole');
    expect(frameRefusal({ media: whole, fileMs: TO, meetingMs: TO, holes })).toBeNull();
    expect(frameRefusal({ media: whole, fileMs: FROM - 1, meetingMs: FROM - 1, holes })).toBeNull();
  });
});

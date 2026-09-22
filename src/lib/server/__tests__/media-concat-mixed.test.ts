/**
 * The stitch, on real ffmpeg output.
 *
 * Darth Recorder 0.3.15 lets a person add a video source to an audio-only
 * recording mid-call, so a group can be `part1.m4a · part2.mp4 · part3.m4a ·
 * part4.mp4`. Until 2026-09-22 the re-encode branch decided on `allVideo`, so
 * one audio-only part made the whole output audio-only — ffmpeg exited 0, the
 * log said the usual "(re-encoded — mixed codecs)", and the window the person
 * had deliberately added was gone. The same graph mapped `[i:a:0]` only,
 * dropping the mic track of every multi-track file.
 *
 * Everything below runs the real binaries on 1–2 s lavfi inputs generated
 * here, and is skipped when ffmpeg/ffprobe are not on PATH.
 *
 * `mock.module` is process-wide, so only `server-only` is stubbed — this
 * module touches no db.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

mock.module('server-only', () => ({}));

const ffmpeg = Bun.which('ffmpeg');
const ffprobe = Bun.which('ffprobe');
const haveFfmpeg = !!ffmpeg && !!ffprobe;

const storage = mkdtempSync(path.join(tmpdir(), 'mw-media-concat-'));
process.env.MW_STORAGE_DIR = storage;
const audioDir = path.join(storage, 'audio');

const { concatMediaSmart, concatMediaReencodeToTemp } = await import('@/lib/server/media-concat');

const abs = (name: string) => path.join(audioDir, name);
const ff = (...args: string[]) => execFileSync(ffmpeg!, ['-v', 'error', '-y', ...args]);

/** ffprobe → the output's streams, in file order. */
function streamsOf(name: string): Array<{ codec_type: string; duration?: string }> {
  const out = execFileSync(ffprobe!, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type',
    '-of', 'json',
    abs(name),
  ]).toString();
  return (JSON.parse(out).streams ?? []) as Array<{ codec_type: string }>;
}

/** Bun's toBeCloseTo(x, 1) means ±0.05 — these are seconds, so say ±0.2. */
function expectNear(actual: number, expected: number, tol = 0.2): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

function durationOf(name: string): number {
  const out = execFileSync(ffprobe!, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    abs(name),
  ]).toString();
  return Number(out.trim());
}

/** Seconds of picture in the output — the video stream's own duration. */
function videoDurationOf(name: string): number {
  const out = execFileSync(ffprobe!, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'csv=p=0',
    abs(name),
  ]).toString();
  return Number(out.trim());
}

/** Mean volume (dB) of one audio stream — how a track is told from its peers. */
function meanVolumeOf(name: string, track: number): number {
  const proc = Bun.spawnSync([
    ffmpeg!,
    '-v', 'info',
    '-i', abs(name),
    '-map', `0:a:${track}`,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);
  const log = proc.stderr.toString();
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
  if (!m) throw new Error(`no mean_volume for track ${track} of ${name}: ${log.slice(-400)}`);
  return Number(m[1]);
}

beforeAll(() => {
  if (!haveFfmpeg) return;
  mkdirSync(audioDir, { recursive: true });
  // Two audio-only parts (the phone/audio-only legs of a tray recording).
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', abs('a1.m4a'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=520:duration=2:sample_rate=48000', '-c:a', 'aac', abs('a2.m4a'));
  // Two window parts: identical signature, so the all-video case can take the
  // stream-copy fast path.
  for (const [name, pattern] of [
    ['v1.mp4', 'testsrc=size=320x240:rate=15:duration=2'],
    ['v2.mp4', 'testsrc2=size=320x240:rate=15:duration=2'],
  ] as const) {
    ff(
      '-f', 'lavfi', '-i', pattern,
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      abs(name)
    );
  }
  // A tray-shaped part: three audio tracks (mix, system, mic), each a
  // different 20 dB step down so the output's track ORDER is readable.
  ff(
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
    '-filter_complex', '[0:a]volume=1.0[t0];[1:a]volume=0.1[t1];[2:a]volume=0.01[t2]',
    '-map', '[t0]', '-map', '[t1]', '-map', '[t2]',
    '-c:a', 'aac',
    abs('t3.m4a')
  );
});

afterAll(() => {
  rmSync(storage, { recursive: true, force: true });
});

describe.skipIf(!haveFfmpeg)('stitching parts that are not all the same kind', () => {
  test('audio + video + audio + video → ONE mp4 whose picture spans the whole thing', async () => {
    const logged: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    let out: { filename: string; reencoded: boolean };
    try {
      out = await concatMediaSmart(['a1.m4a', 'v1.mp4', 'a2.m4a', 'v2.mp4']);
    } finally {
      console.log = realLog;
    }

    expect(out.reencoded).toBe(true);
    expect(out.filename.endsWith('.mp4')).toBe(true);

    const streams = streamsOf(out.filename);
    // One picture, and exactly as many audio streams as the widest part had.
    expect(streams.filter((s) => s.codec_type === 'video').length).toBe(1);
    expect(streams.filter((s) => s.codec_type === 'audio').length).toBe(1);
    // …and the picture covers the audio-only spans too (4 × 2 s), which is
    // the whole point: before the fix there was no video stream at all.
    expectNear(durationOf(out.filename), 8);
    expectNear(videoDurationOf(out.filename), 8);

    expect(
      logged.some((l) =>
        l.includes('[concat] mixed parts: 2 audio-only, 2 video — black video synthesised')
      )
    ).toBe(true);
  }, 120_000);

  test('all-audio parts still produce an m4a with no video stream', async () => {
    const name = await concatMediaReencodeToTemp(['a1.m4a', 'a2.m4a']);
    expect(name.endsWith('.m4a')).toBe(true);
    const streams = streamsOf(name);
    expect(streams.filter((s) => s.codec_type === 'video').length).toBe(0);
    expect(streams.filter((s) => s.codec_type === 'audio').length).toBe(1);
    expectNear(durationOf(name), 4);
  }, 120_000);

  test('mixed-rate audio-only parts go through concatMediaSmart as an m4a', async () => {
    // Different sample rates → the signature probe refuses the fast path.
    const out = await concatMediaSmart(['a1.m4a', 'a2.m4a']);
    expect(out.reencoded).toBe(true);
    expect(out.filename.endsWith('.m4a')).toBe(true);
  }, 120_000);

  test('all-video, one signature → the fast path is still taken (no re-encode)', async () => {
    const out = await concatMediaSmart(['v1.mp4', 'v2.mp4']);
    expect(out.reencoded).toBe(false);
    expect(out.filename.endsWith('.mp4')).toBe(true);
    expectNear(durationOf(out.filename), 4);
  }, 120_000);

  test('a 3-track part keeps its 3 tracks, track 0 first, when stitched with a 1-track part', async () => {
    const name = await concatMediaReencodeToTemp(['t3.m4a', 'a1.m4a']);
    const streams = streamsOf(name);
    expect(streams.filter((s) => s.codec_type === 'audio').length).toBe(3);
    expectNear(durationOf(name), 4);
    // The 20 dB steps are still in their original order: the loud mix is
    // track 0. (Track 1/2 carry silence for the 1-track part's span, which
    // lowers both by the same ~3 dB and cannot reorder them.)
    const v0 = meanVolumeOf(name, 0);
    const v1 = meanVolumeOf(name, 1);
    const v2 = meanVolumeOf(name, 2);
    expect(v0).toBeGreaterThan(v1 + 10);
    expect(v1).toBeGreaterThan(v2 + 10);
  }, 120_000);

  test('a video part followed by a 3-track audio part keeps picture AND all tracks', async () => {
    const out = await concatMediaSmart(['v1.mp4', 't3.m4a']);
    expect(out.reencoded).toBe(true);
    expect(out.filename.endsWith('.mp4')).toBe(true);
    const streams = streamsOf(out.filename);
    expect(streams.filter((s) => s.codec_type === 'video').length).toBe(1);
    expect(streams.filter((s) => s.codec_type === 'audio').length).toBe(3);
    expectNear(durationOf(out.filename), 4);
  }, 120_000);
});

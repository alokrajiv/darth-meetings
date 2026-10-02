/**
 * The server-side clip cut against REAL ffmpeg (lib/server/clip-cut.ts): a
 * synthetic 10 s tone and a 10 s test-card video with a keyframe every 2 s,
 * cut to windows, and the result measured with ffprobe. The hole cases (M1)
 * use fixtures that are silent except INSIDE the hole, so a cut that leaks a
 * single packet of it is audibly loud.
 *
 * Skips cleanly when ffmpeg/ffprobe are not installed. Everything lives in a
 * temp MW_STORAGE_DIR; nothing touches a database or the real storage dir.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSql } from '@/db-ops/__tests__/helpers/fake-sql';

const sql = createFakeSql(() => []);
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));

const HAVE_FFMPEG =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

const { ensureClipCut, clipCutWithin, dropClipCuts, clipCutRoot, findClipCut } = await import('@/lib/server/clip-cut');
const { precutMeeting } = await import('@/lib/server/clip-precut');

let storage = '';
const prevStorage = process.env.MW_STORAGE_DIR;

function durationMs(path: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  return Math.round(Number.parseFloat(out.toString().trim()) * 1000);
}

function streams(path: string): string[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path]);
  return out.toString().trim().split('\n').filter(Boolean);
}

beforeAll(() => {
  if (!HAVE_FFMPEG) return;
  storage = mkdtempSync(join(tmpdir(), 'clip-cut-'));
  process.env.MW_STORAGE_DIR = storage;
  const audio = join(storage, 'audio');
  mkdirSync(audio, { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:a', 'aac', '-b:a', '64k', join(audio, 'tone.m4a'),
  ]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', join(audio, 'card.mp4'),
  ]);
  // The HOLE fixtures: silent everywhere except a loud tone well inside
  // 3 s → 7 s — the stretch a split took away. A cut that leaks any of the
  // hole is loud; one that does not is silence.
  const holeTone = "aevalsrc='if(between(t,3.3,6.7),0.8*sin(2*PI*440*t),0)':s=44100:d=10";
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', holeTone,
    '-c:a', 'aac', '-b:a', '64k', join(audio, 'hole.m4a'),
  ]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=10',
    '-f', 'lavfi', '-i', holeTone,
    '-c:v', 'libx264', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', join(audio, 'hole.mp4'),
  ]);
});

/** Loudest sample of a file's audio, dB (≈ −91 for digital silence). */
function maxVolumeDb(path: string): number {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr.toString());
  if (!m) throw new Error(`no volumedetect output for ${path}`);
  return m[1] === '-inf' ? -Infinity : Number.parseFloat(m[1]!);
}

/** The source meeting of the hole fixtures: 0 → 3 s and 7 s → end kept. */
const HOLE = [
  { fromMs: 0, toMs: 3000 },
  { fromMs: 7000, toMs: null },
];

afterAll(() => {
  if (storage) rmSync(storage, { recursive: true, force: true });
  if (prevStorage === undefined) delete process.env.MW_STORAGE_DIR;
  else process.env.MW_STORAGE_DIR = prevStorage;
});

describe.skipIf(!HAVE_FFMPEG)('clip cut with real ffmpeg', () => {
  test('a 10 s tone cut to 2–6 s is 4 s long, cached under clips/<meeting>/', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-tone',
      sourceFilename: 'tone.m4a',
      segments: [{ fromMs: 2000, toMs: 6000 }],
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.path.startsWith(join(clipCutRoot(), 'mtg-tone') + '/')).toBe(true);
    expect(r.path).toMatch(/\/av\.2000-6000\.[0-9a-f]{8}\.m4a$/);
    expect(r.contentType).toBe('audio/mp4');
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(150);
  });

  test('an open-ended window runs to the end of the file', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-tone',
      sourceFilename: 'tone.m4a',
      segments: [{ fromMs: 7000, toMs: null }],
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(Math.abs(durationMs(r.path) - 3000)).toBeLessThan(150);
  });

  test('concurrent requests share ONE ffmpeg and one file; the next one is a cache hit', async () => {
    const req = {
      meetingId: 'mtg-lock',
      sourceFilename: 'tone.m4a',
      segments: [{ fromMs: 1000, toMs: 4000 }],
      variant: 'av' as const,
      part: 1,
    };
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    };
    let results;
    try {
      results = await Promise.all([ensureClipCut(req), ensureClipCut(req), ensureClipCut(req)]);
      const again = await ensureClipCut(req);
      results.push(again);
    } finally {
      console.log = orig;
    }
    const paths = new Set(results.map((r) => (r.status === 'ready' ? r.path : r.status)));
    expect(paths.size).toBe(1);
    expect(logs.filter((l) => l.startsWith('[clip-cut]')).length).toBe(1);
    expect(readdirSync(join(clipCutRoot(), 'mtg-lock')).filter((n) => !n.endsWith('.tmp')).length).toBe(1);
  });

  test('?variant=audio of an AUDIO file is the same cut as the plain one', async () => {
    const base = { meetingId: 'mtg-tone', sourceFilename: 'tone.m4a', segments: [{ fromMs: 2000, toMs: 6000 }], part: 1 };
    const a = await ensureClipCut({ ...base, variant: 'av' });
    const b = await ensureClipCut({ ...base, variant: 'audio' });
    expect(a.status === 'ready' && b.status === 'ready' && a.path === b.path).toBe(true);
  });

  test('video, window on a keyframe (4 s): stream copy, exact length, still has video', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-video',
      sourceFilename: 'card.mp4',
      segments: [{ fromMs: 4000, toMs: 8000 }],
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.contentType).toBe('video/mp4');
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(300);
    expect(streams(r.path)).toContain('video');
  });

  test('video, window BETWEEN keyframes (3 s): re-encoded, so it does not start at the 2 s keyframe', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-video',
      sourceFilename: 'card.mp4',
      segments: [{ fromMs: 3000, toMs: 7000 }],
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    // A copy would have been ~5 s (from the keyframe at 2 s).
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(300);
    expect(streams(r.path)).toEqual(expect.arrayContaining(['video', 'audio']));
  });

  test('?variant=audio of a video: an m4a of the window, no video stream', async () => {
    const r = await clipCutWithin(
      {
        meetingId: 'mtg-video',
        sourceFilename: 'card.mp4',
        segments: [{ fromMs: 3000, toMs: 7000 }],
        variant: 'audio',
        part: 1,
      },
      60_000
    );
    expect(r?.status).toBe('ready');
    if (r?.status !== 'ready') return;
    expect(r.path).toMatch(/\/audio\.3000-7000\.[0-9a-f]{8}\.m4a$/);
    expect(r.contentType).toBe('audio/mp4');
    expect(streams(r.path)).toEqual(['audio']);
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(150);
  });

  test('?variant=audio of a video on a keyframe (4 s): an exact stream copy', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-video',
      sourceFilename: 'card.mp4',
      segments: [{ fromMs: 4000, toMs: 8000 }],
      variant: 'audio',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(streams(r.path)).toEqual(['audio']);
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(150);
  });

  // ---- M1: a hole in the middle is cut OUT, not skipped ---------------------

  test('the hole fixtures are loud in the hole (so "silent" below means "not leaked")', () => {
    expect(maxVolumeDb(join(storage, 'audio', 'hole.m4a'))).toBeGreaterThan(-10);
    expect(maxVolumeDb(join(storage, 'audio', 'hole.mp4'))).toBeGreaterThan(-10);
  });

  test('audio, two kept segments: one file, 3 s + 3 s, every sample of the hole gone', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-hole',
      sourceFilename: 'hole.m4a',
      segments: HOLE,
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.path).toMatch(/\/av\.0-3000_7000-end\.[0-9a-f]{8}\.m4a$/);
    expect(Math.abs(durationMs(r.path) - 6000)).toBeLessThan(250);
    expect(maxVolumeDb(r.path)).toBeLessThan(-30);
    // No segment or list temp is left behind.
    expect(readdirSync(join(clipCutRoot(), 'mtg-hole')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  test('video, hole ending BETWEEN keyframes (7 s): every segment re-encoded, joined, still video', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-hole',
      sourceFilename: 'hole.mp4',
      segments: HOLE,
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.contentType).toBe('video/mp4');
    expect(Math.abs(durationMs(r.path) - 6000)).toBeLessThan(300);
    expect(streams(r.path)).toEqual(expect.arrayContaining(['video', 'audio']));
    expect(maxVolumeDb(r.path)).toBeLessThan(-30);
  });

  test('video, hole on keyframes (2 s → 8 s): both segments stream-copied, then joined', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    };
    let r;
    try {
      r = await ensureClipCut({
        meetingId: 'mtg-hole-kf',
        sourceFilename: 'hole.mp4',
        segments: [
          { fromMs: 0, toMs: 2000 },
          { fromMs: 8000, toMs: null },
        ],
        variant: 'av',
        part: 1,
        trigger: 'test',
      });
    } finally {
      console.log = orig;
    }
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(300);
    expect(streams(r.path)).toContain('video');
    expect(maxVolumeDb(r.path)).toBeLessThan(-30);
    const line = logs.find((l) => l.startsWith('[clip-cut]'));
    expect(line).toContain('0-2000_8000-end');
    expect(line).toContain('segments=2');
    expect(line).toContain('mode=copy');
    expect(line).toContain('via=test');
  });

  test('?variant=audio of the holed video: an m4a of the kept stretches, no video, no hole', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-hole',
      sourceFilename: 'hole.mp4',
      segments: HOLE,
      variant: 'audio',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(r.path).toMatch(/\/audio\.0-3000_7000-end\.[0-9a-f]{8}\.m4a$/);
    expect(streams(r.path)).toEqual(['audio']);
    expect(Math.abs(durationMs(r.path) - 6000)).toBeLessThan(250);
    expect(maxVolumeDb(r.path)).toBeLessThan(-30);
  });

  // ---- M2: the pre-cut makes them before anybody asks ----------------------

  test('precutMeeting makes every cut a holed meeting can be asked for; findClipCut then sees them', async () => {
    const R = '33333333-aaaa-4aaa-8aaa-333333333333';
    const media = {
      part: 1,
      mediaId: '',
      recordingId: '',
      filename: 'hole.m4a',
      isVideo: false,
      offsetMs: 0,
      durationMs: 10_000,
      transcribed: true,
      blobName: null,
      audioOnly: null,
      windowFromMs: null,
      windowToMs: null,
      keptMs: HOLE,
    };
    const req = { meetingId: 'mtg-precut', sourceFilename: 'hole.m4a', segments: HOLE, variant: 'av' as const, part: 1 };
    expect(await findClipCut(req)).toBeNull();
    const out = await precutMeeting('mtg-precut', 'split', {
      loadRow: async () => ({
        id: 1,
        assemblyai_id: 'mtg-precut',
        status: 'completed',
        duration: 10,
        local_audio_path: 'hole.m4a',
        clips: [
          { ord: 0, recordingId: R, fromMs: 0, toMs: 3000, offsetMs: 0 },
          { ord: 1, recordingId: R, fromMs: 7000, toMs: null, offsetMs: 7000 },
        ],
        video_parts: null,
      }),
      resolveMedia: async () => [media],
    });
    expect(out).toBe('done');
    const found = await findClipCut(req);
    expect(found?.path).toMatch(/\/mtg-precut\/av\.0-3000_7000-end\.[0-9a-f]{8}\.m4a$/);
    expect(found?.bytes).toBeGreaterThan(0);
    // ?variant=audio of an audio file is that same cut.
    expect((await findClipCut({ ...req, variant: 'audio' }))?.path).toBe(found!.path);
  });

  test('precutMeeting leaves a whole-recording meeting alone', async () => {
    const R = '33333333-aaaa-4aaa-8aaa-333333333333';
    let resolved = false;
    const out = await precutMeeting('mtg-whole', 'recording-make-meeting', {
      loadRow: async () => ({
        id: 2,
        assemblyai_id: 'mtg-whole',
        status: 'completed',
        duration: 10,
        local_audio_path: 'tone.m4a',
        clips: [{ ord: 0, recordingId: R, fromMs: 0, toMs: null, offsetMs: 0 }],
        video_parts: null,
      }),
      resolveMedia: async () => {
        resolved = true;
        return [];
      },
    });
    expect(out).toBe('skipped');
    expect(resolved).toBe(false);
    expect(existsSync(join(clipCutRoot(), 'mtg-whole'))).toBe(false);
  });

  test('a source that is not on this VM answers "missing" — never a whole-file fallback', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-gone',
      sourceFilename: 'not-here.mp4',
      segments: [{ fromMs: 1000, toMs: 2000 }],
      variant: 'av',
      part: 1,
    });
    expect(r.status).toBe('missing');
  });

  test('dropClipCuts removes the meeting’s cuts and nobody else’s', async () => {
    expect(existsSync(join(clipCutRoot(), 'mtg-tone'))).toBe(true);
    await dropClipCuts('mtg-tone');
    expect(existsSync(join(clipCutRoot(), 'mtg-tone'))).toBe(false);
    expect(existsSync(join(clipCutRoot(), 'mtg-video'))).toBe(true);
    await dropClipCuts('../audio'); // unsafe id: ignored
    expect(existsSync(join(storage, 'audio', 'tone.m4a'))).toBe(true);
  });
});

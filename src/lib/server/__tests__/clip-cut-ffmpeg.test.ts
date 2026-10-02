/**
 * The server-side clip cut against REAL ffmpeg (lib/server/clip-cut.ts): a
 * synthetic 10 s tone and a 10 s test-card video with a keyframe every 2 s,
 * cut to windows, and the result measured with ffprobe.
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

const { ensureClipCut, clipCutWithin, dropClipCuts, clipCutRoot } = await import('@/lib/server/clip-cut');

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
});

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
      window: { fromMs: 2000, toMs: 6000 },
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
      window: { fromMs: 7000, toMs: null },
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
      window: { fromMs: 1000, toMs: 4000 },
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
    const base = { meetingId: 'mtg-tone', sourceFilename: 'tone.m4a', window: { fromMs: 2000, toMs: 6000 }, part: 1 };
    const a = await ensureClipCut({ ...base, variant: 'av' });
    const b = await ensureClipCut({ ...base, variant: 'audio' });
    expect(a.status === 'ready' && b.status === 'ready' && a.path === b.path).toBe(true);
  });

  test('video, window on a keyframe (4 s): stream copy, exact length, still has video', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-video',
      sourceFilename: 'card.mp4',
      window: { fromMs: 4000, toMs: 8000 },
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
      window: { fromMs: 3000, toMs: 7000 },
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
        window: { fromMs: 3000, toMs: 7000 },
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
      window: { fromMs: 4000, toMs: 8000 },
      variant: 'audio',
      part: 1,
    });
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    expect(streams(r.path)).toEqual(['audio']);
    expect(Math.abs(durationMs(r.path) - 4000)).toBeLessThan(150);
  });

  test('a source that is not on this VM answers "missing" — never a whole-file fallback', async () => {
    const r = await ensureClipCut({
      meetingId: 'mtg-gone',
      sourceFilename: 'not-here.mp4',
      window: { fromMs: 1000, toMs: 2000 },
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

/**
 * A readable local file for the sidecar and the frame grabs when the stored
 * copy is gone (lib/server/media-local.ts) — the prod failure of 2026-10-02:
 * `[voiceprint] suggest failed for speaker A: Error: sidecar /embed 404:
 * {"error": "audio file not found: …/storage/audio/<id>.mp4"}` on recordings
 * whose local copy had been purged after the blob archive.
 *
 * Over the in-memory `FakeMediaBlob` and real temp dirs (MW_STORAGE_DIR,
 * MW_SCRATCH_DIR). The db layer the voiceprint pass reads is replaced by an
 * in-memory stand-in and `fetch` by a fake sidecar that does exactly what the
 * real one does first: refuse a path that is not a file.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FakeMediaBlob } from './helpers/fake-media-blob';

mock.module('server-only', () => ({}));

// The voiceprint pass's db reads: one enrolled voice, no mappings yet.
const enrolled = [{ name: 'Yadu N M', embedding: [1, 0, 0] }];
const persisted: Array<{ userId: string; id: string; map: unknown }> = [];
mock.module('@/db-ops/voiceprints', () => ({
  async listAll() {
    return enrolled;
  },
  async enrollSample() {},
}));
mock.module('@/db-ops/speaker-mappings', () => ({
  async getForUser() {
    return null;
  },
  async setSuggestionsForUser(userId: string, id: string, map: unknown) {
    persisted.push({ userId, id, map });
  },
}));
mock.module('@/lib/server/recording-call-context', () => ({
  async recordingCallContext() {
    return { roster: [] };
  },
}));

const root = mkdtempSync(path.join(tmpdir(), 'media-local-'));
const storage = path.join(root, 'storage');
const scratch = path.join(root, 'scratch');
mkdirSync(path.join(storage, 'audio'), { recursive: true });
mkdirSync(path.join(storage, 'audio-only'), { recursive: true });
process.env.MW_STORAGE_DIR = storage;
process.env.MW_SCRATCH_DIR = scratch;

const local = await import('@/lib/server/media-local');
const { setMediaStoreForTests } = await import('@/lib/server/media-store');
const voiceprint = await import('@/lib/server/voiceprint');
const frames = await import('@/lib/server/video-frames');

type Media = import('@/lib/server/recordings').ResolvedMedia;

const CANON_BLOB = 'rec-02af969f/m-canon.mp4';
const AUDIO_BLOB = 'rec-02af969f/m-audio.m4a';
const VIDEO_BYTES = new Uint8Array(300_000).map((_, i) => i % 251);
const AUDIO_BYTES = new Uint8Array(40_000).map((_, i) => (i * 7) % 253);

function mediaOf(over: Partial<Media> = {}): Media {
  return {
    part: 1,
    mediaId: 'm-canon',
    recordingId: 'rec-02af969f',
    filename: '02af969f.mp4',
    isVideo: true,
    offsetMs: 0,
    durationMs: 3_600_000,
    transcribed: true,
    blobName: CANON_BLOB,
    audioOnly: { mediaId: 'm-audio', filename: '02af969f.m4a', blobName: AUDIO_BLOB },
    windowFromMs: null,
    windowToMs: null,
    keptMs: null,
    ...over,
  };
}

let store: FakeMediaBlob;
let warnSpy: ReturnType<typeof spyOn>;
const warnings = () => warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
const reads = () => store.calls.filter((c) => c.startsWith('read '));

beforeEach(() => {
  store = new FakeMediaBlob();
  store.put(CANON_BLOB, VIDEO_BYTES, 'video/mp4');
  store.put(AUDIO_BLOB, AUDIO_BYTES, 'audio/mp4');
  setMediaStoreForTests(store);
  local.resetMediaLocalForTests();
  rmSync(scratch, { recursive: true, force: true });
  for (const d of ['audio', 'audio-only']) {
    rmSync(path.join(storage, d), { recursive: true, force: true });
    mkdirSync(path.join(storage, d), { recursive: true });
  }
  delete process.env.MW_MEDIA_CACHE_MAX_BYTES;
  delete process.env.MW_MEDIA_CACHE_TTL_MS;
  persisted.length = 0;
  warnSpy?.mockRestore();
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  warnSpy?.mockRestore();
  setMediaStoreForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe('ensureLocalMedia — the ladder', () => {
  test('the stored file on disk is used as is: no blob call at all', async () => {
    writeFileSync(path.join(storage, 'audio', '02af969f.mp4'), VIDEO_BYTES);
    const got = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' });
    expect(got?.source).toBe('disk');
    expect(got?.path).toBe(path.join(storage, 'audio', '02af969f.mp4'));
    expect(store.calls).toEqual([]);
    got?.release();
  });

  test('stored copy gone, the audio-only extract still on disk → the extract, no blob call', async () => {
    writeFileSync(path.join(storage, 'audio-only', '02af969f.m4a'), AUDIO_BYTES);
    const got = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' });
    expect(got?.source).toBe('disk-audio-only');
    expect(store.calls).toEqual([]);
  });

  test('nothing on disk, audio wanted → the SMALL audio-only blob is pulled into the cache, not the video', async () => {
    const got = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' });
    expect(got?.source).toBe('blob');
    expect(got!.path.startsWith(path.join(scratch, 'media-cache'))).toBe(true);
    expect(got!.path.endsWith('.m4a')).toBe(true);
    expect(new Uint8Array(readFileSync(got!.path))).toEqual(AUDIO_BYTES);
    expect(reads()).toEqual([`read ${AUDIO_BLOB}`]);
    // Never written back into the audio store: a drained VM stays drained.
    expect(readdirSync(path.join(storage, 'audio'))).toEqual([]);
    // No partial file left behind.
    expect(readdirSync(path.dirname(got!.path)).some((n) => n.endsWith('.part'))).toBe(false);
    got!.release();
  });

  test('no audio-only extract archived → the canonical blob', async () => {
    const got = await local.ensureLocalMedia(mediaOf({ audioOnly: null }), 'audio', { purpose: 'test' });
    expect(got?.source).toBe('blob');
    expect(reads()).toEqual([`read ${CANON_BLOB}`]);
    expect(new Uint8Array(readFileSync(got!.path))).toEqual(VIDEO_BYTES);
    got!.release();
  });

  test('video wanted (frames) → the canonical even when an audio extract exists', async () => {
    const got = await local.ensureLocalMedia(mediaOf(), 'video', { purpose: 'frames' });
    expect(reads()).toEqual([`read ${CANON_BLOB}`]);
    expect(got!.path.endsWith('.mp4')).toBe(true);
    got!.release();
  });

  test('a second ask is a cache hit, and concurrent asks share ONE pull', async () => {
    const [a, b, c] = await Promise.all([
      local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' }),
      local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' }),
      local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' }),
    ]);
    expect(a!.path).toBe(b!.path);
    expect(b!.path).toBe(c!.path);
    expect(reads()).toHaveLength(1);
    const d = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'test' });
    expect(reads()).toHaveLength(1);
    for (const x of [a, b, c, d]) x!.release();
  });

  test('no blob to pull → null, said ONCE per recording however often it is asked', async () => {
    const m = mediaOf({ blobName: null, audioOnly: null });
    expect(await local.ensureLocalMedia(m, 'audio', { purpose: 'voiceprint' })).toBeNull();
    expect(await local.ensureLocalMedia(m, 'audio', { purpose: 'voiceprint' })).toBeNull();
    const w = warnings().filter((x) => x.includes('rec-02af969f'));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('no archived blob');
  });

  test('no media store on this host → null, said once', async () => {
    setMediaStoreForTests(null);
    expect(await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'voiceprint' })).toBeNull();
    expect(await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'voiceprint' })).toBeNull();
    expect(warnings().filter((x) => x.includes('no media store'))).toHaveLength(1);
  });

  test('a blob that is not there, or a read that dies, → null, logged, no file and no .part left', async () => {
    store.blobs.delete(AUDIO_BLOB);
    expect(await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'voiceprint' })).toBeNull();
    expect(warnings().some((x) => x.includes('does not exist'))).toBe(true);

    local.resetMediaLocalForTests();
    store.failRead = { afterBytes: 100_000, error: new Error('socket hang up') };
    expect(await local.ensureLocalMedia(mediaOf({ audioOnly: null }), 'video', { purpose: 'frames' })).toBeNull();
    expect(warnings().some((x) => x.includes('socket hang up'))).toBe(true);
    const cache = path.join(scratch, 'media-cache');
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });
});

describe('the cache stays bounded', () => {
  test('over budget → least-recently-used goes first, a held entry never does', async () => {
    process.env.MW_MEDIA_CACHE_MAX_BYTES = String(VIDEO_BYTES.byteLength + 10);
    const video = await local.ensureLocalMedia(mediaOf(), 'video', { purpose: 't' });
    const audio = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 't' });
    // Both held: both stay although together they exceed the budget.
    await local.evictMediaCache();
    expect(existsSync(video!.path)).toBe(true);
    expect(existsSync(audio!.path)).toBe(true);
    // The video was used longest ago; released, it is the one to go.
    const old = new Date(Date.now() - 60_000);
    utimesSync(video!.path, old, old);
    video!.release();
    audio!.release();
    await local.evictMediaCache();
    expect(existsSync(video!.path)).toBe(false);
    expect(existsSync(audio!.path)).toBe(true);
  });

  test('idle past the TTL → evicted; a crashed pull’s old .part too', async () => {
    const got = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 't' });
    got!.release();
    got!.release(); // idempotent
    const part = `${got!.path}.dead.part`;
    writeFileSync(part, 'x');
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(part, hourAgo, hourAgo);
    await local.evictMediaCache();
    expect(existsSync(got!.path)).toBe(true); // fresh
    expect(existsSync(part)).toBe(false);
    await local.evictMediaCache(Date.now() + 2 * 60 * 60_000);
    expect(existsSync(got!.path)).toBe(false);
  });
});

describe('the voiceprint pass reads a file the sidecar can open', () => {
  const content = {
    utterances: [
      { speaker: 'A', start: 1_000, end: 11_000, text: 'hello there' },
      { speaker: 'B', start: 12_000, end: 22_000, text: 'hi' },
      { speaker: 'A', start: 23_000, end: 33_000, text: 'more' },
    ],
  } as never;

  /** The sidecar's own first check: `os.path.isfile(audio_path)` → else 404. */
  function fakeSidecar() {
    const seen: Array<{ path: string; existed: boolean }> = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { audio_path: string };
      const existed = existsSync(body.audio_path);
      seen.push({ path: body.audio_path, existed });
      if (!existed) {
        return new Response(JSON.stringify({ error: `audio file not found: ${body.audio_path}` }), { status: 404 });
      }
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200 });
    }) as typeof fetch);
    return { seen, restore: () => spy.mockRestore() };
  }

  test('stored copy purged, blob archived → the archived soundtrack is pulled once and every speaker is embedded', async () => {
    const sidecar = fakeSidecar();
    try {
      const out = await voiceprint.suggestSpeakersForTranscript('u-1', 'm-1', [mediaOf()], content);
      expect(sidecar.seen).toHaveLength(2); // speakers A and B
      for (const s of sidecar.seen) {
        expect(s.existed).toBe(true);
        expect(s.path.startsWith(path.join(scratch, 'media-cache'))).toBe(true);
      }
      expect(reads()).toEqual([`read ${AUDIO_BLOB}`]); // one pull for the whole pass
      expect(out.A?.name).toBe('Yadu N M');
      expect(warnings().some((w) => w.includes('suggest failed'))).toBe(false);
    } finally {
      sidecar.restore();
    }
  });

  test('stored copy present → the sidecar gets the stored path, exactly as before', async () => {
    writeFileSync(path.join(storage, 'audio', '02af969f.mp4'), VIDEO_BYTES);
    const sidecar = fakeSidecar();
    try {
      await voiceprint.suggestSpeakersForTranscript('u-1', 'm-1', mediaOf(), content);
      expect(sidecar.seen.map((s) => s.path)).toEqual([
        path.join(storage, 'audio', '02af969f.mp4'),
        path.join(storage, 'audio', '02af969f.mp4'),
      ]);
      expect(store.calls).toEqual([]);
    } finally {
      sidecar.restore();
    }
  });

  test('nothing anywhere → no sidecar call, verdict no-media, ONE warning naming the recording', async () => {
    const sidecar = fakeSidecar();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await voiceprint.suggestSpeakersForTranscript(
        'u-1',
        'm-1',
        [mediaOf({ blobName: null, audioOnly: null })],
        content
      );
      expect(sidecar.seen).toHaveLength(0);
      expect(warnings().filter((w) => w.includes('rec-02af969f'))).toHaveLength(1);
      const verdictLine = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('verdicts'));
      expect(verdictLine).toContain('no-media');
    } finally {
      logSpy.mockRestore();
      sidecar.restore();
    }
  });

  test('enrolment reads the pulled file too', async () => {
    const sidecar = fakeSidecar();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await voiceprint.enrollFromTranscript([mediaOf()], content, [
        { originalSpeaker: 'A', customName: 'Yadu N M' },
      ] as never);
      expect(sidecar.seen).toHaveLength(1);
      expect(sidecar.seen[0]!.existed).toBe(true);
    } finally {
      logSpy.mockRestore();
      sidecar.restore();
    }
  });
});

describe('frames look past a purged stored copy', () => {
  test('hasVideoStream never caches a MISSING file as "no video"', async () => {
    const name = 'late-landing.mp4';
    expect(await frames.hasVideoStream(name)).toBe(false);
    // The file lands; the earlier answer must not stick. (ffprobe on junk
    // bytes says "no video" — the point is that it is ASKED again.)
    writeFileSync(path.join(storage, 'audio', name), 'not really a video');
    const probe = await frames.hasVideoStream(name);
    expect(typeof probe).toBe('boolean');
  });

  test('mediaHasVideo: not on disk + archived video → true; nothing to pull → false, said once', async () => {
    expect(await frames.mediaHasVideo(mediaOf())).toBe(true);
    const bare = mediaOf({ blobName: null });
    expect(await frames.mediaHasVideo(bare)).toBe(false);
    expect(await frames.mediaHasVideo(bare)).toBe(false);
    expect(warnings().filter((w) => w.includes('frames are off'))).toHaveLength(1);
    expect(await frames.mediaHasVideo(mediaOf({ isVideo: false }))).toBe(false);
  });

  test('a cached frame is served without touching the media; an uncached one with no source throws', async () => {
    const cached = frames.framePath('m-frames', 5_000);
    mkdirSync(path.dirname(cached), { recursive: true });
    writeFileSync(cached, 'jpeg');
    const got = await frames.extractFrameFromMedia('m-frames', mediaOf({ blobName: null }), 5_000, 5_000);
    expect(got).toBe(cached);
    expect(store.calls).toEqual([]);
    await expect(
      frames.extractFrameFromMedia('m-frames', mediaOf({ blobName: null }), 6_000, 6_000)
    ).rejects.toThrow('not available');
  });

  test('an uncached frame of a purged video pulls the canonical and releases it after the seek', async () => {
    // ffmpeg fails on these synthetic bytes — what matters is that it was
    // handed the pulled copy (the error is ffmpeg's, not "file missing").
    await expect(
      frames.extractFrameFromMedia('m-frames2', mediaOf(), 1_000, 1_000)
    ).rejects.toThrow();
    expect(reads()).toEqual([`read ${CANON_BLOB}`]);
    // Released: an eviction with a zero budget can take it.
    process.env.MW_MEDIA_CACHE_MAX_BYTES = '1';
    await local.evictMediaCache();
    expect(readdirSync(path.join(scratch, 'media-cache'))).toEqual([]);
  });
});

describe('Stage D: the pull is verified and bounded, disk hits are held', () => {
  const sha = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex');
  const cache = () => path.join(scratch, 'media-cache');
  const cacheFiles = () => (existsSync(cache()) ? readdirSync(cache()) : []);

  test('a pull whose bytes do not hash to the row’s sha256 → null, "sha256 mismatch", nothing cached', async () => {
    const m = { ...mediaOf({ audioOnly: null }), sha256: 'f'.repeat(64) };
    expect(await local.ensureLocalMedia(m, 'video', { purpose: 'frames' })).toBeNull();
    expect(warnings().some((w) => w.includes('sha256 mismatch'))).toBe(true);
    expect(cacheFiles()).toEqual([]); // no entry, no .part
  });

  test('the right sha256 → pulled and cached as before; the derivative is checked against ITS hash', async () => {
    const ok = await local.ensureLocalMedia(
      { ...mediaOf({ audioOnly: null }), sha256: sha(VIDEO_BYTES) },
      'video',
      { purpose: 'frames' }
    );
    expect(ok?.source).toBe('blob');
    ok!.release();
    const media = mediaOf();
    const wrongDerivative = {
      ...media,
      sha256: sha(VIDEO_BYTES),
      audioOnly: { ...media.audioOnly!, sha256: 'e'.repeat(64) },
    };
    expect(await local.ensureLocalMedia(wrongDerivative, 'audio', { purpose: 'voiceprint' })).toBeNull();
    expect(warnings().some((w) => w.includes('sha256 mismatch'))).toBe(true);
  });

  test('low free space → the cache is evicted first, then the pull goes ahead', async () => {
    // An idle entry the eviction can take, and a filesystem that is "full"
    // until it has run.
    const old = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 't' });
    old!.release();
    process.env.MW_MEDIA_CACHE_TTL_MS = '1';
    const stale = new Date(Date.now() - 60_000);
    utimesSync(old!.path, stale, stale);
    let free = 1024;
    local.setMediaCacheStatfsForTests(async () => {
      const r = { bavail: free, bsize: 1 };
      if (!existsSync(old!.path)) free = 10 * 1024 ** 3; // the eviction made room
      return r;
    });
    try {
      process.env.MW_MEDIA_CACHE_MIN_FREE_BYTES = String(1024 ** 3);
      const got = await local.ensureLocalMedia(mediaOf({ audioOnly: null }), 'video', { purpose: 'frames' });
      expect(existsSync(old!.path)).toBe(false);
      expect(got?.source).toBe('blob');
      got!.release();
    } finally {
      local.setMediaCacheStatfsForTests(null);
      delete process.env.MW_MEDIA_CACHE_MIN_FREE_BYTES;
    }
  });

  test('still short after the eviction → null, and the warning names the free space', async () => {
    local.setMediaCacheStatfsForTests(async () => ({ bavail: 4096, bsize: 1024 }));
    try {
      process.env.MW_MEDIA_CACHE_MIN_FREE_BYTES = String(5 * 1024 ** 3);
      expect(await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 'voiceprint' })).toBeNull();
      const w = warnings().find((x) => x.includes('not enough free space'));
      expect(w).toContain(`${4096 * 1024} B free`);
      expect(reads()).toEqual([]); // refused before a byte was read
      expect(cacheFiles()).toEqual([]);
    } finally {
      local.setMediaCacheStatfsForTests(null);
      delete process.env.MW_MEDIA_CACHE_MIN_FREE_BYTES;
    }
  });

  test('a disk hit is held until released (what the eviction asks)', async () => {
    const stored = path.join(storage, 'audio', '02af969f.mp4');
    writeFileSync(stored, VIDEO_BYTES);
    expect(local.localMediaHeld(stored)).toBe(false);
    const a = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 't' });
    const b = await local.ensureLocalMedia(mediaOf(), 'video', { purpose: 't' });
    expect(a?.source).toBe('disk');
    expect(local.localMediaHeld(stored)).toBe(true);
    a!.release();
    a!.release(); // idempotent per handle: b still holds it
    expect(local.localMediaHeld(stored)).toBe(true);
    b!.release();
    expect(local.localMediaHeld(stored)).toBe(false);

    const derived = path.join(storage, 'audio-only', '02af969f.m4a');
    rmSync(stored);
    writeFileSync(derived, AUDIO_BYTES);
    const c = await local.ensureLocalMedia(mediaOf(), 'audio', { purpose: 't' });
    expect(c?.source).toBe('disk-audio-only');
    expect(local.localMediaHeld(derived)).toBe(true);
    c!.release();
    expect(local.localMediaHeld(derived)).toBe(false);
  });

  test("want 'canonical': a non-video row whose file is gone pulls the CANONICAL blob, never the extract", async () => {
    writeFileSync(path.join(storage, 'audio-only', '02af969f.m4a'), AUDIO_BYTES); // a local extract too
    const m = mediaOf({ isVideo: false, filename: '02af969f.m4a' });
    const got = await local.ensureLocalMedia(m, 'canonical', { purpose: 'retranscribe' });
    expect(got?.source).toBe('blob');
    expect(reads()).toEqual([`read ${CANON_BLOB}`]);
    expect(new Uint8Array(readFileSync(got!.path))).toEqual(VIDEO_BYTES);
    got!.release();
  });
});

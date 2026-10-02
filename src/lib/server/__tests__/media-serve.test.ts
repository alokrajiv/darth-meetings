/**
 * Serving media from blob (DEC-3 Stage B, docs/recordings-blob-spec.md) over
 * the in-memory `FakeMediaBlob`: who may be redirected and who may not, which
 * blob answers which request, what the 302 looks like, the Stage-D proxy with
 * Range — and that a SAS never reaches a log line.
 *
 * Nothing here touches Postgres or Azure. The scratch-Postgres half of the
 * proof (a real access check, a real resolver, a real route) lives in
 * `tmp/media-serve/`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeMediaBlob } from './helpers/fake-media-blob';
import {
  MEDIA_SAS_TTL_MS,
  MEDIA_VIA_HEADER,
  blobTargetFor,
  mediaFromBlobFlagOn,
  mediaRedirectDecision,
  mediaSasRedirect,
  parseRange,
  proxyBlobRange,
  redactSas,
  serveStore,
} from '../media-serve';
import { setMediaStoreForTests } from '../media-store';
import type { ResolvedMedia } from '../recordings';

function media(over: Partial<ResolvedMedia> = {}): ResolvedMedia {
  return {
    part: 1,
    mediaId: 'm1',
    recordingId: 'r1',
    filename: 'call.mp4',
    isVideo: true,
    offsetMs: 0,
    durationMs: 3_600_000,
    transcribed: true,
    blobName: 'r1/m1.mp4',
    audioOnly: null,
    ...over,
  };
}

function decision(
  query = '',
  headers: Record<string, string> = {},
  isBearer = false
): ReturnType<typeof mediaRedirectDecision> {
  return mediaRedirectDecision({
    searchParams: new URLSearchParams(query),
    headers: new Headers(headers),
    isBearer,
  });
}

// ---------------------------------------------------------------------------

describe('redactSas', () => {
  test('a SAS URL keeps its blob path and loses its signature', () => {
    const url =
      'https://darthmedia.blob.core.windows.net/meetings-media/r1/m1.mp4' +
      '?sv=2024-11-04&se=2026-09-22T12%3A00%3A00Z&sr=b&sp=r&sig=SECRETSIGNATURE%3D';
    const out = redactSas(url);
    expect(out).toBe(
      'https://darthmedia.blob.core.windows.net/meetings-media/r1/m1.mp4?<sas redacted>'
    );
    expect(out).not.toContain('sig=');
    expect(out).not.toContain('SECRET');
  });

  test('a URL with no query, and a plain blob name, are untouched', () => {
    expect(redactSas('https://x.blob.core.windows.net/c/a.mp4')).toBe(
      'https://x.blob.core.windows.net/c/a.mp4'
    );
    expect(redactSas('r1/m1.mp4')).toBe('r1/m1.mp4');
  });
});

describe('who may be redirected', () => {
  test('a plain browser request may', () => {
    expect(decision('')).toEqual({ redirect: true });
    expect(decision('variant=audio&part=3')).toEqual({ redirect: true });
  });

  test('?via=app never may — not even with redirect=1', () => {
    expect(decision('via=app')).toEqual({ redirect: false, reason: 'via=app' });
    expect(decision('via=app&redirect=1')).toEqual({ redirect: false, reason: 'via=app' });
  });

  test('the pin / probe header never may — and it is case-insensitive', () => {
    expect(decision('', { [MEDIA_VIA_HEADER]: 'app' })).toEqual({
      redirect: false,
      reason: 'via-app header',
    });
    expect(decision('redirect=1', { [MEDIA_VIA_HEADER]: 'APP' }).redirect).toBe(false);
    // Some other value is not the opt-out.
    expect(decision('', { [MEDIA_VIA_HEADER]: 'blob' })).toEqual({ redirect: true });
  });

  test('a darth-cli bearer stays on the app unless it asks', () => {
    expect(decision('', {}, true)).toEqual({ redirect: false, reason: 'darth-cli bearer' });
    expect(decision('redirect=1', {}, true)).toEqual({ redirect: true });
    // …and the header still wins over its own opt-in.
    expect(decision('redirect=1', { [MEDIA_VIA_HEADER]: 'app' }).redirect).toBe(false);
  });
});

describe('which blob answers', () => {
  test('the plain route takes the file’s own blob', () => {
    expect(blobTargetFor(media(), false)).toEqual({
      blobName: 'r1/m1.mp4',
      filename: 'call.mp4',
      bytes: null,
    });
  });

  test('unarchived media has no blob answer at all', () => {
    expect(blobTargetFor(media({ blobName: null }), false)).toBeNull();
    expect(blobTargetFor(media({ blobName: null }), true)).toBeNull();
  });

  test('?variant=audio takes the derivative’s OWN blob', () => {
    const m = media({
      audioOnly: { mediaId: 'm2', filename: 'call.m4a', blobName: 'r1/m2.m4a' },
    });
    expect(blobTargetFor(m, true)).toEqual({
      blobName: 'r1/m2.m4a',
      filename: 'call.m4a',
      bytes: null,
    });
    // …and never for the plain route, which wants the recording itself.
    expect(blobTargetFor(m, false)?.blobName).toBe('r1/m1.mp4');
  });

  test('a derivative that exists but is not archived falls back to the app', () => {
    const m = media({ audioOnly: { mediaId: 'm2', filename: 'call.m4a', blobName: null } });
    expect(blobTargetFor(m, true)).toBeNull();
  });

  test('a file with no video IS the audio — its own blob answers the variant', () => {
    const m = media({ filename: 'call.m4a', isVideo: false, blobName: 'r1/m1.m4a' });
    expect(blobTargetFor(m, true)).toEqual({
      blobName: 'r1/m1.m4a',
      filename: 'call.m4a',
      bytes: null,
    });
  });

  test('a video with no derivative yet keeps building it on the app (202)', () => {
    expect(blobTargetFor(media({ isVideo: true, audioOnly: null }), true)).toBeNull();
    // has_video unknown is treated like a video: we do not guess.
    expect(blobTargetFor(media({ isVideo: null, audioOnly: null }), true)).toBeNull();
  });
});

describe('the redirect', () => {
  const store = new FakeMediaBlob();

  test('302, read-only, one blob, ≤ 60 minutes, private and no-store', async () => {
    const before = Date.parse('2026-09-22T10:00:00.000Z');
    const res = await mediaSasRedirect(
      store,
      { blobName: 'r1/m1.mp4', filename: 'call.mp4', bytes: null },
      { now: () => before }
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toContain('/meetings-media/r1/m1.mp4?');
    expect(loc).toContain('sp=r'); // read, nothing else
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-type')).toBe('video/mp4');

    const se = new URL(loc).searchParams.get('se')!;
    expect(new Date(se).getTime() - before).toBe(MEDIA_SAS_TTL_MS);
    expect(MEDIA_SAS_TTL_MS).toBe(60 * 60_000);

    // The SAS was minted for exactly that blob with exactly `r`.
    expect(store.calls).toContain('sasUrl r1/m1.mp4 r');
  });

  test('the derivative redirect is typed as audio', async () => {
    const res = await mediaSasRedirect(store, {
      blobName: 'r1/m2.m4a',
      filename: 'call.m4a',
      bytes: null,
    });
    expect(res.headers.get('content-type')).toBe('audio/mp4');
  });
});

describe('parseRange', () => {
  test('the three shapes and the refusals', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-99999', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=0-1, 5-6', 1000)).toBeNull(); // multi-range: not ours
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=90-10', 1000)).toBe('unsatisfiable');
  });
});

describe('the Stage-D proxy', () => {
  let store: FakeMediaBlob;
  const target = { blobName: 'r1/m1.mp4', filename: 'call.mp4', bytes: null };

  beforeEach(() => {
    store = new FakeMediaBlob();
    store.put('r1/m1.mp4', new Uint8Array(1000).fill(7), 'video/mp4');
  });

  test('no range → 200 with the whole body', async () => {
    const res = (await proxyBlobRange(store, target, null))!;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('1000');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  test('a range → 206, the right slice, the right Content-Range', async () => {
    const res = (await proxyBlobRange(store, target, 'bytes=100-199'))!;
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(res.headers.get('content-length')).toBe('100');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  test('an impossible range → 416', async () => {
    const res = (await proxyBlobRange(store, target, 'bytes=5000-'))!;
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  test('a blob that is not there → null (the caller 404s)', async () => {
    expect(await proxyBlobRange(store, { ...target, blobName: 'r1/gone.mp4' }, null)).toBeNull();
  });
});

describe('the flag', () => {
  const saved = process.env.MW_MEDIA_FROM_BLOB;
  afterEach(() => {
    if (saved === undefined) delete process.env.MW_MEDIA_FROM_BLOB;
    else process.env.MW_MEDIA_FROM_BLOB = saved;
    setMediaStoreForTests(null);
  });

  test('unset / 0 / false → no store to serve from, whatever is configured', () => {
    const store = new FakeMediaBlob();
    setMediaStoreForTests(store);
    for (const v of [undefined, '0', 'false', 'FALSE', '']) {
      if (v === undefined) delete process.env.MW_MEDIA_FROM_BLOB;
      else process.env.MW_MEDIA_FROM_BLOB = v;
      expect(mediaFromBlobFlagOn()).toBe(false);
      expect(serveStore()).toBeNull();
    }
    process.env.MW_MEDIA_FROM_BLOB = '1';
    expect(mediaFromBlobFlagOn()).toBe(true);
    expect(serveStore()).toBe(store);
  });

  test('flag on but no media account → still nothing to serve from', () => {
    process.env.MW_MEDIA_FROM_BLOB = '1';
    setMediaStoreForTests(null);
    expect(serveStore()).toBeNull();
  });
});

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

/**
 * Stage C of DEC-3 — the rules, the server-side copy and the hand-off URL
 * (docs/recordings-blob-spec.md), over the two in-memory fakes.
 *
 * What is proven here: WHO may take the fast path (and, above all, who may
 * not — DEC-1's multi-track rule), that the copy never reads a byte through
 * this process, that nothing is stamped unless Azure agreed about size AND
 * hash, that a failed copy leaves no blob behind for the pull path to trip
 * over, and that the URL AssemblyAI is handed is a read-only SAS on the MEDIA
 * blob with a life of at most six hours.
 *
 * Also here: the INTENT rule — when a dying upload session's planned blob is
 * a leak worth deleting and when it is the recording itself.
 *
 * Everything that needs rows — the plan's ids, the row that comes out, the
 * background fetch, the sweeper's retry — is proven against a scratch
 * Postgres in `tmp/media-ingest/`. Nothing here touches Postgres or Azure, and
 * (like `same-file-gate.test.ts`) nothing but `server-only` is mocked, because
 * `mock.module` is process-wide.
 */

mock.module('server-only', () => ({}));

const { FakeBlob } = await import('./helpers/fake-blob');
const { FakeMediaBlob } = await import('./helpers/fake-media-blob');
const {
  AAI_SAS_TTL_MS,
  aaiFromBlobFlagOn,
  abandonedBlobOf,
  blobFastPathRefusal,
  blobIntentOf,
  copyTransitToMedia,
  planBlobIngest,
} = await import('@/lib/server/aai-from-blob');
const { copyBlockId, copyBlockPlan } = await import('@/lib/server/media-store');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31) % 251;
  return out;
}

const PLAN = {
  blobName: 'rec-1/media-1.m4a',
  recordingId: 'rec-1',
  mediaId: 'media-1',
  filename: 'meeting-1.m4a',
  sha256: '',
  bytes: 0,
};

describe('who may take the fast path', () => {
  const base = {
    multi: false,
    fromRecorder: false,
    tracks: null,
    sha256: 'a'.repeat(64),
    size: 1234,
    storedFilename: 'abc.m4a',
  };

  test('an ordinary single-file blob upload may', () => {
    expect(blobFastPathRefusal(base)).toBeNull();
  });

  test('a Darth Recorder upload that says nothing may NOT — it can be multi-track (DEC-1)', () => {
    // The whole reason Stage C exists is not having the bytes; whether a file
    // carries a separate mic track can only be answered by probing them. The
    // tray is the only producer of such files and says so on every upload.
    expect(blobFastPathRefusal({ ...base, fromRecorder: true })).toContain('multi-track');
  });

  test('...and MAY once it declares tracks.mixFirst (tray 0.3.12)', () => {
    // The tray writes the mix itself now, live, as audio track 0 (LiveMix),
    // so there is nothing left for the VM to do to the audio.
    expect(
      blobFastPathRefusal({ ...base, fromRecorder: true, tracks: { count: 3, mixFirst: true } })
    ).toBeNull();
  });

  test('mixFirst: false is still a refusal — an older tray, or a mix that missed a source', () => {
    expect(
      blobFastPathRefusal({ ...base, fromRecorder: true, tracks: { count: 2, mixFirst: false } })
    ).toContain('mixFirst');
    // A single-source recording says mixFirst: true (track 0 IS the whole
    // recording); it is the promise that matters, never the count.
    expect(
      blobFastPathRefusal({ ...base, fromRecorder: true, tracks: { count: 1, mixFirst: true } })
    ).toBeNull();
  });

  test('the declaration means nothing for anyone but a recorder upload', () => {
    // Nothing else produces multi-track files, so the rule never fires for
    // them either way — and a stray declaration cannot un-refuse a group.
    expect(blobFastPathRefusal({ ...base, tracks: { count: 2, mixFirst: false } })).toBeNull();
    expect(
      blobFastPathRefusal({ ...base, multi: true, fromRecorder: true, tracks: { count: 3, mixFirst: true } })
    ).toContain('stitched');
  });

  test('a part of a multi-file group may NOT — it is stitched on the VM first', () => {
    expect(blobFastPathRefusal({ ...base, multi: true })).toContain('stitched');
  });

  test('no hash, no size, no known extension: all refused', () => {
    expect(blobFastPathRefusal({ ...base, sha256: null })).toContain('sha256');
    expect(blobFastPathRefusal({ ...base, size: 0 })).toContain('size');
    expect(blobFastPathRefusal({ ...base, storedFilename: 'abc.bin' })).toContain('extension');
  });
});

describe('the flag and the accounts are lazy gates', () => {
  beforeEach(() => {
    delete process.env.MW_AAI_FROM_BLOB;
    delete process.env.DARTH_MEDIA_ACCOUNT;
  });

  test('unset / 0 / false all read as off', () => {
    expect(aaiFromBlobFlagOn()).toBe(false);
    process.env.MW_AAI_FROM_BLOB = '0';
    expect(aaiFromBlobFlagOn()).toBe(false);
    process.env.MW_AAI_FROM_BLOB = 'false';
    expect(aaiFromBlobFlagOn()).toBe(false);
    process.env.MW_AAI_FROM_BLOB = '1';
    expect(aaiFromBlobFlagOn()).toBe(true);
    delete process.env.MW_AAI_FROM_BLOB;
  });

  test('with the flag off the plan refuses before it reads anything', async () => {
    const out = await planBlobIngest('user-1', {
      placeholder_id: 'up-1',
      sha256: 'a'.repeat(64),
      size: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: { originalFilename: 'x.m4a' } as any,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('MW_AAI_FROM_BLOB');
  });

  test('flag on but no media account: still refused, still no row read', async () => {
    process.env.MW_AAI_FROM_BLOB = '1';
    const out = await planBlobIngest('user-1', {
      placeholder_id: 'up-1',
      sha256: 'a'.repeat(64),
      size: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: { originalFilename: 'x.m4a' } as any,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('media account');
    delete process.env.MW_AAI_FROM_BLOB;
  });
});

describe('the block plan of a server-side copy', () => {
  test('covers the file exactly, with equal-length ids', () => {
    const plan = copyBlockPlan(250, 100);
    expect(plan.map((b) => [b.offset, b.count])).toEqual([
      [0, 100],
      [100, 100],
      [200, 50],
    ]);
    expect(new Set(plan.map((b) => b.id.length)).size).toBe(1);
    expect(copyBlockId(0)).not.toBe(copyBlockId(1));
  });

  test('an empty plan for an empty file (the callers refuse those anyway)', () => {
    expect(copyBlockPlan(0)).toEqual([]);
  });
});

describe('transit → permanent, server-side', () => {
  const TRANSIT_BLOB = 'user-1/session-1/recording.m4a';
  let transit: InstanceType<typeof FakeBlob>;
  let media: InstanceType<typeof FakeMediaBlob>;
  let body: Uint8Array;
  let plan: typeof PLAN;

  beforeEach(() => {
    transit = new FakeBlob();
    media = new FakeMediaBlob();
    media.copySource(transit);
    body = bytes(4096);
    transit.put(TRANSIT_BLOB, body);
    plan = { ...PLAN, sha256: sha(body), bytes: body.byteLength };
  });

  test('the bytes land, stamped, and this process never reads one of them', async () => {
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(true);
    expect(media.blobs.get(plan.blobName)?.bytes).toEqual(body);
    expect(media.metadata.get(plan.blobName)).toEqual({ sha256: plan.sha256, kind: 'canonical' });
    // The VM asked for a URL and nothing else: no `read`, no `write`. That is
    // the whole point of the stage.
    expect(transit.calls.filter((c) => c.startsWith('read'))).toEqual([]);
    expect(media.calls.filter((c) => c.startsWith('putStream'))).toEqual([]);
    expect(transit.calls.some((c) => c === `sasUrl ${TRANSIT_BLOB} r`)).toBe(true);
  });

  test('AssemblyAI is handed a read-only SAS on the MEDIA blob, ≤ 6 h', async () => {
    const before = Date.now();
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const url = new URL(out.source.sasUrl);
    expect(url.hostname.startsWith(media.account)).toBe(true);
    expect(url.pathname).toBe(`/${media.container}/${plan.blobName}`);
    expect(url.searchParams.get('sp')).toBe('r');
    const expires = Date.parse(url.searchParams.get('se')!);
    expect(expires).toBeGreaterThan(before);
    expect(expires - before).toBeLessThanOrEqual(AAI_SAS_TTL_MS + 1000);
    expect(Date.parse(out.source.expiresAt)).toBe(expires);
  });

  test('a copy Azure refuses leaves nothing behind (the caller pulls instead)', async () => {
    media.failCopy = new Error('CannotVerifyCopySource');
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(false);
    expect(media.blobs.has(plan.blobName)).toBe(false);
    // The transit blob is untouched — that is what the pull path needs.
    expect(transit.blobs.get(TRANSIT_BLOB)?.bytes.byteLength).toBe(body.byteLength);
  });

  test('a short copy fails the verify and the half-blob is deleted', async () => {
    media.truncateOnCopy = 16;
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('verify failed');
    expect(media.blobs.has(plan.blobName)).toBe(false);
  });

  test('a stamp that does not stick fails the verify too — no hash, no hand-off', async () => {
    media.dropMetadataOnSet = true;
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(false);
    expect(media.blobs.has(plan.blobName)).toBe(false);
  });

  test('a failure message never carries a signature', async () => {
    media.failCopy = new Error(
      'PUT https://acct.blob.core.windows.net/meetings/x?sig=SECRET&sp=r failed'
    );
    const out = await copyTransitToMedia(media, transit, TRANSIT_BLOB, plan);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).not.toContain('SECRET');
      expect(out.error).toContain('<sas redacted>');
    }
  });
});

describe('what a dying upload session leaves in the media container', () => {
  const INTENT = {
    blobName: 'rec-9/media-9.mp4',
    recordingId: '11111111-1111-4111-8111-111111111111',
    mediaId: '22222222-2222-4222-8222-222222222222',
    at: '2026-09-22T00:00:00.000Z',
  };

  test('the intent is the plan, plus when the copy was about to start', () => {
    const before = Date.now();
    const intent = blobIntentOf({ ...PLAN, sha256: 'a'.repeat(64), bytes: 10 });
    expect(intent.blobName).toBe(PLAN.blobName);
    expect(intent.recordingId).toBe(PLAN.recordingId);
    expect(intent.mediaId).toBe(PLAN.mediaId);
    expect(Date.parse(intent.at)).toBeGreaterThanOrEqual(before);
    // No hash, no size, no filename: the queue only ever needs the name and
    // the two ids for its log line.
    expect(Object.keys(intent).sort()).toEqual(['at', 'blobName', 'mediaId', 'recordingId']);
  });

  test('a session that never took the fast path leaves nothing', () => {
    expect(abandonedBlobOf({ intent: null, claimed: [] })).toBeNull();
    expect(abandonedBlobOf({ intent: undefined, claimed: [] })).toBeNull();
  });

  test('a session that cleared its intent leaves nothing, claimed or not', () => {
    expect(abandonedBlobOf({ intent: null, claimed: [INTENT.blobName] })).toBeNull();
  });

  test('an intent nothing claims IS the leak — the blob is queued', () => {
    expect(abandonedBlobOf({ intent: INTENT, claimed: [] })).toEqual(INTENT);
    // Another meeting's blob in the list changes nothing.
    expect(abandonedBlobOf({ intent: INTENT, claimed: ['rec-8/media-8.mp4'] })).toEqual(INTENT);
  });

  test('an intent a LIVE media row claims is the recording — never queued', () => {
    // The crash-after-the-row case: the row was created, the clear never ran.
    // Deleting here would destroy the meeting's only copy of itself.
    expect(abandonedBlobOf({ intent: INTENT, claimed: [INTENT.blobName] })).toBeNull();
    expect(
      abandonedBlobOf({ intent: INTENT, claimed: ['rec-8/media-8.mp4', INTENT.blobName] })
    ).toBeNull();
  });

  test('a half-written intent is not something to delete by', () => {
    expect(abandonedBlobOf({ intent: { ...INTENT, blobName: '' }, claimed: [] })).toBeNull();
  });
});

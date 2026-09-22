/**
 * The media archive (DEC-3 Stage A, docs/recordings-blob-spec.md) over the
 * in-memory `FakeMediaBlob` and real temp files: the happy path, adopting a
 * blob a crashed run left behind, the two ways bytes can be wrong (a corrupted
 * blob, an upload that dies mid-stream), the lifecycle canary, the pacing rule
 * and the delete path.
 *
 * `media-archive.ts` is a `server-only` module that pulls db-ops in, so the
 * marker is stubbed and the db layer is replaced by an in-memory one — the
 * scratch-Postgres half of the proof lives in `tmp/media-archive/`. Nothing
 * here touches Postgres or Azure.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FakeMediaBlob } from './helpers/fake-media-blob';

mock.module('server-only', () => ({}));

// ---------------------------------------------------------------------------
// The in-memory stand-in for db-ops/recordings + the one `sql` query
// ---------------------------------------------------------------------------

type MediaRow = {
  id: string;
  recording_id: string;
  kind: string;
  ord: number;
  offset_ms: number | null;
  duration_ms: number | null;
  filename: string | null;
  blob_name: string | null;
  bytes: number | null;
  has_video: boolean | null;
  sha256: string | null;
  source_ref: Record<string, unknown> | null;
  of_media_id: string | null;
  created_at: string;
};

const db = {
  media: new Map<string, MediaRow>(),
  recordingSha: new Map<string, string>(),
  canaries: [] as Array<{ name: string; written_at: string; last_ok_at: string | null; missing_at: string | null }>,
  pendingDeletes: new Map<string, { blob_name: string; attempts: number; last_error: string | null }>(),
  clips: new Map<number, string[]>(),
  /** Set by the busy probe's stub. */
  busy: { ingesting: false, ai: false },
};

function resetDb() {
  db.media.clear();
  db.recordingSha.clear();
  db.canaries = [];
  db.pendingDeletes.clear();
  db.clips.clear();
  db.busy = { ingesting: false, ai: false };
}

mock.module('@/db-ops/recordings', () => ({
  // `media-archive.ts` pulls in audio-only → video-frames → the resolver,
  // which imports these two from the module being replaced here. They are
  // never called; without them the import graph fails to link.
  async loadMeetingRecordingGraph() {
    return { clips: [], recordings: [], transcriptions: [], media: [] };
  },
  async loadMeetingRecordingGraphs() {
    return new Map();
  },
  async getRecordingMediaById(id: string) {
    return db.media.get(id) ?? null;
  },
  async listRecordingMedia(ids: string[]) {
    return [...db.media.values()].filter((m) => ids.includes(m.recording_id));
  },
  async listMediaToArchive(limit: number) {
    return [...db.media.values()].filter((m) => m.filename && !m.blob_name).slice(0, limit);
  },
  async stampMediaArchived(id: string, p: { blobName: string; sha256: string; bytes: number }) {
    const row = db.media.get(id);
    if (!row) return false;
    row.blob_name = p.blobName;
    row.sha256 = p.sha256;
    row.bytes = p.bytes;
    return true;
  },
  async setRecordingSha256(recordingId: string, sha256: string) {
    db.recordingSha.set(recordingId, sha256);
    return true;
  },
  async listClipsForMeeting(transcriptId: number) {
    return (db.clips.get(transcriptId) ?? []).map((recording_id, ord) => ({ recording_id, ord }));
  },
  async listMediaBlobsForRecordings(ids: string[]) {
    return [...db.media.values()]
      .filter((m) => ids.includes(m.recording_id) && m.blob_name)
      .map((m) => ({ recording_id: m.recording_id, media_id: m.id, blob_name: m.blob_name! }));
  },
  async queueBlobDeletes(refs: Array<{ blob_name: string }>) {
    for (const r of refs) {
      if (!db.pendingDeletes.has(r.blob_name)) {
        db.pendingDeletes.set(r.blob_name, { blob_name: r.blob_name, attempts: 0, last_error: null });
      }
    }
    return refs.length;
  },
  async listPendingBlobDeletes(limit: number) {
    return [...db.pendingDeletes.values()].slice(0, limit);
  },
  async clearPendingBlobDelete(blobName: string) {
    db.pendingDeletes.delete(blobName);
  },
  async markPendingBlobDeleteFailed(blobName: string, error: string) {
    const row = db.pendingDeletes.get(blobName);
    if (row) {
      row.attempts += 1;
      row.last_error = error;
    }
  },
  async listMediaCanaries() {
    return [...db.canaries].sort((a, b) => Date.parse(a.written_at) - Date.parse(b.written_at));
  },
  async insertMediaCanary(name: string) {
    if (!db.canaries.some((c) => c.name === name)) {
      db.canaries.push({ name, written_at: new Date().toISOString(), last_ok_at: null, missing_at: null });
    }
  },
  async markMediaCanarySeen(name: string) {
    const c = db.canaries.find((x) => x.name === name);
    if (c) {
      c.last_ok_at = new Date().toISOString();
      c.missing_at = null;
    }
  },
  async markMediaCanaryMissing(name: string) {
    const c = db.canaries.find((x) => x.name === name);
    if (c) c.missing_at ??= new Date().toISOString();
  },
}));

// The only raw query the module makes is the busy probe.
mock.module('@/lib/db', () => ({
  sql: Object.assign(async () => [db.busy], { json: (v: unknown) => v }),
}));

const {
  archiveBudgetVerdict,
  archiveMedia,
  archiveShouldYield,
  blobsHeldByMeeting,
  canaryGate,
  deleteBlobsForRemovedRecordings,
  drainPendingBlobDeletes,
  localMediaPath,
  resetCanaryCache,
  CANARY_MIN_AGE_MS,
} = await import('@/lib/server/media-archive');
const { mediaBlobName, mediaContentType, setMediaStoreForTests } = await import(
  '@/lib/server/media-store'
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const storage = mkdtempSync(path.join(tmpdir(), 'mw-media-archive-'));
mkdirSync(path.join(storage, 'audio'), { recursive: true });
mkdirSync(path.join(storage, 'audio-only'), { recursive: true });
process.env.MW_STORAGE_DIR = storage;

afterAll(() => rmSync(storage, { recursive: true, force: true }));

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');

let store: FakeMediaBlob;

function mediaRow(over: Partial<MediaRow> = {}): MediaRow {
  const row: MediaRow = {
    id: randomUUID(),
    recording_id: randomUUID(),
    kind: 'canonical',
    ord: 0,
    offset_ms: 0,
    duration_ms: null,
    filename: null,
    blob_name: null,
    bytes: null,
    has_video: true,
    sha256: null,
    source_ref: null,
    of_media_id: null,
    created_at: new Date().toISOString(),
    ...over,
  };
  db.media.set(row.id, row);
  return row;
}

/** A media row whose bytes really exist under the temp storage dir. */
function withFile(over: Partial<MediaRow> = {}, size = 4096): { row: MediaRow; bytes: Buffer } {
  const name = `${randomUUID()}.mp4`;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const dir = over.kind === 'audio_only' ? 'audio-only' : 'audio';
  writeFileSync(path.join(storage, dir, over.filename ?? name), bytes);
  return { row: mediaRow({ filename: over.filename ?? name, ...over }), bytes };
}

beforeEach(() => {
  resetDb();
  resetCanaryCache();
  store = new FakeMediaBlob();
  setMediaStoreForTests(store);
  process.env.MW_MEDIA_ARCHIVE = '1';
});

// ---------------------------------------------------------------------------

describe('blob naming and content type', () => {
  test('`<recording_id>/<media_id><.ext>` — no user id, no filename', () => {
    expect(mediaBlobName('rec-1', 'med-2', 'a-very-private-title.MP4')).toBe('rec-1/med-2.mp4');
    expect(mediaBlobName('rec-1', 'med-2', 'noext')).toBe('rec-1/med-2');
    expect(mediaBlobName('rec-1', 'med-2', null)).toBe('rec-1/med-2');
  });
  test('content type comes from the extension', () => {
    expect(mediaContentType('x.mp4')).toBe('video/mp4');
    expect(mediaContentType('x.m4a')).toBe('audio/mp4');
    expect(mediaContentType('x.bin')).toBe('application/octet-stream');
  });
});

describe('archiveMedia — off', () => {
  test('the flag unset means not one store call', async () => {
    delete process.env.MW_MEDIA_ARCHIVE;
    const { row } = withFile();
    expect(await archiveMedia(row as never)).toEqual({ status: 'off' });
    expect(store.calls).toEqual([]);
  });
  test('no store configured means not one store call either', async () => {
    setMediaStoreForTests(null);
    const { row } = withFile();
    expect(await archiveMedia(row as never)).toEqual({ status: 'off' });
  });
});

describe('archiveMedia — happy path', () => {
  test('uploads, stamps the metadata, verifies, then stamps the row', async () => {
    const { row, bytes } = withFile();
    const out = await archiveMedia(row as never);
    expect(out.status).toBe('archived');
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);

    // The bytes that landed ARE the file.
    expect(Buffer.from(store.blobs.get(blobName)!.bytes)).toEqual(bytes);
    expect(store.blobs.get(blobName)!.contentType).toBe('video/mp4');
    expect(store.metadata.get(blobName)).toEqual({ sha256: sha(bytes), kind: 'canonical' });

    // …and only then is the row stamped.
    expect(db.media.get(row.id)!.blob_name).toBe(blobName);
    expect(db.media.get(row.id)!.sha256).toBe(sha(bytes));
    expect(db.media.get(row.id)!.bytes).toBe(bytes.length);

    // Stage A.6: recordings.sha256 IS the canonical media's sha256.
    expect(db.recordingSha.get(row.recording_id)).toBe(sha(bytes));

    // Stage A: the local file is NEVER removed.
    expect(statSync(localMediaPath(row as never)!).size).toBe(bytes.length);
  });

  test('a derivative is archived too, from the audio-only dir, and does not touch recordings.sha256', async () => {
    const name = `${randomUUID()}.m4a`;
    const { row, bytes } = withFile({ kind: 'audio_only', filename: name }, 512);
    const out = await archiveMedia(row as never);
    expect(out.status).toBe('archived');
    const blobName = mediaBlobName(row.recording_id, row.id, name);
    expect(store.metadata.get(blobName)).toEqual({ sha256: sha(bytes), kind: 'audio_only' });
    expect(db.recordingSha.has(row.recording_id)).toBe(false);
  });

  test('an already-stamped row is a no-op (one HEAD, no upload)', async () => {
    const { row } = withFile();
    await archiveMedia(row as never);
    const putsAfterFirst = store.calls.filter((c) => c.startsWith('putStream')).length;
    const again = await archiveMedia(db.media.get(row.id) as never);
    expect(again).toMatchObject({ status: 'skipped', reason: 'already archived' });
    expect(store.calls.filter((c) => c.startsWith('putStream')).length).toBe(putsAfterFirst);
  });

  test('a file rewritten after the stamp (faststart remux) is archived again on the next hook', async () => {
    const { row, bytes } = withFile();
    const first = await archiveMedia(row as never);
    expect(first.status).toBe('archived');
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);

    // The remux moves the moov atom: a few KB longer, different bytes.
    const rewritten = Buffer.concat([Buffer.from(bytes), Buffer.from('moov-moved-here')]);
    writeFileSync(localMediaPath(row as never)!, rewritten);

    const again = await archiveMedia(db.media.get(row.id) as never);
    expect(again).toMatchObject({ status: 'archived', blobName, bytes: rewritten.length, sha256: sha(rewritten) });
    expect(Buffer.from(store.blobs.get(blobName)!.bytes)).toEqual(rewritten);
    expect(db.media.get(row.id)!.sha256).toBe(sha(rewritten));
    expect(db.media.get(row.id)!.bytes).toBe(rewritten.length);
  });

  test('same size, different bytes: only a rehash notices; a plain hook trusts the size', async () => {
    const { row, bytes } = withFile();
    await archiveMedia(row as never);
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);
    const flipped = Buffer.from(bytes);
    flipped[0] = flipped[0]! ^ 0xff;
    writeFileSync(localMediaPath(row as never)!, flipped);

    expect(await archiveMedia(db.media.get(row.id) as never)).toMatchObject({
      status: 'skipped',
      reason: 'already archived',
    });
    const again = await archiveMedia(db.media.get(row.id) as never, { rehash: true });
    expect(again).toMatchObject({ status: 'archived', sha256: sha(flipped) });
    expect(Buffer.from(store.blobs.get(blobName)!.bytes)).toEqual(flipped);
    // and a rehash of an unchanged file is still a no-op
    expect(await archiveMedia(db.media.get(row.id) as never, { rehash: true })).toMatchObject({
      status: 'skipped',
      reason: 'already archived',
    });
  });

  test('a row with no local file is skipped, not failed', async () => {
    const row = mediaRow({ filename: 'nothing-here.mp4' });
    expect(await archiveMedia(row as never)).toMatchObject({
      status: 'skipped',
      reason: 'no local file to archive',
    });
    const noName = mediaRow();
    expect(await archiveMedia(noName as never)).toMatchObject({ status: 'skipped' });
  });
});

describe('archiveMedia — idempotence and failures', () => {
  test('a blob a crashed run left behind is ADOPTED, not re-uploaded', async () => {
    const { row, bytes } = withFile();
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);
    store.put(blobName, new Uint8Array(bytes), 'video/mp4');
    await store.setMetadata(blobName, { sha256: sha(bytes), kind: 'canonical' });
    store.calls.length = 0;

    const out = await archiveMedia(row as never);
    expect(out).toMatchObject({ status: 'adopted', blobName, bytes: bytes.length, sha256: sha(bytes) });
    // (the canary writes a blob of its own on first enable — only this one
    // must not have been re-uploaded)
    expect(store.calls).not.toContain(`putStream ${blobName}`);
    expect(db.media.get(row.id)!.sha256).toBe(sha(bytes));
  });

  test('a blob of the right size but the wrong hash is re-uploaded, not adopted', async () => {
    const { row, bytes } = withFile();
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);
    const wrong = Buffer.from(bytes);
    wrong[0] = wrong[0]! ^ 0xff;
    store.put(blobName, new Uint8Array(wrong), 'video/mp4');
    await store.setMetadata(blobName, { sha256: sha(wrong), kind: 'canonical' });

    const out = await archiveMedia(row as never);
    expect(out.status).toBe('archived');
    expect(Buffer.from(store.blobs.get(blobName)!.bytes)).toEqual(bytes);
    expect(db.media.get(row.id)!.sha256).toBe(sha(bytes));
  });

  test('a blob that comes back the wrong size is NOT stamped', async () => {
    const { row } = withFile();
    store.truncateOnPut = 16;
    const out = await archiveMedia(row as never);
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.error).toContain('verify failed');
    expect(db.media.get(row.id)!.blob_name).toBeNull();
    expect(db.media.get(row.id)!.sha256).toBeNull();
    expect(db.recordingSha.size).toBe(0);
  });

  test('a sha256 stamp that did not stick is NOT stamped on the row either', async () => {
    const { row } = withFile();
    store.dropMetadataOnSet = true;
    const out = await archiveMedia(row as never);
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.error).toContain('verify failed');
    expect(db.media.get(row.id)!.blob_name).toBeNull();
    // …and the next run (with the store behaving) completes it.
    store.dropMetadataOnSet = false;
    expect((await archiveMedia(db.media.get(row.id) as never)).status).toBe('archived');
    expect(db.media.get(row.id)!.sha256).toBeTruthy();
  });

  test('an interrupted upload leaves nothing committed; the next run starts clean and succeeds', async () => {
    const { row, bytes } = withFile({}, 64 * 1024);
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);
    store.failPutAfterBytes = { bytes: 16 * 1024, error: new Error('socket hang up') };

    const first = await archiveMedia(row as never);
    expect(first.status).toBe('failed');
    expect(store.blobs.has(blobName)).toBe(false); // nothing committed
    expect(db.media.get(row.id)!.blob_name).toBeNull();

    const second = await archiveMedia(db.media.get(row.id) as never);
    expect(second.status).toBe('archived');
    expect(Buffer.from(store.blobs.get(blobName)!.bytes)).toEqual(bytes);
    expect(db.media.get(row.id)!.sha256).toBe(sha(bytes));
  });

  test('two concurrent calls on one media id are one upload', async () => {
    const { row } = withFile();
    const blobName = mediaBlobName(row.recording_id, row.id, row.filename);
    const [a, b] = await Promise.all([archiveMedia(row as never), archiveMedia(row as never)]);
    expect(a).toBe(b as never);
    expect(store.calls.filter((c) => c === `putStream ${blobName}`).length).toBe(1);
  });
});

describe('the lifecycle canary', () => {
  test('first enable writes one and the gate passes inside the first 36 h', async () => {
    const gate = await canaryGate(store);
    expect(gate.ok).toBe(true);
    expect(db.canaries.length).toBe(1);
    const name = db.canaries[0]!.name;
    expect(name).toStartWith('_canary/');
    expect(store.blobs.has(name)).toBe(true);
  });

  test('a canary older than 36 h that is still there keeps the gate open', async () => {
    const name = '_canary/2026-09-01';
    db.canaries.push({
      name,
      written_at: new Date(Date.now() - CANARY_MIN_AGE_MS - 1000).toISOString(),
      last_ok_at: null,
      missing_at: null,
    });
    store.put(name, new TextEncoder().encode('canary'));
    const gate = await canaryGate(store);
    expect(gate.ok).toBe(true);
    expect(db.canaries.find((c) => c.name === name)!.last_ok_at).toBeTruthy();
  });

  test('a canary older than 36 h that has vanished STOPS archiving', async () => {
    const name = '_canary/2026-09-01';
    db.canaries.push({
      name,
      written_at: new Date(Date.now() - CANARY_MIN_AGE_MS - 1000).toISOString(),
      last_ok_at: null,
      missing_at: null,
    });
    // The blob is not in the container: the rule ate it.
    const gate = await canaryGate(store);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toStartWith('CANARY GONE');
    expect(db.canaries.find((c) => c.name === name)!.missing_at).toBeTruthy();

    resetCanaryCache();
    const { row } = withFile();
    const out = await archiveMedia(row as never);
    expect(out).toMatchObject({ status: 'skipped' });
    if (out.status === 'skipped') expect(out.reason).toStartWith('CANARY GONE');
    expect(db.media.get(row.id)!.blob_name).toBeNull();
    expect(store.calls.filter((c) => c.startsWith('putStream'))).toEqual([]);
  });
});

describe('pacing', () => {
  const caps = { maxFiles: 5, maxBytes: 2 * 1024 ** 3 };
  test('stops at the file cap', () => {
    expect(archiveBudgetVerdict({ files: 4, bytes: 0 }, 10, caps)).toBe('take');
    expect(archiveBudgetVerdict({ files: 5, bytes: 0 }, 10, caps)).toBe('stop');
  });
  test('stops at the byte cap', () => {
    expect(archiveBudgetVerdict({ files: 1, bytes: caps.maxBytes }, 10, caps)).toBe('stop');
    expect(archiveBudgetVerdict({ files: 1, bytes: caps.maxBytes - 5 }, 10, caps)).toBe('stop');
  });
  test('a file bigger than the whole budget is still archived, alone, first', () => {
    expect(archiveBudgetVerdict({ files: 0, bytes: 0 }, 3 * 1024 ** 3, caps)).toBe('take');
    expect(archiveBudgetVerdict({ files: 1, bytes: 3 * 1024 ** 3 }, 10, caps)).toBe('stop');
  });
});

describe('yielding to work people are waiting for', () => {
  test('an upload or an AI run in flight yields', async () => {
    expect(await archiveShouldYield()).toBeNull();
    db.busy = { ingesting: true, ai: false };
    expect(await archiveShouldYield()).toBe('an upload is in flight');
    db.busy = { ingesting: false, ai: true };
    expect(await archiveShouldYield()).toBe('an AI run is in flight');
  });
  test('an ffmpeg transcode in this process yields', async () => {
    const g = globalThis as unknown as { __mwAudioOnlyInflight?: Map<string, unknown> };
    g.__mwAudioOnlyInflight = new Map([['x', Promise.resolve()]]);
    expect(await archiveShouldYield()).toBe('an audio extract is running');
    g.__mwAudioOnlyInflight = new Map();
    expect(await archiveShouldYield()).toBeNull();
  });
});

describe('deleting blobs whose rows are gone (Stage A.7)', () => {
  test('only the recordings that were actually removed lose their blobs', async () => {
    const mine = randomUUID();
    const shared = randomUUID();
    const a = withFile({ recording_id: mine });
    const b = withFile({ recording_id: shared });
    await archiveMedia(a.row as never);
    await archiveMedia(b.row as never);
    db.clips.set(42, [mine, shared]);

    const refs = await blobsHeldByMeeting(42);
    expect(refs.length).toBe(2);
    // `shared` was KEPT because another meeting still clips it.
    const out = await deleteBlobsForRemovedRecordings(refs, [mine], 'test');
    expect(out).toEqual({ deleted: 1, pending: 0 });
    expect(store.blobs.has(db.media.get(a.row.id)!.blob_name!)).toBe(false);
    expect(store.blobs.has(db.media.get(b.row.id)!.blob_name!)).toBe(true);
    expect(db.pendingDeletes.size).toBe(0);
  });

  test('a failed delete stays queued and the sweeper drains it later', async () => {
    const rec = randomUUID();
    const { row } = withFile({ recording_id: rec });
    await archiveMedia(row as never);
    db.clips.set(7, [rec]);
    const refs = await blobsHeldByMeeting(7);

    const blobName = db.media.get(row.id)!.blob_name!;
    const realDelete = store.delete.bind(store);
    store.delete = async () => {
      throw new Error('403 from the storage front end');
    };
    const out = await deleteBlobsForRemovedRecordings(refs, [rec], 'test');
    expect(out).toEqual({ deleted: 0, pending: 1 });
    expect(db.pendingDeletes.get(blobName)!.attempts).toBe(1);
    expect(store.blobs.has(blobName)).toBe(true);

    store.delete = realDelete;
    expect(await drainPendingBlobDeletes(10)).toEqual({ deleted: 1, failed: 0 });
    expect(store.blobs.has(blobName)).toBe(false);
    expect(db.pendingDeletes.size).toBe(0);
  });

  test('with no media account nothing is read and nothing is queued', async () => {
    setMediaStoreForTests(null);
    db.clips.set(9, [randomUUID()]);
    expect(await blobsHeldByMeeting(9)).toEqual([]);
    expect(await drainPendingBlobDeletes(10)).toEqual({ deleted: 0, failed: 0 });
  });
});

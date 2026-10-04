/**
 * Stage D (docs/recordings-stage-d-spec.md "Tests") over the in-memory
 * `FakeMediaBlob` and real temp files: the read-back verification
 * (`verifyArchivedBlob`), the age gate, the eviction itself (ledger row,
 * `local_evicted_at`, file gone), and every reason the eviction must NOT
 * delete — a file rewritten after the read-back, a meeting still
 * transcribing, a reader holding the file, a fresh mtime, a blob that no
 * longer agrees, a vanished canary — plus the crash between the ledger and
 * the unlink. The pull side (wrong sha256, low free space) is in
 * `media-local.test.ts`.
 *
 * Same seams as `media-archive.test.ts`: `server-only` stubbed, db-ops
 * replaced by an in-memory stand-in that implements the SAME guards as the
 * SQL (the guarded UPDATEs, the ledger transaction), and `@/lib/db` answering
 * the two raw queries (`archiveShouldYield`, the per-recording work probe).
 * The SQL itself is proved against a scratch Postgres in `tmp/media-evict/`.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FakeMediaBlob } from './helpers/fake-media-blob';

mock.module('server-only', () => ({}));

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
  blob_verified_at: string | null;
  blob_verified_sha256: string | null;
  blob_verified_bytes: number | null;
  blob_verify_failed_at: string | null;
  blob_verify_error: string | null;
  local_evicted_at: string | null;
};

type Ledger = Record<string, unknown>;

const db = {
  media: new Map<string, MediaRow>(),
  ledger: [] as Ledger[],
  canaries: [] as Array<{ name: string; written_at: string; last_ok_at: string | null; missing_at: string | null }>,
  busy: { ingesting: false, ai: false },
  /** recording id → what the per-recording work probe answers. */
  work: new Map<string, { meetings: string[]; transcribing?: boolean; ai?: boolean; retranscribing?: boolean }>(),
};

function resetDb() {
  db.media.clear();
  db.ledger = [];
  db.canaries = [];
  db.busy = { ingesting: false, ai: false };
  db.work.clear();
}

const days = (n: number) => n * 24 * 3600_000;

mock.module('@/db-ops/recordings', () => ({
  // Never called; the import graph (audio-only → video-frames → resolver)
  // needs them to link — same as media-archive.test.ts.
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
    Object.assign(row, {
      blob_name: p.blobName,
      sha256: p.sha256,
      bytes: p.bytes,
      blob_verified_at: null,
      blob_verified_sha256: null,
      blob_verified_bytes: null,
      blob_verify_failed_at: null,
      blob_verify_error: null,
      local_evicted_at: null,
    });
    return true;
  },
  async setRecordingSha256() {
    return true;
  },
  async listClipsForMeeting() {
    return [];
  },
  async listMediaBlobsForRecordings() {
    return [];
  },
  async queueBlobDeletes() {
    return 0;
  },
  async listPendingBlobDeletes() {
    return [];
  },
  async clearPendingBlobDelete() {},
  async markPendingBlobDeleteFailed() {},
  async listMediaCanaries() {
    return [...db.canaries].sort((a, b) => Date.parse(a.written_at) - Date.parse(b.written_at));
  },
  async insertMediaCanary(name: string) {
    if (!db.canaries.some((c) => c.name === name)) {
      db.canaries.push({ name, written_at: new Date().toISOString(), last_ok_at: null, missing_at: null });
    }
  },
  async markMediaCanarySeen() {},
  async markMediaCanaryMissing(name: string) {
    const c = db.canaries.find((x) => x.name === name);
    if (c) c.missing_at ??= new Date().toISOString();
  },
  // ---- Stage D ----
  async mediaEvictionColumnsExist() {
    return true;
  },
  resetMediaEvictionColumnsProbe() {},
  async listMediaToVerify(limit: number) {
    return [...db.media.values()]
      .filter((m) => m.blob_name && m.sha256 && m.bytes != null && !m.blob_verified_at)
      .slice(0, limit)
      .map((m) => ({ ...m }));
  },
  async stampMediaVerified(id: string, p: { blobName: string; sha256: string; bytes: number }) {
    const row = db.media.get(id);
    if (!row || row.blob_name !== p.blobName || row.sha256 !== p.sha256) return false;
    Object.assign(row, {
      blob_verified_at: new Date().toISOString(),
      blob_verified_sha256: p.sha256,
      blob_verified_bytes: p.bytes,
      blob_verify_failed_at: null,
      blob_verify_error: null,
    });
    return true;
  },
  async stampMediaVerifyFailed(id: string, error: string) {
    const row = db.media.get(id);
    if (!row) return;
    Object.assign(row, {
      blob_verify_failed_at: new Date().toISOString(),
      blob_verify_error: error,
      blob_verified_at: null,
      blob_verified_sha256: null,
      blob_verified_bytes: null,
    });
  },
  async clearMediaVerification(id: string) {
    const row = db.media.get(id);
    if (row) Object.assign(row, { blob_verified_at: null, blob_verified_sha256: null, blob_verified_bytes: null });
  },
  async listEvictableMedia(opts: { minAgeDays: number; limit: number }) {
    const cutoff = Date.now() - days(opts.minAgeDays);
    return [...db.media.values()]
      .filter(
        (m) =>
          m.blob_name &&
          m.sha256 &&
          m.filename &&
          m.blob_verified_at &&
          Date.parse(m.blob_verified_at) <= cutoff &&
          m.blob_verified_sha256 === m.sha256 &&
          !m.local_evicted_at &&
          ['canonical', 'audio_only', 'part'].includes(m.kind)
      )
      .slice(0, opts.limit)
      .map((m) => ({ ...m }));
  },
  async recordLocalEviction(e: Record<string, unknown>) {
    const row = db.media.get(e.mediaId as string);
    if (
      !row ||
      row.blob_name !== e.blobName ||
      row.sha256 !== e.blobSha256 ||
      row.blob_verified_sha256 !== row.sha256 ||
      row.local_evicted_at
    ) {
      return false;
    }
    row.local_evicted_at = new Date().toISOString();
    db.ledger.push({ ...e });
    return true;
  },
  async markLocalAlreadyGone(id: string, note: string, ctx: { localPath: string; by: string }) {
    const row = db.media.get(id);
    if (!row || row.local_evicted_at || !row.blob_verified_at) return false;
    row.local_evicted_at = new Date().toISOString();
    db.ledger.push({ mediaId: id, note, localPath: ctx.localPath, evictedBy: ctx.by, localSha256: '' });
    return true;
  },
  async evictedSourceStems() {
    return new Set<string>();
  },
  // recording-sync.ts imports this; when another test file in the same run
  // loads it while this mock is active the name must exist to link.
  async activeTranscriptionIdOf() {
    return null;
  },
  async clearLocalEvictedOnDisk() {
    return 0;
  },
}));

// The two raw queries: the pass-level busy probe and the per-recording one.
mock.module('@/lib/db', () => ({
  sql: Object.assign(
    async (strings: unknown, ...values: unknown[]) => {
      if (!Array.isArray(strings)) return strings; // sql(SCHEMA) — an identifier
      const text = (strings as string[]).join('?');
      if (text.includes('meeting_clips')) {
        const rec = values.find((v) => typeof v === 'string' && db.work.has(v)) as string | undefined;
        const w = rec ? db.work.get(rec)! : { meetings: [] };
        return [
          {
            meetings: w.meetings.length ? w.meetings : null,
            transcribing: w.transcribing ?? null,
            ai: w.ai ?? null,
            retranscribing: w.retranscribing ?? false,
          },
        ];
      }
      return [db.busy];
    },
    { json: (v: unknown) => v }
  ),
}));

const { verifyArchivedBlob, resetCanaryCache, CANARY_MIN_AGE_MS } = await import('@/lib/server/media-archive');
const evict = await import('@/lib/server/media-evict');
const { setMediaStoreForTests } = await import('@/lib/server/media-store');
const local = await import('@/lib/server/media-local');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const storage = mkdtempSync(path.join(tmpdir(), 'mw-media-evict-'));
afterAll(() => {
  setMediaStoreForTests(null);
  rmSync(storage, { recursive: true, force: true });
});

const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
let store: FakeMediaBlob;
let errSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;

/**
 * An ARCHIVED media row (blob + metadata in the fake, row stamped) whose
 * bytes are on disk with an mtime two hours ago — i.e. everything Stage A
 * leaves behind, before any read-back.
 */
function archived(over: Partial<MediaRow> = {}, size = 8192): { row: MediaRow; abs: string; bytes: Buffer } {
  const kind = over.kind ?? 'canonical';
  const id = over.id ?? randomUUID();
  const recording_id = over.recording_id ?? randomUUID();
  const filename = over.filename ?? `${randomUUID()}.${kind === 'audio_only' ? 'm4a' : 'mp4'}`;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13) % 251;
  const abs = path.join(storage, kind === 'audio_only' ? 'audio-only' : 'audio', filename);
  writeFileSync(abs, bytes);
  const old = new Date(Date.now() - 2 * 3600_000);
  utimesSync(abs, old, old);
  const blobName = `${recording_id}/${id}${path.extname(filename)}`;
  store.put(blobName, new Uint8Array(bytes), 'video/mp4');
  store.metadata.set(blobName, { sha256: sha(bytes), kind });
  const row: MediaRow = {
    id,
    recording_id,
    kind,
    ord: 0,
    offset_ms: 0,
    duration_ms: null,
    filename,
    blob_name: blobName,
    bytes: size,
    has_video: kind !== 'audio_only',
    sha256: sha(bytes),
    source_ref: null,
    of_media_id: null,
    created_at: new Date(Date.now() - days(30)).toISOString(),
    blob_verified_at: null,
    blob_verified_sha256: null,
    blob_verified_bytes: null,
    blob_verify_failed_at: null,
    blob_verify_error: null,
    local_evicted_at: null,
    ...over,
  };
  db.media.set(row.id, row);
  return { row, abs, bytes };
}

/** Read back now, then pretend that happened `ageDays` ago. */
async function verifiedAgo(row: MediaRow, ageDays: number): Promise<MediaRow> {
  const out = await verifyArchivedBlob(row as never);
  expect(out.status).toBe('verified');
  const live = db.media.get(row.id)!;
  live.blob_verified_at = new Date(Date.now() - days(ageDays)).toISOString();
  return { ...live };
}

const BY = 'script:test@host';

beforeEach(() => {
  resetDb();
  resetCanaryCache();
  local.resetMediaLocalForTests();
  rmSync(storage, { recursive: true, force: true });
  mkdirSync(path.join(storage, 'audio'), { recursive: true });
  mkdirSync(path.join(storage, 'audio-only'), { recursive: true });
  process.env.MW_STORAGE_DIR = storage;
  process.env.MW_MEDIA_ARCHIVE = '1';
  delete process.env.MW_MEDIA_EVICT;
  delete process.env.MW_MEDIA_EVICT_AFTER_DAYS;
  delete process.env.MW_EVICT_FILES_PER_TICK;
  store = new FakeMediaBlob();
  setMediaStoreForTests(store);
  for (const s of [errSpy, warnSpy, logSpy]) s?.mockRestore();
  errSpy = spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const gl = globalThis as unknown as Record<string, unknown>;
  gl.__mwAudioOnlyInflight = new Map();
  gl.__mwMediaPrepInflight = new Map();
  gl.__mwClipCutInflight = new Map();
  gl.__mwClipPrecut = { queue: new Map(), running: false, timer: null, verified: new Map(), failures: new Map() };
});

// ---------------------------------------------------------------------------

describe('the read-back (verifyArchivedBlob)', () => {
  test('streams the whole blob, and stamps the hash it produced', async () => {
    const { row, bytes } = archived();
    const out = await verifyArchivedBlob(row as never);
    expect(out).toMatchObject({ status: 'verified', bytes: bytes.length, sha256: sha(bytes) });
    const live = db.media.get(row.id)!;
    expect(live.blob_verified_at).toBeTruthy();
    expect(live.blob_verified_sha256).toBe(sha(bytes));
    expect(live.blob_verified_bytes).toBe(bytes.length);
    expect(store.calls).toContain(`read ${row.blob_name}`);
  });

  test('corrupted bytes under correct metadata: MISMATCH recorded, shouted, never repaired', async () => {
    const { row, bytes } = archived();
    const bad = Buffer.from(bytes);
    bad[100] = bad[100]! ^ 0xff;
    store.blobs.get(row.blob_name!)!.bytes = new Uint8Array(bad);
    const out = await verifyArchivedBlob(row as never);
    expect(out.status).toBe('mismatch');
    const live = db.media.get(row.id)!;
    expect(live.blob_verified_at).toBeNull();
    expect(live.blob_verify_failed_at).toBeTruthy();
    expect(live.blob_verify_error).toContain('read back sha256');
    expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith('[media-verify] MISMATCH'))).toBe(true);
    // Never auto-repaired: the blob is exactly as bad as before, and no upload happened.
    expect(store.calls.filter((c) => c.startsWith('putStream'))).toEqual([]);
  });

  test('a wrong-size or missing blob fails on the properties gate, without a download', async () => {
    const { row } = archived();
    store.blobs.delete(row.blob_name!);
    const out = await verifyArchivedBlob(row as never);
    expect(out).toMatchObject({ status: 'mismatch' });
    expect(store.calls.filter((c) => c.startsWith('read '))).toEqual([]);
  });

  test('a read that dies part-way is not a mismatch, but is recorded (24 h back-off)', async () => {
    const { row } = archived({}, 64 * 1024);
    store.failRead = { afterBytes: 16 * 1024, error: new Error('socket hang up') };
    const out = await verifyArchivedBlob(row as never);
    expect(out.status).toBe('skipped');
    expect(db.media.get(row.id)!.blob_verify_error).toContain('socket hang up');
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('MISMATCH'))).toBe(false);
  });

  test('a re-stamp that lands while the blob is being read is not stamped verified', async () => {
    const { row } = archived();
    const asListed = { ...row };
    const live = db.media.get(row.id)!;
    live.sha256 = 'f'.repeat(64); // re-archived meanwhile: the row no longer describes these bytes
    const out = await verifyArchivedBlob(asListed as never);
    expect(out).toMatchObject({ status: 'skipped' });
    expect(live.blob_verified_at).toBeNull();
  });

  test('no store → skipped, no call', async () => {
    const { row } = archived();
    expect(await verifyArchivedBlob(row as never, { store: null })).toMatchObject({ status: 'skipped' });
  });
});

describe('verify → age gate → evict', () => {
  test('the happy path: ledger row, local_evicted_at, file gone — only once the age gate passes', async () => {
    const { row, abs, bytes } = archived();
    await verifyArchivedBlob(row as never);

    // Verified a moment ago: inside the 7-day gate, nothing is a candidate.
    let pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass.evicted).toBe(0);
    expect(existsSync(abs)).toBe(true);

    db.media.get(row.id)!.blob_verified_at = new Date(Date.now() - days(8)).toISOString();
    pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass).toMatchObject({ evicted: 1, bytes: bytes.length, failed: 0 });
    expect(existsSync(abs)).toBe(false);
    expect(db.media.get(row.id)!.local_evicted_at).toBeTruthy();
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({
      mediaId: row.id,
      localSha256: sha(bytes),
      blobSha256: sha(bytes),
      blobName: row.blob_name,
      localPath: abs,
      bytes: bytes.length,
      evictedBy: 'sweeper',
    });
    // The blob is untouched — Stage D never writes or deletes one.
    expect(store.blobs.has(row.blob_name!)).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).startsWith('[media-evict] tick: 1 file(s) evicted'))).toBe(true);

    // The next pass has nothing left to do.
    pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass.evicted).toBe(0);
  });

  test('MW_MEDIA_EVICT_AFTER_DAYS moves the gate', async () => {
    const { row } = archived();
    await verifiedAgo(row, 2);
    expect((await evict.evictionPass({ files: 20, by: 'sweeper' })).evicted).toBe(0);
    process.env.MW_MEDIA_EVICT_AFTER_DAYS = '1';
    expect((await evict.evictionPass({ files: 20, by: 'sweeper' })).evicted).toBe(1);
  });

  test('the per-tick cap holds', async () => {
    for (let i = 0; i < 4; i++) await verifiedAgo(archived().row, 10);
    const pass = await evict.evictionPass({ files: 3, by: 'sweeper' });
    expect(pass.evicted).toBe(3);
  });

  test('audio_only and part rows are evicted from their own dirs', async () => {
    const ao = archived({ kind: 'audio_only' });
    const part = archived({ kind: 'part' });
    await verifiedAgo(ao.row, 10);
    await verifiedAgo(part.row, 10);
    expect((await evict.evictionPass({ files: 20, by: 'sweeper' })).evicted).toBe(2);
    expect(existsSync(ao.abs)).toBe(false);
    expect(existsSync(part.abs)).toBe(false);
  });

  test('an unverified row, or one verified for an OLD hash, is never evicted', async () => {
    const a = archived();
    const out = await evict.evictLocalCopy(a.row as never, { by: BY, store });
    expect(out).toMatchObject({ status: 'skipped' });
    const b = archived();
    const vb = await verifiedAgo(b.row, 10);
    vb.blob_verified_sha256 = 'e'.repeat(64);
    expect(await evict.evictLocalCopy(vb as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    expect(existsSync(a.abs) && existsSync(b.abs)).toBe(true);
  });
});

describe('reasons not to delete', () => {
  test('rewritten after the read-back (same size) → nothing deleted, verification cleared', async () => {
    const { row, abs, bytes } = archived();
    const v = await verifiedAgo(row, 10);
    const changed = Buffer.from(bytes);
    changed[0] = changed[0]! ^ 0xff;
    writeFileSync(abs, changed);
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(abs, old, old);
    // media puts only — the first archive in 36 h also writes a canary blob
    const mediaPuts = () => store.calls.filter((c) => c.startsWith('putStream') && !c.includes('_canary')).length;
    const putsBefore = mediaPuts();
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out.status).toBe('rewritten');
    expect(existsSync(abs)).toBe(true);
    const live = db.media.get(row.id)!;
    expect(live.blob_verified_at).toBeNull();
    expect(live.blob_name).toBe(row.blob_name); // same blob name — the blob is OVERWRITTEN from the local file
    expect(live.local_evicted_at).toBeNull();
    expect(db.ledger).toEqual([]);
    // The local file is the newer truth: it was re-archived in the same call,
    // so the row's hash now describes the file on disk and the next verify +
    // evict ticks can finish the job instead of bouncing forever.
    const newSha = createHash('sha256').update(changed).digest('hex');
    expect(live.sha256).toBe(newSha);
    expect(live.bytes).toBe(changed.length);
    expect(mediaPuts()).toBe(putsBefore + 1);
    expect(out.status === 'rewritten' && out.reason).toContain('re-archived from the local file');
  });

  test('rewritten with a different size → same', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    writeFileSync(abs, Buffer.alloc(10));
    utimesSync(abs, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    expect((await evict.evictLocalCopy(v as never, { by: BY, store })).status).toBe('rewritten');
    expect(existsSync(abs)).toBe(true);
    expect(db.media.get(row.id)!.blob_verified_at).toBeNull();
  });

  test('a meeting on the recording still transcribing → skipped', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    db.work.set(row.recording_id, { meetings: ['m-1'], transcribing: true });
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out).toMatchObject({ status: 'skipped' });
    if (out.status === 'skipped') expect(out.reason).toContain('transcribing');
    expect(existsSync(abs)).toBe(true);
    db.work.set(row.recording_id, { meetings: ['m-1'], ai: true });
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    db.work.set(row.recording_id, { meetings: ['m-1'], retranscribing: true });
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    expect(existsSync(abs)).toBe(true);
  });

  test('an ensureLocalMedia handle on the stored file → skipped "held"; released → evicted', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    const got = await local.ensureLocalMedia(
      { filename: row.filename!, recordingId: row.recording_id, blobName: row.blob_name, isVideo: true, audioOnly: null },
      'canonical',
      { purpose: 'test', store }
    );
    expect(got?.source).toBe('disk');
    expect(local.localMediaHeld(abs)).toBe(true);
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toEqual({
      status: 'skipped',
      mediaId: row.id,
      reason: 'held',
    });
    expect(existsSync(abs)).toBe(true);
    got!.release();
    expect((await evict.evictLocalCopy(v as never, { by: BY, store })).status).toBe('evicted');
  });

  test('in-process work on the recording: audio extract, media prep, clip cut → skipped', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    db.work.set(row.recording_id, { meetings: ['meet-1'] });
    const gl = globalThis as unknown as {
      __mwAudioOnlyInflight: Map<string, unknown>;
      __mwMediaPrepInflight: Map<string, unknown>;
      __mwClipPrecut: { queue: Map<string, string>; running: boolean };
      __mwClipCutInflight: Map<string, unknown>;
    };
    const stem = path.parse(row.filename!).name;
    gl.__mwAudioOnlyInflight.set(path.join(storage, 'audio-only', `${stem}.m4a`), Promise.resolve());
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    gl.__mwAudioOnlyInflight.clear();
    gl.__mwMediaPrepInflight.set('meet-1', Promise.resolve());
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    gl.__mwMediaPrepInflight.clear();
    gl.__mwClipPrecut.queue.set('meet-1', 'sweeper');
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    gl.__mwClipPrecut.queue.clear();
    const src = createHash('md5').update(row.filename!).digest('hex').slice(0, 8);
    gl.__mwClipCutInflight.set(path.join(storage, 'clips', 'other', `av.0-1000.${src}`), Promise.resolve());
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    gl.__mwClipCutInflight.clear();
    expect(existsSync(abs)).toBe(true);
    expect((await evict.evictLocalCopy(v as never, { by: BY, store })).status).toBe('evicted');
  });

  test('a file modified within the last hour → skipped', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    const now = new Date();
    utimesSync(abs, now, now);
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out).toMatchObject({ status: 'skipped', reason: 'modified within the last hour' });
    expect(existsSync(abs)).toBe(true);
  });

  test('the blob no longer agrees at eviction time → KEPT, verification cleared, loud', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    store.metadata.set(row.blob_name!, { sha256: 'd'.repeat(64), kind: 'canonical' });
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out.status).toBe('failed');
    expect(existsSync(abs)).toBe(true);
    expect(db.media.get(row.id)!.blob_verified_at).toBeNull();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('the local file is KEPT'))).toBe(true);
  });

  test('a vanished canary stops the eviction: the blob would be the only copy', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    db.canaries.push({
      name: '_canary/2026-09-01',
      written_at: new Date(Date.now() - CANARY_MIN_AGE_MS - 1000).toISOString(),
      last_ok_at: null,
      missing_at: null,
    });
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out.status).toBe('skipped');
    if (out.status === 'skipped') expect(out.reason).toStartWith('CANARY GONE');
    expect(existsSync(abs)).toBe(true);
  });

  test('an ingest or AI run anywhere pauses the whole pass', async () => {
    await verifiedAgo(archived().row, 10);
    db.busy = { ingesting: true, ai: false };
    const pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass.evicted).toBe(0);
    expect(pass.stopped).toBe('an upload is in flight');
  });

  test('an unsafe stored name is never resolved, let alone deleted', async () => {
    const { row } = archived();
    const v = await verifiedAgo(row, 10);
    v.filename = '../../etc/passwd';
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
  });
});

describe('crash and drift', () => {
  test('a crash between the ledger and the unlink: the next pass skips the row, the file stays for --orphans', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    // The ledger transaction committed, the process died before the unlink.
    const mod = await import('@/db-ops/recordings');
    expect(
      await mod.recordLocalEviction({
        mediaId: row.id,
        recordingId: row.recording_id,
        kind: row.kind,
        filename: row.filename!,
        localPath: abs,
        bytes: row.bytes!,
        localSha256: row.sha256!,
        blobName: row.blob_name!,
        blobSha256: row.sha256!,
        blobVerifiedAt: v.blob_verified_at!,
        evictedBy: 'sweeper',
      })
    ).toBe(true);
    const pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass.evicted + pass.failed + pass.skipped).toBe(0);
    expect(existsSync(abs)).toBe(true);
    expect(db.ledger).toHaveLength(1);
    // Even a stale in-memory copy of the row (local_evicted_at still null in
    // it) cannot get past the guarded ledger write.
    expect(await evict.evictLocalCopy(v as never, { by: BY, store })).toMatchObject({ status: 'skipped' });
    expect(existsSync(abs)).toBe(true);
    expect(db.ledger).toHaveLength(1);
  });

  test('a verified row whose file is already missing is marked, with an "already gone" ledger note', async () => {
    const { row, abs } = archived();
    const v = await verifiedAgo(row, 10);
    rmSync(abs);
    const out = await evict.evictLocalCopy(v as never, { by: BY, store });
    expect(out.status).toBe('already-gone');
    expect(db.media.get(row.id)!.local_evicted_at).toBeTruthy();
    expect(db.ledger[0]).toMatchObject({ mediaId: row.id, localSha256: '' });
    expect(String(db.ledger[0]!.note)).toStartWith('already gone');
  });

  test('a re-archive resets the verification and the eviction (stampMediaArchived)', async () => {
    const { row } = archived();
    await verifiedAgo(row, 10);
    db.media.get(row.id)!.local_evicted_at = new Date().toISOString();
    const mod = await import('@/db-ops/recordings');
    await mod.stampMediaArchived(row.id, { blobName: row.blob_name!, sha256: 'a'.repeat(64), bytes: 1 });
    const live = db.media.get(row.id)!;
    expect(live.blob_verified_at).toBeNull();
    expect(live.local_evicted_at).toBeNull();
  });
});

describe('flags and caps are read lazily', () => {
  test('MW_MEDIA_EVICT is 1/true only', () => {
    for (const [v, on] of [
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['0', false],
      ['', false],
      ['yes', false],
    ] as const) {
      process.env.MW_MEDIA_EVICT = v;
      expect(evict.mediaEvictFlagOn()).toBe(on);
    }
    delete process.env.MW_MEDIA_EVICT;
    expect(evict.mediaEvictFlagOn()).toBe(false);
  });
  test('defaults: 7 days, 20 files; 0 days allowed', () => {
    expect(evict.evictAfterDays()).toBe(7);
    expect(evict.evictFilesPerTick()).toBe(20);
    process.env.MW_MEDIA_EVICT_AFTER_DAYS = '0';
    expect(evict.evictAfterDays()).toBe(0);
    process.env.MW_MEDIA_EVICT_AFTER_DAYS = 'junk';
    expect(evict.evictAfterDays()).toBe(7);
    process.env.MW_EVICT_FILES_PER_TICK = '3';
    expect(evict.evictFilesPerTick()).toBe(3);
    expect(evict.MEDIA_EVICT_MTIME_MIN_MS).toBe(3600_000);
  });
  test('no archive store → the pass makes no query and deletes nothing', async () => {
    setMediaStoreForTests(null);
    const pass = await evict.evictionPass({ files: 20, by: 'sweeper' });
    expect(pass.stopped).toBe('no archive store');
  });
});

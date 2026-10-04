/**
 * Stage D readers (docs/recordings-stage-d-spec.md "As built — readers"):
 * once a verified row's LOCAL copy can be deleted, (1) nothing may destroy a
 * blob or a row because a local file is absent, and (2) every long reader gets
 * its bytes through `ensureLocalMedia` and HOLDS them (`localMediaHeld`) for as
 * long as it reads.
 *
 * Over the fake postgres tag (db-ops/__tests__/helpers/fake-sql — every query
 * rendered and answered by a script), real temp dirs (MW_STORAGE_DIR,
 * MW_SCRATCH_DIR), the in-memory `FakeMediaBlob`, and a fake `fetch` standing
 * in for AssemblyAI. Nothing else is mocked: `mock.module` is process-wide in
 * `bun test`, so only the modules every db-ops test already replaces are.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createFakeSql, type FakeSql, type RenderedQuery } from '../../../db-ops/__tests__/helpers/fake-sql';
import { FakeMediaBlob } from './helpers/fake-media-blob';

const sql: FakeSql = createFakeSql((q) => respond(q));
let respond: (q: RenderedQuery) => unknown[] = () => [];
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));
mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
// The routes' auth wrapper, the same stand-in link-shares-like-imports uses.
const OWNER = { kind: 'session' as const, userId: 'u1', email: 'a@trames.sg', name: 'A', modules: ['meetings'], scope: 'readwrite' as const };
mock.module('@/lib/auth/with-auth', () => ({
  withAuth:
    (h: (ctx: { user: typeof OWNER; request: Request }, c: unknown) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      h({ user: OWNER, request }, context),
}));

const root = mkdtempSync(path.join(tmpdir(), 'stage-d-readers-'));
const storage = path.join(root, 'storage');
const scratch = path.join(root, 'scratch');
const ENV_KEYS = [
  'MW_STORAGE_DIR',
  'MW_SCRATCH_DIR',
  'MW_RECORDINGS_WRITE',
  'MW_TRANSCRIPTION_VERSIONS',
  'MW_RECORDINGS',
  'ASSEMBLYAI_API_KEY',
  'DARTH_MEDIA_ACCOUNT',
  'MW_MEDIA_ARCHIVE',
  'MW_MEDIA_FROM_BLOB',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
process.env.MW_STORAGE_DIR = storage;
process.env.MW_SCRATCH_DIR = scratch;
delete process.env.DARTH_MEDIA_ACCOUNT;
delete process.env.MW_MEDIA_ARCHIVE;

const graphLib = await import('@/lib/recording-graph');
const sync = await import('@/lib/server/recording-sync');
const sweeper = await import('@/lib/server/media-sweeper');
const local = await import('@/lib/server/media-local');
const stored = await import('@/lib/server/stored-media');
const { setMediaStoreForTests } = await import('@/lib/server/media-store');
const bornBare = await import('@/lib/server/born-bare');
const runs = await import('@/lib/server/transcription-runs');
const ingestRetry = await import('@/lib/server/ingest-retry');
const align = await import('@/lib/server/align');
const { concatMediaPathsToTemp } = await import('@/lib/server/media-concat');
const offlinePlan = await import('@/app/api/offline/plan/route');
const recordingAudio = await import('@/app/api/recordings/[id]/audio/route');
const retranscribeRoute = await import('@/app/api/transcripts/[id]/retranscribe/route');
const HAVE_FFMPEG =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

// `mock.module` is process-wide and patches a loaded module in place: when the
// media-archive / media-evict tests ran first, `listRecordingMedia` is their
// in-memory stand-in for the rest of the run. The line-up test reads the
// recordings' media through it, so while THIS file's tests run it is routed to
// a second, real instance of the module (the query string makes it separate)
// that reads through this file's fake tag — and back to whatever was there
// afterwards. Every other export is passed through as it is now.
type RecordingsMod = typeof import('@/db-ops/recordings');
const recordingsNow = (await import('@/db-ops/recordings')) as RecordingsMod;
const prevRecordings = { ...recordingsNow };
const realSpec = '../../../db-ops/recordings.ts?stage-d-readers';
const realRecordings = (await import(realSpec)) as RecordingsMod;
let ownRecordings = true;
mock.module('@/db-ops/recordings', () => ({
  ...prevRecordings,
  listRecordingMedia: (ids: string[]) =>
    (ownRecordings ? realRecordings : prevRecordings).listRecordingMedia(ids),
}));

const audioDir = path.join(storage, 'audio');
const audioOnlyDir = path.join(storage, 'audio-only');
const store = new FakeMediaBlob();
const realFetch = globalThis.fetch;

type G = Record<string, unknown>;
const probes = [
  '__mwAaiJobIdColumn',
  '__mwStandaloneColumns',
  '__mwTranscriptionVersionTables',
  '__mwMediaArchiveTables',
  '__mwMediaEvictionColumns',
] as const;
const savedProbes: Record<string, unknown> = {};
for (const p of probes) savedProbes[p] = (globalThis as G)[p];

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const AAI = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REC = graphLib.recordingIdFor(AAI);
const CANON_ID = graphLib.mediaIdFor(REC, 'canonical', 0);
const AO_ID = graphLib.mediaIdFor(REC, 'audio_only', 0);
const VIDEO = new Uint8Array(4096).map((_, i) => i % 251);
const AUDIO = new Uint8Array(1024).map((_, i) => (i * 7) % 253);
const CANON_BLOB = `${REC}/${CANON_ID}.mp4`;
const AO_BLOB = `${REC}/${AO_ID}.m4a`;

function reset() {
  rmSync(storage, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(audioDir, { recursive: true });
  mkdirSync(audioOnlyDir, { recursive: true });
  local.resetMediaLocalForTests();
  store.put(CANON_BLOB, VIDEO, 'video/mp4');
  store.put(AO_BLOB, AUDIO, 'audio/mp4');
  setMediaStoreForTests(store);
  // Every migration this code probes for is applied (and answered without a query).
  for (const p of probes) (globalThis as G)[p] = Promise.resolve(true);
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = () => [];
  process.env.MW_RECORDINGS_WRITE = '1';
  delete process.env.MW_TRANSCRIPTION_VERSIONS;
  delete process.env.MW_MEDIA_FROM_BLOB;
  globalThis.fetch = realFetch;
}

beforeEach(reset);

afterAll(() => {
  ownRecordings = false;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const p of probes) (globalThis as G)[p] = savedProbes[p];
  setMediaStoreForTests(null);
  globalThis.fetch = realFetch;
  local.resetMediaLocalForTests();
  rmSync(root, { recursive: true, force: true });
});

/** The archived canonical + extract rows of the recording, as the db returns them. */
function mediaRows(over: { aoFilename?: string } = {}) {
  return [
    {
      id: CANON_ID,
      recording_id: REC,
      kind: 'canonical',
      ord: 0,
      offset_ms: 0,
      duration_ms: 18000,
      filename: `${AAI}.mp4`,
      blob_name: CANON_BLOB,
      bytes: VIDEO.length,
      has_video: true,
      sha256: sha(VIDEO),
      source_ref: null,
      of_media_id: null,
      created_at: '2026-09-01T10:00:00Z',
      local_evicted_at: '2026-10-01T00:00:00Z',
    },
    {
      id: AO_ID,
      recording_id: REC,
      kind: 'audio_only',
      ord: 0,
      offset_ms: 0,
      duration_ms: 18000,
      filename: over.aoFilename ?? `${AAI}.m4a`,
      blob_name: AO_BLOB,
      bytes: AUDIO.length,
      has_video: false,
      sha256: sha(AUDIO),
      source_ref: null,
      of_media_id: CANON_ID,
      created_at: '2026-09-01T10:00:00Z',
      local_evicted_at: '2026-10-01T00:00:00Z',
    },
  ];
}

function meetingRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: 'u1',
    assemblyai_id: AAI,
    aai_job_id: AAI,
    original_filename: 'board.mp4',
    status: 'completed',
    created_at: '2026-09-01T10:00:00Z',
    completed_at: '2026-09-01T10:10:00Z',
    duration: 18,
    language_code: 'en',
    speech_model: 'universal',
    local_audio_path: `${AAI}.mp4`,
    deleted_at: null,
    gmeet_context: null,
    has_content: true,
    recorder_recording_id: null,
    recorder_started_at: null,
    ...over,
  };
}

const ran = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));

/** Wait (bounded) until `pred` holds; returns whether it did. */
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

// ---------------------------------------------------------------------------
// A1 — an absent local file never deletes an archived row or queues its blob
// ---------------------------------------------------------------------------

describe('A1: the dual-write keeps an archived audio_only row whose file is gone', () => {
  function graphResponder(existing: unknown[]) {
    return (q: RenderedQuery): unknown[] => {
      if (/FROM "[a-z_]+"\.transcripts t LEFT JOIN LATERAL/.test(q.text)) return [meetingRow()];
      if (/FROM "[a-z_]+"\.recording_media WHERE recording_id = \$\d+::uuid AND kind = 'audio_only'/.test(q.text)) {
        return (existing as Array<{ kind: string }>).filter((m) => m.kind === 'audio_only');
      }
      return [];
    };
  }

  test('canonical AND extract evicted: both rows are kept, nothing is deleted, no blob is queued', async () => {
    respond = graphResponder(mediaRows());
    const out = await sync.syncRecordingGraphForMeeting('u1', AAI);
    expect(out.status).toBe('written');

    const upserts = ran(/INSERT INTO "[a-z_]+"\.recording_media/);
    const ids = upserts.map((q) => q.params[0]);
    expect(ids).toContain(CANON_ID);
    expect(ids).toContain(AO_ID);
    // The canonical's bytes are NOT probed (file absent) → NULL → COALESCE keeps the row's.
    const canon = upserts.find((q) => q.params[0] === CANON_ID)!;
    expect(canon.params[7]).toBeNull();
    expect(canon.text).toContain('bytes = COALESCE(EXCLUDED.bytes, recording_media.bytes)');
    // The extract carries the archived row's own bytes.
    const ao = upserts.find((q) => q.params[0] === AO_ID)!;
    expect(ao.params[7]).toBe(AUDIO.length);
    // The archive stamp and Stage D's columns are never named by the upsert,
    // so they survive it (never overwritten with NULL).
    for (const q of upserts) {
      expect(q.text).not.toContain('local_evicted_at');
      expect(q.text).not.toContain('blob_name');
      expect(q.text).not.toContain('sha256');
    }
    // The stale-row DELETE keeps both ids …
    const del = ran(/DELETE FROM "[a-z_]+"\.recording_media/)[0]!;
    const keep = del.params.find((p) => Array.isArray(p)) as string[];
    expect(keep).toContain(CANON_ID);
    expect(keep).toContain(AO_ID);
    // … and no blob is queued for deletion.
    expect(ran(/media_blob_deletes/)).toHaveLength(0);
  });

  test('an archived extract of a file the meeting no longer names is still stale (dropped as before)', async () => {
    respond = graphResponder(mediaRows({ aoFilename: 'renamed-away.m4a' }));
    await sync.syncRecordingGraphForMeeting('u1', AAI);
    const upserts = ran(/INSERT INTO "[a-z_]+"\.recording_media/).map((q) => q.params[0]);
    expect(upserts).not.toContain(AO_ID);
    const keep = ran(/DELETE FROM "[a-z_]+"\.recording_media/)[0]!.params.find((p) => Array.isArray(p)) as string[];
    expect(keep).not.toContain(AO_ID);
  });

  test('the media rows cannot be read: derivatives are not judged at all this time', async () => {
    respond = (q) => {
      if (/FROM "[a-z_]+"\.transcripts t LEFT JOIN LATERAL/.test(q.text)) return [meetingRow()];
      if (/FROM "[a-z_]+"\.recording_media WHERE recording_id = \$\d+::uuid AND kind = 'audio_only'/.test(q.text)) {
        throw new Error('db hiccup');
      }
      return [];
    };
    await sync.syncRecordingGraphForMeeting('u1', AAI);
    const del = ran(/DELETE FROM "[a-z_]+"\.recording_media/)[0]!;
    // `filesProbed` false → only canonical/part rows may be judged stale.
    expect(del.params).toContain(false);
    expect(del.text).toContain("kind IN ('canonical', 'part')");
  });

  test('the extract on disk wins over the archived facts (its probed size)', async () => {
    writeFileSync(path.join(audioOnlyDir, `${AAI}.m4a`), new Uint8Array(77));
    respond = graphResponder(mediaRows());
    await sync.syncRecordingGraphForMeeting('u1', AAI);
    const ao = ran(/INSERT INTO "[a-z_]+"\.recording_media/).find((q) => q.params[0] === AO_ID)!;
    expect(ao.params[7]).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// A2 — orphan derivatives are a database decision
// ---------------------------------------------------------------------------

describe('A2: the orphan-derivative sweep asks the database, not the disk', () => {
  test('an extract whose source is named in the db (evicted canonical) stays; an unnamed one goes', async () => {
    writeFileSync(path.join(audioOnlyDir, 'evicted.m4a'), new Uint8Array(10));
    writeFileSync(path.join(audioOnlyDir, 'orphan.m4a'), new Uint8Array(10));
    writeFileSync(path.join(audioOnlyDir, 'live.m4a'), new Uint8Array(10));
    writeFileSync(path.join(audioDir, 'live.mp4'), new Uint8Array(10));
    respond = (q) => {
      if (/SELECT DISTINCT stem FROM/.test(q.text)) {
        const asked = q.params.find((p) => Array.isArray(p)) as string[];
        return asked.filter((s) => s === 'evicted').map((stem) => ({ stem }));
      }
      return [];
    };
    await sweeper.sweepOrphanDerivatives();
    expect(existsSync(path.join(audioOnlyDir, 'evicted.m4a'))).toBe(true);
    expect(existsSync(path.join(audioOnlyDir, 'live.m4a'))).toBe(true);
    expect(existsSync(path.join(audioOnlyDir, 'orphan.m4a'))).toBe(false);
    // Only the real orphan's row is dropped (and with it its blob queued).
    await until(() => ran(/DELETE FROM "[a-z_]+"\.recording_media WHERE kind IN \('audio_only', 'faststart'\)/).length > 0);
    const drops = ran(/DELETE FROM "[a-z_]+"\.recording_media WHERE kind IN \('audio_only', 'faststart'\)/);
    expect(drops).toHaveLength(1);
    expect(drops[0]!.params).toContainEqual(['orphan.m4a']);
  });

  test('the source lookup fails: nothing is removed this tick', async () => {
    writeFileSync(path.join(audioOnlyDir, 'evicted.m4a'), new Uint8Array(10));
    respond = (q) => {
      if (/SELECT DISTINCT stem FROM/.test(q.text)) throw new Error('db down');
      return [];
    };
    await sweeper.sweepOrphanDerivatives();
    expect(existsSync(path.join(audioOnlyDir, 'evicted.m4a'))).toBe(true);
    expect(ran(/DELETE FROM/)).toHaveLength(0);
  });

  test('the stem query reads every source shape (media rows, local_audio_path, videoParts)', async () => {
    writeFileSync(path.join(audioOnlyDir, 'x.m4a'), new Uint8Array(1));
    respond = () => [];
    await sweeper.sweepOrphanDerivatives();
    const q = ran(/SELECT DISTINCT stem FROM/)[0]!;
    expect(q.text).toContain("m.kind IN ('canonical', 'part')");
    expect(q.text).toContain('t.local_audio_path');
    expect(q.text).toContain("'videoParts'");
    // No `deleted_at` filter: a trashed meeting/recording can be restored.
    expect(q.text).not.toContain('deleted_at');
  });
});

// ---------------------------------------------------------------------------
// A3 — DEC-4's AssemblyAI delete counts an archived canonical as held
// ---------------------------------------------------------------------------

describe('A3: an archived canonical counts as "we hold the media"', () => {
  test('isArchivedMedia needs blob_name AND sha256', () => {
    expect(stored.isArchivedMedia({ filename: 'a', blob_name: 'b', sha256: 'c' })).toBe(true);
    expect(stored.isArchivedMedia({ filename: 'a', blob_name: 'b', sha256: null })).toBe(false);
    expect(stored.isArchivedMedia({ filename: 'a', blob_name: null, sha256: 'c' })).toBe(false);
    expect(stored.isArchivedMedia(null)).toBe(false);
  });

  test('the born-bare AAI-delete backlog no longer skips an evicted (archived) recording', async () => {
    process.env.MW_AAI_DELETE_ON_COMPLETE = '1';
    const asked: string[] = [];
    respond = (q) => {
      if (/m\.blob_name AS canonical_blob_name/.test(q.text)) {
        return [
          {
            transcription_id: 'txn-1',
            provider_job_id: 'job-1',
            utterances: 3,
            canonical_filename: 'evicted.mp4', // not on disk
            canonical_blob_name: CANON_BLOB,
            canonical_sha256: sha(VIDEO),
          },
          {
            transcription_id: 'txn-2',
            provider_job_id: 'job-2',
            utterances: 3,
            canonical_filename: 'gone.mp4', // not on disk, never archived
            canonical_blob_name: null,
            canonical_sha256: null,
          },
        ];
      }
      if (/recording_transcriptions/.test(q.text)) asked.push(q.text);
      return [];
    };
    // AssemblyAI's DELETE — the gate passed for job-1 only.
    const deleted: string[] = [];
    process.env.ASSEMBLYAI_API_KEY = 'test';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'DELETE') deleted.push(url);
      return new Response(JSON.stringify({ id: url.split('/').pop(), status: 'completed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await bornBare.sweepBornBare();
    } finally {
      delete process.env.MW_AAI_DELETE_ON_COMPLETE;
    }
    expect(deleted.some((u) => u.endsWith('/job-1'))).toBe(true);
    expect(deleted.some((u) => u.endsWith('/job-2'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4 — media prep: an archived, evicted file is "nothing to prepare"
// ---------------------------------------------------------------------------

describe('A4: prepareRow treats an archived missing file as done', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    user_id: 'u1',
    assemblyai_id: AAI,
    local_audio_path: `${AAI}.mp4`,
    gmeet_context: null,
    ...over,
  });
  const mediaStamp = () => {
    const q = ran(/UPDATE "[a-z_]+"\.transcripts/).find((x) => JSON.stringify(x.params).includes('"faststart"'));
    const json = q?.params.find((p) => p && typeof p === 'object' && 'media' in (p as object)) as
      | { media: Record<string, unknown> }
      | undefined;
    return json?.media ?? null;
  };

  test('archived: stamped done, no error, no attempt', async () => {
    respond = (q) =>
      /FROM "[a-z_]+"\.recording_media WHERE kind IN \('canonical', 'part'\) AND filename = ANY/.test(q.text)
        ? [{ filename: `${AAI}.mp4`, kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }]
        : [];
    await sweeper.prepareRow(row() as never, { nice: true, tag: '[test]' });
    const media = mediaStamp();
    expect(media).not.toBeNull();
    expect(media!.faststart).toBe(true);
    expect(media!.audioOnly).toBe(true);
    expect(media!.attempts).toBeUndefined();
    expect(media!.error).toBeUndefined();
    // Nothing was rebuilt into storage/.
    expect(readdirSync(audioOnlyDir)).toHaveLength(0);
  });

  test('not archived: still "file missing", counted as an attempt', async () => {
    respond = () => [];
    await sweeper.prepareRow(row() as never, { nice: true, tag: '[test]' });
    const media = mediaStamp();
    expect(media!.faststart).toBe(false);
    expect(media!.attempts).toBe(1);
    expect(String(media!.error)).toContain('file missing');
  });
});

// ---------------------------------------------------------------------------
// The shared helpers every B site goes through
// ---------------------------------------------------------------------------

describe('stored-media: presence and held reads', () => {
  test('storedFileSources: on disk → local size; evicted + archived → held with the row bytes; neither → not held', async () => {
    writeFileSync(path.join(audioDir, 'here.mp4'), new Uint8Array(33));
    respond = (q) =>
      /AND blob_name IS NOT NULL AND sha256 IS NOT NULL/.test(q.text)
        ? [{ filename: 'evicted.mp4', kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }]
        : [];
    const s = await stored.storedFileSources(['here.mp4', 'evicted.mp4', 'gone.mp4']);
    expect(s.get('here.mp4')).toMatchObject({ held: true, localBytes: 33, bytes: 33, archived: null });
    expect(s.get('evicted.mp4')).toMatchObject({ held: true, localBytes: null, bytes: VIDEO.length });
    expect(s.get('evicted.mp4')!.media).toMatchObject({ blobName: CANON_BLOB, sha256: sha(VIDEO), isVideo: true });
    expect(s.get('gone.mp4')).toMatchObject({ held: false, bytes: null });
    // Only the files NOT on disk were asked about.
    const asked = ran(/AND blob_name IS NOT NULL AND sha256 IS NOT NULL/)[0]!.params.find((p) => Array.isArray(p));
    expect(asked).toEqual(['evicted.mp4', 'gone.mp4']);
  });

  test('a failed archive lookup answers "missing", never "held"', async () => {
    respond = () => {
      throw new Error('db down');
    };
    const s = await stored.storedFileSource('evicted.mp4');
    expect(s.held).toBe(false);
  });

  test('withHeldStoredFiles: every file held while fn runs, all released after — disk and pulled alike', async () => {
    const onDisk = path.join(audioDir, 'here.mp4');
    writeFileSync(onDisk, VIDEO);
    const evicted = stored.localizableStoredFile('evicted.mp4', {
      blob_name: CANON_BLOB,
      sha256: sha(VIDEO),
      has_video: true,
      recording_id: REC,
    });
    let seen: boolean[] = [];
    let paths: string[] = [];
    const out = await stored.withHeldStoredFiles(
      [stored.localizableStoredFile('here.mp4', null), evicted],
      'canonical',
      'test',
      async (locals) => {
        paths = locals.map((l) => l.path);
        seen = paths.map((p) => local.localMediaHeld(p));
        return 'done';
      }
    );
    expect(out).toEqual({ ok: true, value: 'done' });
    expect(paths[0]).toBe(onDisk);
    expect(paths[1]!.startsWith(local.mediaCacheDir())).toBe(true);
    expect(seen).toEqual([true, true]);
    expect(paths.map((p) => local.localMediaHeld(p))).toEqual([false, false]);
    // A pulled copy never lands under storage/audio/.
    expect(readdirSync(audioDir)).toEqual(['here.mp4']);
  });

  test('withHeldStoredFiles: one file unobtainable → fn never runs, nothing stays held', async () => {
    writeFileSync(path.join(audioDir, 'here.mp4'), VIDEO);
    let ran2 = false;
    const out = await stored.withHeldStoredFiles(
      [stored.localizableStoredFile('here.mp4', null), stored.localizableStoredFile('gone.mp4', null)],
      'canonical',
      'test',
      async () => {
        ran2 = true;
      }
    );
    expect(out).toEqual({ ok: false });
    expect(ran2).toBe(false);
    expect(local.localMediaHeld(path.join(audioDir, 'here.mp4'))).toBe(false);
  });

  test("'canonical' never hands out the audio-only extract", async () => {
    writeFileSync(path.join(audioOnlyDir, 'evicted.m4a'), AUDIO);
    const media = {
      ...stored.localizableStoredFile('evicted.mp4', {
        blob_name: CANON_BLOB,
        sha256: sha(VIDEO),
        has_video: true,
        recording_id: REC,
      }),
      audioOnly: { filename: 'evicted.m4a', blobName: AO_BLOB },
    };
    const out = await stored.withHeldStoredFiles([media], 'canonical', 'test', async ([l]) => l!.source);
    expect(out).toEqual({ ok: true, value: 'blob' });
  });
});

// ---------------------------------------------------------------------------
// B — the long readers hold what they read
// ---------------------------------------------------------------------------

/** A fake AssemblyAI: records whether `held` was true when the upload arrived. */
function fakeAai(held: () => boolean, opts: { failUpload?: boolean } = {}) {
  const calls = { upload: 0, heldAtUpload: [] as boolean[] };
  process.env.ASSEMBLYAI_API_KEY = 'test';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v2/upload')) {
      calls.upload++;
      calls.heldAtUpload.push(held());
      if (opts.failUpload) return new Response('{"error":"nope"}', { status: 500 });
      return Response.json({ upload_url: 'https://cdn.example/x' });
    }
    return Response.json({ id: 'job-new', status: 'queued' });
  }) as typeof fetch;
  return calls;
}

describe('B4: born-bare resend uploads a held file, evicted or not', () => {
  const recRow = {
    id: REC,
    owner_user_id: 'u1',
    source_kind: 'upload',
    created_at: '2026-09-23T01:00:00Z',
    title: null,
    expires_at: null,
    upload_state: { originalFilename: 'call.mp4', ingestFailure: { stage: 'aai-upload', attempts: 1 } },
    standalone: true,
    active_transcription_id: null,
    deleted_at: null,
  };
  const canonical = (over: Record<string, unknown> = {}) => ({
    id: CANON_ID,
    kind: 'canonical',
    ord: 0,
    filename: 'evicted.mp4',
    blob_name: CANON_BLOB,
    has_video: true,
    sha256: sha(VIDEO),
    bytes: VIDEO.length,
    of_media_id: null,
    ...over,
  });
  function responder(media: unknown[]) {
    return (q: RenderedQuery): unknown[] => {
      if (/FROM "[a-z_]+"\.recordings/.test(q.text) && /standalone/.test(q.text) && /SELECT/.test(q.text) && !/UPDATE/.test(q.text)) {
        return [recRow];
      }
      if (/SELECT id, kind, ord, filename, blob_name, has_video, sha256/.test(q.text)) return media;
      return [];
    };
  }

  test('evicted + archived: pulled into the cache, held through the upload, released after', async () => {
    respond = responder([canonical()]);
    const cachePath = local.cacheFileFor(CANON_BLOB);
    const calls = fakeAai(() => local.localMediaHeld(cachePath), { failUpload: true });
    await bornBare.retryBornBareIngest(REC);
    expect(calls.upload).toBe(1);
    expect(calls.heldAtUpload).toEqual([true]);
    expect(local.localMediaHeld(cachePath)).toBe(false);
  });

  test('on disk: the stored file itself is held through the upload', async () => {
    const onDisk = path.join(audioDir, 'here.mp4');
    writeFileSync(onDisk, VIDEO);
    respond = responder([canonical({ filename: 'here.mp4', blob_name: null, sha256: null })]);
    const calls = fakeAai(() => local.localMediaHeld(onDisk), { failUpload: true });
    await bornBare.retryBornBareIngest(REC);
    expect(calls.heldAtUpload).toEqual([true]);
    expect(local.localMediaHeld(onDisk)).toBe(false);
  });

  test('neither on disk nor archived: refused as before, nothing uploaded', async () => {
    respond = responder([canonical({ blob_name: null, sha256: null })]);
    const calls = fakeAai(() => false);
    expect(await bornBare.retryBornBareIngest(REC)).toBe(false);
    expect(calls.upload).toBe(0);
  });
});

describe('B3: Phase 2 "Transcribe again" accepts an archived canonical and holds it through the upload', () => {
  function responder(over: { archived: boolean }) {
    return (q: RenderedQuery): unknown[] => {
      if (/count\(\*\)/.test(q.text) && /transcripts/.test(q.text) && /assemblyai_id/.test(q.text)) return [{ n: 1, count: 1 }];
      if (/FROM "[a-z_]+"\.meeting_clips/.test(q.text) && /recording_id/.test(q.text) && /SELECT/.test(q.text)) {
        return [{ recording_id: REC, clips: 1, active_transcription_id: null }];
      }
      if (/AND blob_name IS NOT NULL AND sha256 IS NOT NULL/.test(q.text)) {
        return over.archived
          ? [{ filename: `${AAI}.mp4`, kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }]
          : [];
      }
      if (/UPDATE "[a-z_]+"\.transcripts/.test(q.text) && /retranscribing/.test(q.text)) return [{ id: 1 }];
      return [];
    };
  }
  const input = () => ({
    row: meetingRow({ status: 'completed', gmeet_context: {} }) as never,
    ownerUserId: 'u1',
    speechModel: 'universal-3-pro' as never,
    languageCode: 'en',
    force: true,
    by: { email: 'a@trames.sg', name: 'A' },
    reason: null,
  });

  test('evicted + archived: started (not 422), the pulled copy held during the upload, released after', async () => {
    process.env.MW_TRANSCRIPTION_VERSIONS = '1';
    respond = responder({ archived: true });
    const cachePath = local.cacheFileFor(CANON_BLOB);
    const calls = fakeAai(() => local.localMediaHeld(cachePath), { failUpload: true });
    const out = await runs.startTranscriptionRun(input() as never);
    expect(out.kind).toBe('started');
    expect(await until(() => calls.upload === 1)).toBe(true);
    expect(calls.heldAtUpload).toEqual([true]);
    expect(await until(() => !local.localMediaHeld(cachePath))).toBe(true);
  });

  test('neither on disk nor archived: 422 as before', async () => {
    process.env.MW_TRANSCRIPTION_VERSIONS = '1';
    respond = responder({ archived: false });
    const out = await runs.startTranscriptionRun(input() as never);
    expect(out).toMatchObject({ kind: 'refused', status: 422 });
  });
});

describe('B7: ingest retry of an evicted row ingests a COPY made while the pulled file was held', () => {
  test('the copy lands under the audio dir, the cache entry is released before the hand-off', async () => {
    const failure = {
      stage: 'aai-upload',
      firstAt: '2026-10-01T00:00:00Z',
      at: '2026-10-01T00:00:00Z',
      attempts: 1,
      retryable: true,
      nextAt: null,
      message: 'boom',
      opts: { originalFilename: 'board.mp4' },
    };
    const cachePath = local.cacheFileFor(CANON_BLOB);
    let atReset: { copies: string[]; held: boolean } | null = null;
    respond = (q) => {
      if (/SELECT/.test(q.text) && /FROM "[a-z_]+"\.transcripts/.test(q.text) && q.params.includes(AAI) && !/UPDATE/.test(q.text)) {
        return [meetingRow({ status: 'error', gmeet_context: { ingestFailure: failure } })];
      }
      if (/AND blob_name IS NOT NULL AND sha256 IS NOT NULL/.test(q.text)) {
        return [{ filename: `${AAI}.mp4`, kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }];
      }
      if (/UPDATE "[a-z_]+"\.transcripts/.test(q.text) && /'uploading'/.test(q.text)) {
        atReset = {
          copies: readdirSync(audioDir).filter((f) => f.startsWith('upload-')),
          held: local.localMediaHeld(cachePath),
        };
        return []; // "row changed under us" — stop before the real ingest
      }
      return [];
    };
    const out = await ingestRetry.retryIngest({ user_id: 'u1', assemblyai_id: AAI }, 'manual');
    expect(out).toEqual({ ok: false, error: 'Row changed under us' });
    expect(atReset).not.toBeNull();
    expect(atReset!.copies).toHaveLength(1);
    expect(atReset!.held).toBe(false);
    // The aborted retry's copy is cleaned up; the cache entry is untouched.
    expect(readdirSync(audioDir).filter((f) => f.startsWith('upload-'))).toHaveLength(0);
    expect(existsSync(cachePath)).toBe(true);
  });

  test('not archived and not on disk: non-retryable as before', async () => {
    const failure = { stage: 'aai-upload', attempts: 1, retryable: true, message: 'boom', opts: { originalFilename: 'x' } };
    respond = (q) =>
      /SELECT/.test(q.text) && /FROM "[a-z_]+"\.transcripts/.test(q.text) && q.params.includes(AAI) && !/UPDATE/.test(q.text)
        ? [meetingRow({ status: 'error', gmeet_context: { ingestFailure: failure } })]
        : [];
    const out = await ingestRetry.retryIngest({ user_id: 'u1', assemblyai_id: AAI }, 'manual');
    expect(out).toEqual({ ok: false, error: 'Stored file is missing — cannot retry' });
  });
});

describe('B2: line-up holds the file the sidecar reads until it has answered', () => {
  const REC_B = 'bbbbbbbb-2222-5222-8222-bbbbbbbbbbbb';
  function responder() {
    return (q: RenderedQuery): unknown[] => {
      if (/FROM "[a-z_]+"\.recording_media WHERE recording_id = ANY/.test(q.text)) {
        const id = (q.params.find((p) => Array.isArray(p)) as string[])[0];
        if (id === REC) return mediaRows();
        return [
          {
            ...mediaRows()[0],
            id: 'cccccccc-3333-5333-8333-cccccccccccc',
            recording_id: REC_B,
            filename: 'b-here.m4a',
            has_video: false,
            blob_name: null,
            sha256: null,
          },
        ];
      }
      if (/FROM "[a-z_]+"\.recordings/.test(q.text)) {
        const id = q.params.find((p) => p === REC || p === REC_B);
        return [{ id: id ?? REC, owner_user_id: 'u1', started_at: '2026-09-01T10:00:00Z', deleted_at: null, standalone: false }];
      }
      return [];
    };
  }

  test('one evicted (pulled extract) + one on disk: both held during /align, both released after', async () => {
    const onDisk = path.join(audioDir, 'b-here.m4a');
    writeFileSync(onDisk, AUDIO);
    respond = responder();
    const pulled = local.cacheFileFor(AO_BLOB);
    let heldAtAlign: boolean[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { a: string; b: string };
      heldAtAlign = [body.a, body.b].map((p) => local.localMediaHeld(p));
      expect([body.a, body.b].sort()).toEqual([onDisk, pulled].sort());
      return Response.json({ offsetMs: 0, confidence: 0.9, driftPpm: null, method: 'env', overlapMs: 1000 });
    }) as typeof fetch;
    const out = await align.alignRecordings({
      caller: { userId: 'u1', email: 'a@trames.sg' },
      recordingId: REC_B,
      againstRecordingId: REC,
    });
    expect(heldAtAlign).toEqual([true, true]);
    expect(local.localMediaHeld(onDisk)).toBe(false);
    expect(local.localMediaHeld(pulled)).toBe(false);
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B6 — the combine reads every input through media-local, held for ffmpeg
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_FFMPEG)('B6: combining a meeting whose primary was evicted', () => {
  test('one input on disk + one pulled from the archive: both held while ffmpeg runs, released after', async () => {
    const tone = (out: string, freq: number) =>
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`,
        '-c:a', 'aac', '-b:a', '64k', out,
      ]);
    const evictedSrc = path.join(root, 'evicted-src.m4a');
    tone(evictedSrc, 440);
    tone(path.join(audioDir, 'part2.m4a'), 660);
    const { readFileSync } = await import('node:fs');
    const bytes = new Uint8Array(readFileSync(evictedSrc));
    store.put('r/evicted.m4a', bytes, 'audio/mp4');
    const sources = await stored.storedFileSources(['part2.m4a']);
    const inputs = [
      stored.localizableStoredFile('evicted.m4a', { blob_name: 'r/evicted.m4a', sha256: sha(bytes), has_video: false, recording_id: REC }),
      sources.get('part2.m4a')!.media,
    ];
    let heldDuring: boolean[] = [];
    let used: string[] = [];
    const out = await stored.withHeldStoredFiles(inputs, 'canonical', 'gmeet combine', async (locals) => {
      used = locals.map((l) => l.path);
      const p = concatMediaPathsToTemp(used);
      heldDuring = used.map((u) => local.localMediaHeld(u));
      return p;
    });
    expect(out.ok).toBe(true);
    expect(heldDuring).toEqual([true, true]);
    expect(used.map((u) => local.localMediaHeld(u))).toEqual([false, false]);
    if (out.ok) {
      const dur = Number(
        execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(audioDir, out.value)])
          .toString()
          .trim()
      );
      expect(Math.abs(dur - 4)).toBeLessThan(0.3);
    }
    // The evicted primary was not written back under storage/audio.
    expect(existsSync(path.join(audioDir, 'evicted.m4a'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2 / C3 — what the routes report and serve for an evicted meeting
// ---------------------------------------------------------------------------

describe('C2: the offline plan still sees an evicted meeting’s media', () => {
  test('evicted + archived → hasLocal, the archived size; never stored → no media', async () => {
    respond = (q) => {
      if (/offline_prefs FROM/.test(q.text)) return [];
      if (/local_audio_path/.test(q.text) && /rev/.test(q.text) && /FROM "[a-z_]+"\.transcripts/.test(q.text)) {
        return [
          { id: 1, assemblyai_id: 'm-evicted', title: 'E', recorded_at: null, created_at: '2026-09-01T10:00:00Z', duration: 18, provider: null, local_audio_path: 'evicted.mp4', video_parts: null, clips: null, rev: 'r1' },
          { id: 2, assemblyai_id: 'm-gone', title: 'G', recorded_at: null, created_at: '2026-09-01T10:00:00Z', duration: 18, provider: null, local_audio_path: 'gone.mp4', video_parts: null, clips: null, rev: 'r2' },
        ];
      }
      if (/AND blob_name IS NOT NULL AND sha256 IS NOT NULL/.test(q.text)) {
        return [{ filename: 'evicted.mp4', kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }];
      }
      return [];
    };
    const res = await (offlinePlan.GET as unknown as (r: Request, c: unknown) => Promise<Response>)(
      Object.assign(new Request('http://x/api/offline/plan'), { nextUrl: new URL('http://x/api/offline/plan') }) as never,
      {}
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meetings: Array<{ id: string; media: { hasLocal: boolean; parts: Array<{ bytes: number | null }> } }> };
    const evicted = body.meetings.find((m) => m.id === 'm-evicted')!;
    expect(evicted.media.hasLocal).toBe(true);
    expect(evicted.media.parts[0]!.bytes).toBe(VIDEO.length);
    const gone = body.meetings.find((m) => m.id === 'm-gone')!;
    expect(gone.media.hasLocal).toBe(false);
  });
});

describe('C3: /api/recordings/:id/audio?variant=audio with both local files gone', () => {
  function responder(withExtract: boolean) {
    return (q: RenderedQuery): unknown[] => {
      if (/FROM "[a-z_]+"\.recordings WHERE id = /.test(q.text)) {
        return [{ id: REC, owner_user_id: 'u1', source_kind: 'upload', started_at: null, duration_ms: null, deleted_at: null }];
      }
      if (/SELECT id, kind, ord, filename, blob_name, has_video, sha256/.test(q.text)) {
        const [c, ao] = mediaRows();
        return withExtract ? [c, ao] : [c];
      }
      return [];
    };
  }
  const get = (variant: string | null) =>
    (recordingAudio.GET as unknown as (r: Request, c: unknown) => Promise<Response>)(
      Object.assign(new Request(`http://x/api/recordings/${REC}/audio${variant ? `?variant=${variant}` : ''}`), {
        nextUrl: new URL(`http://x/api/recordings/${REC}/audio${variant ? `?variant=${variant}` : ''}`),
      }) as never,
      { params: Promise.resolve({ id: REC }) }
    );

  test('the archived extract is proxied, not the whole video', async () => {
    process.env.MW_MEDIA_FROM_BLOB = '1';
    respond = responder(true);
    const res = await get('audio');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(AUDIO);
  });

  test('no archived extract: the canonical, as before', async () => {
    process.env.MW_MEDIA_FROM_BLOB = '1';
    respond = responder(false);
    const res = await get('audio');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO);
  });

  test('without variant=audio the canonical is served', async () => {
    process.env.MW_MEDIA_FROM_BLOB = '1';
    respond = responder(true);
    const res = await get(null);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(VIDEO);
  });
});

// ---------------------------------------------------------------------------
// B5 — the legacy (new-row) re-transcribe of an evicted meeting. LAST: it
// leaves the pipeline's fire-and-forget finalize running in the background.
// ---------------------------------------------------------------------------

describe('B5: legacy re-transcribe accepts an archived source and COPIES the held pull', () => {
  test('202, the temp is a copy (not a link) of the pulled file, held while copied and released after', async () => {
    const cachePath = local.cacheFileFor(CANON_BLOB);
    let atMark: { temps: string[]; held: boolean; sameInode: boolean } | null = null;
    respond = (q) => {
      if (/FROM "[a-z_]+"\.transcripts t LEFT JOIN "[a-z_]+"\.transcript_shares s/.test(q.text)) {
        return [{ ...meetingRow({ local_audio_path: 'evicted.mp4', speech_model: 'universal' }), __access: 'owner' }];
      }
      if (/AND blob_name IS NOT NULL AND sha256 IS NOT NULL/.test(q.text)) {
        return [{ filename: 'evicted.mp4', kind: 'canonical', recording_id: REC, blob_name: CANON_BLOB, sha256: sha(VIDEO), bytes: VIDEO.length, has_video: true }];
      }
      if (/\.transcripts\b/.test(q.text) && /RETURNING/i.test(q.text) && /INSERT/.test(q.text)) {
        return [{ id: 4242, user_id: 'u1', assemblyai_id: 'up-new', status: 'uploading', gmeet_context: null }];
      }
      if (/UPDATE "[a-z_]+"\.transcripts/.test(q.text) && JSON.stringify(q.params).includes('"retranscribed"') && !atMark) {
        const temps = readdirSync(audioDir);
        atMark = {
          temps,
          held: local.localMediaHeld(cachePath),
          sameInode: temps.some((t) => statSync(path.join(audioDir, t)).ino === statSync(cachePath).ino),
        };
      }
      return [];
    };
    fakeAai(() => false, { failUpload: true });
    const res = await (retranscribeRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(
      new Request(`http://x/api/transcripts/${AAI}/retranscribe`, { method: 'POST' }) as never,
      { params: Promise.resolve({ id: AAI }) }
    );
    expect(res.status).toBe(202);
    expect(((await res.json()) as { mode: string }).mode).toBe('new-row');
    expect(atMark).not.toBeNull();
    expect(atMark!.temps).toHaveLength(1); // the copy, under the audio dir
    expect(atMark!.held).toBe(true); // still held while it was being made
    expect(atMark!.sameInode).toBe(false); // a copy, never a second name on the cache entry
    expect(local.localMediaHeld(cachePath)).toBe(false);
    expect(existsSync(path.join(audioDir, 'evicted.mp4'))).toBe(false);
  });

  test('neither on disk nor archived: 422 as before', async () => {
    respond = (q) =>
      /FROM "[a-z_]+"\.transcripts t LEFT JOIN "[a-z_]+"\.transcript_shares s/.test(q.text)
        ? [{ ...meetingRow({ local_audio_path: 'gone.mp4', speech_model: 'universal' }), __access: 'owner' }]
        : [];
    const res = await (retranscribeRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(
      new Request(`http://x/api/transcripts/${AAI}/retranscribe`, { method: 'POST' }) as never,
      { params: Promise.resolve({ id: AAI }) }
    );
    expect(res.status).toBe(422);
  });
});

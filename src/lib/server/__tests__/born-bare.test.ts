/**
 * Design P7/P8 — an upload that names no meeting is born a RECORDING
 * (`MW_RECORDINGS_BORN_BARE`), linking it makes the meeting and shares
 * nothing, and everything about it is its owner's alone (invariant I2).
 *
 * Over the fake postgres tag (db-ops/__tests__/helpers/fake-sql): every query
 * is rendered and logged, so the assertions are on the SQL the code actually
 * ran. The end-to-end half — a real scratch Postgres, the routes, two users,
 * the sweeper, `/content` verbatim in both reader modes — is the P7 scratch
 * check recorded in docs/recordings-meetings-series-design.md "As built —
 * P7/P8".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const A = { kind: 'session' as const, userId: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'Alok@trames.sg', modules: ['meetings'], scope: 'readwrite' as const };
const RID = 'c0ffee00-0000-4000-8000-000000000001';

let pipeline: typeof import('@/lib/server/upload-pipeline');
let standalone: typeof import('@/db-ops/standalone-recordings');
let view: typeof import('@/lib/recording-view');

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  pipeline = await import('@/lib/server/upload-pipeline');
  standalone = await import('@/db-ops/standalone-recordings');
  view = await import('@/lib/recording-view');
});

const ENV_KEYS = ['MW_RECORDINGS_BORN_BARE', 'MW_RECORDINGS_WRITE'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const g = globalThis as { __mwStandaloneColumns?: unknown; __mwAaiJobIdColumn?: unknown };
  g.__mwStandaloneColumns = undefined;
  g.__mwAaiJobIdColumn = undefined;
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => {
    if (q.text.includes('information_schema.columns')) {
      return [{ n: q.text.includes("'standalone'") ? 6 : 1 }];
    }
    if (/INSERT INTO "[a-z_]+"\.recordings AS r/.test(q.text)) {
      return [
        {
          id: RID,
          owner_user_id: A.userId,
          source_kind: 'upload',
          created_at: '2026-09-23T01:00:00.000Z',
          title: null,
          expires_at: null,
          upload_state: { originalFilename: 'call.m4a' },
          standalone: true,
        },
      ];
    }
    if (/\.transcripts\b/.test(q.text) && /RETURNING/i.test(q.text)) {
      return [{ id: 1, user_id: A.userId, assemblyai_id: 'up-x', status: 'uploading', gmeet_context: null }];
    }
    return [];
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const open = (over: Partial<Parameters<typeof pipeline.openUpload>[1]> = {}) =>
  pipeline.openUpload(A, {
    originalFilename: 'call.m4a',
    contentType: 'audio/mp4',
    linkedEvent: null,
    reportPref: null,
    bytesTotal: 16,
    uuid: RID,
    ...over,
  });

const touchedRecordings = () => sql.executed.filter((q) => /"[a-z_]+"\.recordings\b/.test(q.text));
const transcriptInserts = () => sql.executed.filter((q) => /INSERT INTO "[a-z_]+"\.transcripts\b/.test(q.text));

describe('the flag', () => {
  test('OFF: an unlinked upload is born a meeting placeholder, exactly as before — not one new query', async () => {
    delete process.env.MW_RECORDINGS_BORN_BARE;
    process.env.MW_RECORDINGS_WRITE = '1';
    const out = await open();
    expect(out.ok && out.spec.placeholderId).toBe(`up-${RID}`);
    expect(out.ok && out.spec.bornBare).toBeUndefined();
    expect(transcriptInserts().length).toBe(1);
    expect(touchedRecordings().length).toBe(0);
    expect(sql.executed.some((q) => q.text.includes("'standalone'"))).toBe(false);
  });

  test('ON but MW_RECORDINGS_WRITE off: ignored (the graph cleanup is what keeps a recording’s file)', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    delete process.env.MW_RECORDINGS_WRITE;
    const out = await open();
    expect(out.ok && out.spec.placeholderId).toBe(`up-${RID}`);
    expect(touchedRecordings().length).toBe(0);
  });

  test('ON, 049 missing: ignored', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    process.env.MW_RECORDINGS_WRITE = '1';
    respond = (q) =>
      q.text.includes('information_schema.columns')
        ? [{ n: q.text.includes("'standalone'") ? 0 : 1 }]
        : /RETURNING/i.test(q.text)
          ? [{ id: 1, assemblyai_id: 'up-x', status: 'uploading' }]
          : [];
    const out = await open();
    expect(out.ok && out.spec.placeholderId).toBe(`up-${RID}`);
  });

  test('ON: an unlinked upload creates the caller’s recording and NO transcripts row', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    process.env.MW_RECORDINGS_WRITE = '1';
    const out = await open({ scratch: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spec.placeholderId).toBe(`rec-${RID}`);
    expect(out.spec.bornBare).toEqual({ recordingId: RID });
    expect(transcriptInserts().length).toBe(0);
    const insert = sql.executed.find((q) => /INSERT INTO "[a-z_]+"\.recordings AS r/.test(q.text))!;
    expect(insert.params).toContain(A.userId);
    // P8: a temporary upload is a recording with an expiry, ~30 days out.
    const expiry = insert.params.find((p) => p instanceof Date) as Date;
    expect(Math.round((expiry.getTime() - Date.now()) / 86_400_000)).toBe(30);
    // The client-facing answer is the pseudo id every client already reads.
    expect((out.placeholder as { assemblyai_id: string }).assemblyai_id).toBe(`rec-${RID}`);
  });

  test('ON: an upload that NAMES a meeting is still born one (event / attach / re-run source)', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    process.env.MW_RECORDINGS_WRITE = '1';
    expect(pipeline.namesNoMeeting({ linkedEvent: null } as never)).toBe(true);
    expect(pipeline.namesNoMeeting({ linkedEvent: { id: 'e' } } as never)).toBe(false);
    expect(pipeline.namesNoMeeting({ linkedEvent: null, attachTo: { meetingId: 'm' } } as never)).toBe(false);
    expect(pipeline.namesNoMeeting({ linkedEvent: null, sourceId: 'x' } as never)).toBe(false);
    expect(pipeline.namesNoMeeting({ linkedEvent: null, contextExtra: { retranscribedFrom: 'x' } } as never)).toBe(false);
    const out = await open({ linkedEvent: { id: 'evt', title: 'Board', startTime: '2026-09-22T07:30:00.000Z' } });
    expect(out.ok && out.spec.placeholderId).toBe(`up-${RID}`);
    expect(touchedRecordings().length).toBe(0);
  });
});

describe('owner-scoped SQL (I2)', () => {
  test('every caller-scoped read constrains on the owner in SQL', async () => {
    await standalone.getStandaloneForOwner(A.userId, RID);
    await standalone.getStandaloneViewForOwner(A.userId, RID);
    await standalone.getStandalonePayloadForOwner(A.userId, RID);
    await standalone.keepStandalone(A.userId, RID, { keep: true });
    for (const q of sql.executed) {
      expect(q.text).toMatch(/owner_user_id = \$/);
      expect(q.params).toContain(A.userId);
    }
  });

  test('a junk id asks nothing at all', async () => {
    expect(await standalone.getStandaloneForOwner(A.userId, 'rec-../../etc')).toBeNull();
    expect(await standalone.reachableThroughMeeting('not-a-uuid', A)).toBe(false);
    expect(sql.executed.length).toBe(0);
  });

  test('the meeting arm: owner of the meeting, or a share on the LOWER-CASED email — nothing else', async () => {
    await standalone.reachableThroughMeeting(RID, A);
    const q = sql.executed[0]!;
    expect(q.text).toContain('meeting_clips');
    expect(q.text).toContain('t.user_id = $');
    expect(q.text).toContain('s.shared_with_email = $');
    expect(q.params).toContain('alok@trames.sg');
    expect(q.params).not.toContain('Alok@trames.sg');
  });

  test('Link/Make a meeting: one transaction, locked on the owner, text copied in SQL, NO share written', async () => {
    respond = (q) => {
      if (q.text.includes('FOR UPDATE')) return [{ id: RID, active_transcription_id: 't1' }];
      if (q.text.includes('FROM') && q.text.includes('recording_transcriptions') && q.text.includes('has_payload')) {
        return [{ status: 'completed', provider_job_id: 'job-1', provider_deleted_at: null, has_payload: true }];
      }
      if (/INSERT INTO "[a-z_]+"\.transcripts/.test(q.text)) return [{ id: 77, assemblyai_id: 'm-1' }];
      return [];
    };
    const out = await standalone.createMeetingFromRecording({
      ownerUserId: A.userId,
      recordingId: RID,
      meetingId: 'm-1',
      title: 'Weekly',
      recordedAt: null,
      gmeetContext: {},
    });
    expect(out).toEqual({ ok: true, transcriptId: 77, assemblyaiId: 'm-1', ready: true });
    const lock = sql.executed.find((q) => q.text.includes('FOR UPDATE'))!;
    expect(lock.text).toContain('owner_user_id = $');
    expect(lock.params).toContain(A.userId);
    const insert = sql.executed.find((q) => /INSERT INTO "[a-z_]+"\.transcripts/.test(q.text))!;
    expect(insert.text).toContain('t.payload');
    const ctx = insert.params.find((p) => p && typeof p === 'object' && 'clips' in (p as object)) as {
      clips: Array<{ recordingId: string; fromMs: number; toMs: null; offsetMs: number }>;
    };
    expect(ctx.clips).toEqual([{ ord: 0, recordingId: RID, fromMs: 0, toMs: null, offsetMs: 0 }] as never);
    expect(sql.executed.some((q) => q.text.includes('meeting_clips') && q.text.includes('INSERT'))).toBe(true);
    expect(sql.executed.some((q) => /expires_at = NULL/.test(q.text))).toBe(true);
    expect(sql.executed.some((q) => q.text.includes('transcript_shares'))).toBe(false);
  });

  test('Link takes a recording that is still uploading or transcribing — the meeting is born processing', async () => {
    respond = (q) =>
      q.text.includes('FOR UPDATE')
        ? [{ id: RID, active_transcription_id: null }]
        : /INSERT INTO "[a-z_]+"\.transcripts/.test(q.text)
          ? [{ id: 78, assemblyai_id: 'm' }]
          : [];
    const early = await standalone.createMeetingFromRecording({
      ownerUserId: A.userId, recordingId: RID, meetingId: 'm', title: null, recordedAt: null, gmeetContext: {},
    });
    expect(early).toEqual({ ok: true, transcriptId: 78, assemblyaiId: 'm', ready: false });
    const insert = sql.executed.find((q) => /INSERT INTO "[a-z_]+"\.transcripts/.test(q.text))!;
    // Not ready: status 'processing', no job id and no payload (the CASE arms
    // take `ready` = false), joined LEFT so a recording with no transcription
    // yet (still uploading) inserts too.
    expect(insert.text).toContain('LEFT JOIN');
    expect(insert.params).toContain(false);
    expect(insert.params).not.toContain(true);
    expect(sql.executed.some((q) => q.text.includes('meeting_clips') && q.text.includes('INSERT'))).toBe(true);
  });

  test('Link refuses a recording whose transcription FAILED, and one a live meeting already holds', async () => {
    respond = (q) =>
      q.text.includes('FOR UPDATE')
        ? [{ id: RID, active_transcription_id: 't-err' }]
        : q.text.includes('recording_transcriptions')
          ? [{ status: 'error', provider_job_id: null, provider_deleted_at: null, has_payload: false }]
          : [];
    const failed = await standalone.createMeetingFromRecording({
      ownerUserId: A.userId, recordingId: RID, meetingId: 'm', title: null, recordedAt: null, gmeetContext: {},
    });
    expect(failed).toEqual({ ok: false, code: 'not-ready' });
    expect(sql.executed.some((q) => /INSERT INTO "[a-z_]+"\.transcripts/.test(q.text))).toBe(false);
    respond = (q) =>
      q.text.includes('FOR UPDATE') ? [{ id: RID, active_transcription_id: 't1' }] : q.text.includes('SELECT 1 AS n') ? [{ n: 1 }] : [];
    const linked = await standalone.createMeetingFromRecording({
      ownerUserId: A.userId, recordingId: RID, meetingId: 'm', title: null, recordedAt: null, gmeetContext: {},
    });
    expect(linked).toEqual({ ok: false, code: 'already-linked' });
    expect(sql.executed.some((q) => /INSERT INTO "[a-z_]+"\.transcripts/.test(q.text))).toBe(false);
  });

  test('the sweeper never lists a recording any meeting clips (I6)', async () => {
    await standalone.listExpiredStandalone(10);
    const q = sql.executed[0]!;
    expect(q.text).toContain('expires_at < now()');
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM "[a-z_]+"\.meeting_clips c WHERE c\.recording_id = r\.id\)/);
  });
});

describe('the recording view (pure)', () => {
  const base = {
    id: RID,
    pseudo_id: `rec-${RID}`,
    title: null,
    source_kind: 'recorder',
    status: 'ready' as const,
    status_note: null,
    started_at: '2026-09-20T14:00:00.000Z',
    created_at: '2026-09-20T15:00:00.000Z',
    duration_sec: 2531,
    speaker_count: 3,
    language_code: 'en',
    original_filename: 'call.m4a',
    bytes: 1000,
    has_video: false,
    part_count: 0,
    expires_at: null,
    temporary: false,
    upload: null,
    meetings: [],
    in_meeting: false,
    suggested_event: null,
    recorder_recording_id: null,
  };
  const fmt = { fmtBytes: (n: number) => `${n}B`, fmtDuration: (s: number) => `${s}s` };

  test('never a filename as the title', () => {
    expect(view.recordingDisplayTitle(base, () => 'Sat 20 Sept 22:00')).toBe('Recording · Sat 20 Sept 22:00');
    expect(view.recordingDisplayTitle({ ...base, title: 'harshil, ivan (DM)' }, () => 'x')).toBe('harshil, ivan (DM)');
  });

  test('the strip says what the recording is doing', () => {
    expect(view.stripForRecordingView(base, fmt).text).toBe('Transcribed · 2531s · 3 speakers');
    expect(view.stripForRecordingView({ ...base, status: 'transcribing' }, fmt).state).toBe('transcribing');
    const up = view.stripForRecordingView(
      { ...base, status: 'uploading', upload: { bytes_received: 50, bytes_total: 200 } },
      fmt
    );
    expect(up.text).toBe('Uploading · 25% · 50B of 200B');
    expect(view.stripForRecordingView({ ...base, status: 'failed', status_note: 'boom' }, fmt).text).toBe('boom');
    expect(view.stripForRecordingView(base, fmt).source).toBe('mac');
  });

  test('expiry copy', () => {
    const now = Date.parse('2026-09-23T00:00:00.000Z');
    expect(view.expiresCopy(null, now)).toBeNull();
    expect(view.expiresCopy('2026-10-05T00:00:00.000Z', now)).toBe('expires in 12 days');
    expect(view.expiresCopy('2026-09-22T00:00:00.000Z', now)).toBe('expires today');
  });
});

describe('source-level: the recording surfaces carry no sharing controls, and the media route states its two arms', () => {
  const root = join(import.meta.dir, '..', '..', '..');
  const read = (p: string) => readFileSync(join(root, p), 'utf8');

  test('the recording page has no share / notes / labels / series controls', () => {
    const page = read('app/recording/[id]/page.tsx');
    for (const banned of ['ShareDialog', 'share-dialog', 'LabelPicker', 'SeriesDialog', '/shares', 'generate-dialog', 'auto_notes']) {
      expect(page).not.toContain(banned);
    }
    expect(page).toContain('/api/recordings/${id}/audio');
    expect(page).not.toContain('/api/transcripts/${id}');
  });

  test('the media route: owner, or a meeting the caller can open — and 404 otherwise', () => {
    const route = read('app/api/recordings/[id]/audio/route.ts');
    expect(route).toContain('getRecordingForOwner(user.userId, id)');
    expect(route).toContain('reachableThroughMeeting(id, user)');
    expect(route).toContain("if (!allowed) return notFound();");
  });

  test('the owner routes answer 404 — never 403 — for someone else’s recording', () => {
    for (const p of [
      'app/api/recordings/[id]/route.ts',
      'app/api/recordings/[id]/content/route.ts',
      'app/api/recordings/[id]/link/route.ts',
      'app/api/recordings/[id]/make-meeting/route.ts',
    ]) {
      const src = read(p);
      expect(src).not.toContain('status: 403');
    }
    const actions = read('lib/server/recording-actions.ts');
    expect(actions).toContain("const NOT_FOUND = { ok: false as const, status: 404, error: 'Not found' };");
    expect(actions).not.toMatch(/INSERT INTO[^`]*transcript_shares/);
  });
});

describe('the tray’s “Open transcript” on a recording', () => {
  test('/transcript/rec-<id> redirects to /recording/<id> (query kept), nothing else does', async () => {
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('@/proxy');
    const res = await proxy(new NextRequest(`http://localhost/transcript/rec-${RID.toUpperCase()}?link=1`));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`http://localhost/recording/${RID}?link=1`);
    const other = await proxy(new NextRequest(`http://localhost/transcript/rec-not-a-uuid`)).catch(() => null);
    expect(other?.headers.get('location') ?? '').not.toContain('/recording/');
  });
});

/**
 * Prod, 2026-10-02 (transcripts 1054 / recording 02af969f…): Ivan linked a
 * recording to a meeting while it was still transcribing. The meeting was
 * born 'processing' with a minted UUID id and NO job; the listing's pending
 * query COALESCEd the NULL job id to the minted meeting id, asked AssemblyAI
 * about it, got a 404 and flipped the meeting to 'error' — so the settle
 * (which only matched 'processing') skipped it when the recording landed 33 s
 * later, and Retry re-ingested the RECORDING's file under the meeting's name.
 */
describe('meetings made early from a recording (prod 2026-10-02)', () => {
  const MEETING = '2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5';
  const FAILURE = {
    stage: 'aai-job', message: 'This job no longer exists at AssemblyAI', firstAt: 'x', at: 'x',
    attempts: 1, nextAt: null, retryable: false, opts: { originalFilename: null },
  };
  const madeEarlyRow = (over: Record<string, unknown> = {}) => ({
    id: 1054,
    user_id: A.userId,
    assemblyai_id: MEETING,
    aai_job_id: null,
    status: 'error',
    deleted_at: null,
    imported_content: null,
    title: null,
    local_audio_path: `${RID}.mp4`,
    gmeet_context: {
      fromRecording: { recordingId: RID, how: 'link', at: '2026-10-02T01:32:34Z' },
      clips: [{ ord: 0, recordingId: RID, fromMs: 0, toMs: null, offsetMs: 0 }],
      ingestFailure: FAILURE,
    },
    ...over,
  });
  const rec = (over: Record<string, unknown> = {}) => ({
    id: RID, owner_user_id: A.userId, active_transcription_id: 'txn-1', deleted_at: null,
    standalone: true, upload_state: {}, ...over,
  });
  const txn = (status: string, payload: unknown = status === 'completed' ? { utterances: [] } : null) => ({
    id: 'txn-1', recording_id: RID, status, payload, provider_job_id: 'job-9a87', created_at: new Date().toISOString(),
  });
  /** Canned answers for the recording + transcription + meeting reads. */
  const world = (o: { meeting?: unknown; recording?: unknown; transcription?: unknown; settled?: unknown[] }) => {
    respond = (q) => {
      if (q.text.includes('information_schema.columns')) return [{ n: q.text.includes("'standalone'") ? 6 : 1 }];
      if (/recordings r WHERE r\.id = \$\d+::uuid AND r\.standalone/.test(q.text)) return o.recording ? [o.recording] : [];
      if (/FROM "[a-z_]+"\.recording_transcriptions WHERE recording_id = ANY/.test(q.text)) {
        return o.transcription ? [o.transcription] : [];
      }
      if (/SELECT \* FROM "[a-z_]+"\.transcripts WHERE user_id = /.test(q.text)) return o.meeting ? [o.meeting] : [];
      if (/UPDATE "[a-z_]+"\.transcripts t SET status = 'completed'/.test(q.text)) return o.settled ?? [];
      return [];
    };
  };
  const ranIngest = () =>
    sql.executed.some((q) => /UPDATE "[a-z_]+"\.transcripts SET status = 'uploading'/.test(q.text));

  test('the job-id SQL twin: with the column present it IS the column — never the meeting id', async () => {
    const { jobIdFragments } = await import('@/db-ops/aai-job-id');
    for (const alias of ['t', null] as const) {
      const present = jobIdFragments(true, alias);
      for (const f of [present.expr, present.expr2, present.column]) {
        const frag = f as unknown as { text: string };
        expect(frag.text).not.toContain('COALESCE');
        expect(frag.text).not.toContain('assemblyai_id');
        expect(frag.text).toContain('aai_job_id');
      }
      // 045 missing: the pre-1b answer, also under the column's NAME, so a JS
      // reader never sees a NULL that means "unknown".
      const absent = jobIdFragments(false, alias);
      expect((absent.expr as unknown as { text: string }).text).toContain('assemblyai_id ~*');
      expect((absent.column as unknown as { text: string }).text).toMatch(/END AS aai_job_id$/);
    }
  });

  test('no query anywhere repairs a NULL job id from the meeting id', () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const offenders: string[] = [];
    for (const f of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f) || f.includes('__tests__')) continue;
      const src = readFileSync(join(root, f), 'utf8');
      if (/COALESCE\(\s*(t\.)?aai_job_id\s*,/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // The pollers' candidate lists all take the job from the shared twin.
    const transcripts = readFileSync(join(root, 'db-ops/transcripts.ts'), 'utf8');
    for (const fn of ['listPendingVisibleToUser', 'jobIdsForVisibleMeetings', 'listStrandedAtAai', 'listStuckAtAai']) {
      const body = transcripts.slice(transcripts.indexOf(`export async function ${fn}(`)).split('\nexport ')[0]!;
      expect(body).toContain('await jobIdSql(');
      expect(body).toMatch(/\$\{job\.expr2?\}/);
    }
  });

  test('the settle heals a made-early meeting sitting in error, and drops its failure marker', async () => {
    await standalone.materialiseMeetingsMadeEarly(RID);
    const q = sql.executed.find((x) => /UPDATE "[a-z_]+"\.transcripts t SET status = 'completed'/.test(x.text))!;
    expect(q.text).toContain("t.status IN ('processing', 'error')");
    expect(q.text).toContain('t.imported_content IS NULL');
    expect(q.text).toContain("t.gmeet_context->'fromRecording'->>'recordingId' = r.id::text");
    expect(q.text).toContain("- 'ingestFailure'");
    expect(q.text).toContain("x.status = 'completed' AND x.payload IS NOT NULL");
  });

  test('opening the meeting heals it: refreshBornBare on an already-transcribed recording still runs the settle', async () => {
    const { refreshBornBare } = await import('@/lib/server/born-bare');
    world({ recording: rec({ ready_notified_at: new Date().toISOString() }), transcription: txn('completed') });
    expect(await refreshBornBare(RID)).toBe(true);
    const settle = sql.executed.find((x) => /UPDATE "[a-z_]+"\.transcripts t SET status = 'completed'/.test(x.text));
    expect(settle?.params).toContain(RID);
  });

  test('reopen after a recording retry: owner-scoped, only error rows without text, marker dropped', async () => {
    await standalone.reopenMeetingsMadeEarly(A.userId, RID);
    const q = sql.executed.find((x) => /SET status = 'processing'/.test(x.text))!;
    expect(q.text).toContain('t.user_id = $');
    expect(q.params).toContain(A.userId);
    expect(q.text).toContain("t.status = 'error' AND t.imported_content IS NULL");
    expect(q.text).toContain("- 'ingestFailure'");
  });

  test('a re-sent job resets the transcription’s clock and leftovers; the same job recorded twice does not', async () => {
    await standalone.recordStandaloneHandOff({
      recordingId: RID,
      canonical: { id: 'm1', filename: `${RID}.mp4`, bytes: null, hasVideo: true, sourceRef: {} },
      parts: [],
      transcription: { id: 'txn-1', providerJobId: 'job-new', speechModel: null, languageCode: null, status: 'processing' },
    });
    const q = sql.executed.find((x) => /INSERT INTO "[a-z_]+"\.recording_transcriptions/.test(x.text))!;
    expect(q.text).toMatch(/created_at = CASE WHEN recording_transcriptions\.provider_job_id IS DISTINCT FROM EXCLUDED\.provider_job_id THEN now\(\)/);
    expect(q.text).toMatch(/payload = CASE WHEN recording_transcriptions\.provider_job_id IS DISTINCT FROM EXCLUDED\.provider_job_id THEN NULL/);
  });

  test('Retry, recording transcribed: the settle fills the meeting — nothing is re-ingested or renamed', async () => {
    const { retryIngest } = await import('@/lib/server/ingest-retry');
    world({
      meeting: madeEarlyRow(),
      recording: rec(),
      transcription: txn('completed'),
      settled: [{ user_id: A.userId, assemblyai_id: MEETING }],
    });
    const out = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'manual');
    expect(out).toEqual({ ok: true, id: MEETING });
    const settle = sql.executed.find((x) => /UPDATE "[a-z_]+"\.transcripts t SET status = 'completed'/.test(x.text))!;
    expect(settle.params).toContain(RID);
    expect(ranIngest()).toBe(false);
  });

  test('Retry, recording still transcribing: a clear no-op', async () => {
    const { retryIngest } = await import('@/lib/server/ingest-retry');
    world({ meeting: madeEarlyRow(), recording: rec(), transcription: txn('processing') });
    const out = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'manual');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain('still being transcribed');
    expect(ranIngest()).toBe(false);
    expect(sql.executed.some((x) => /UPDATE "[a-z_]+"\.transcripts/.test(x.text))).toBe(false);
  });

  test('Retry, recording transcription failed: the RECORDING is re-sent (here: its file is gone, so it says so)', async () => {
    const { retryIngest } = await import('@/lib/server/ingest-retry');
    world({ meeting: madeEarlyRow(), recording: rec(), transcription: txn('error') });
    const out = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'manual');
    expect(out.ok).toBe(false);
    // It went down the recording's retry: the canonical media was looked up
    // (none → the recording is marked, never the meeting re-ingested).
    expect(sql.executed.some((x) => /FROM "[a-z_]+"\.recording_media WHERE recording_id = /.test(x.text))).toBe(true);
    expect(ranIngest()).toBe(false);
    expect(sql.executed.some((x) => /SET status = 'processing'/.test(x.text))).toBe(false);
  });

  test('Retry never touches someone else’s recording, and the sweeper never re-sends a borrower', async () => {
    const { retryIngest } = await import('@/lib/server/ingest-retry');
    world({ meeting: madeEarlyRow(), recording: rec({ owner_user_id: 'someone-else' }), transcription: txn('completed') });
    const other = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'manual');
    expect(other.ok).toBe(false);
    expect(sql.executed.some((x) => /UPDATE "[a-z_]+"\.transcripts/.test(x.text))).toBe(false);

    sql.executed.length = 0;
    world({ meeting: madeEarlyRow(), recording: rec(), transcription: txn('error') });
    const swept = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'sweeper');
    expect(swept.ok).toBe(false);
    expect(sql.executed.some((x) => /recording_media|recordings r/.test(x.text))).toBe(false);
    expect(ranIngest()).toBe(false);
  });

  test('Retry on a meeting SPLIT off another: refused, the borrowed file stays where it is', async () => {
    const { retryIngest } = await import('@/lib/server/ingest-retry');
    world({
      meeting: madeEarlyRow({ gmeet_context: { splitFrom: { assemblyaiId: 'src' }, ingestFailure: FAILURE } }),
    });
    const out = await retryIngest({ user_id: A.userId, assemblyai_id: MEETING }, 'manual');
    expect(out.ok).toBe(false);
    expect(ranIngest()).toBe(false);
  });
});

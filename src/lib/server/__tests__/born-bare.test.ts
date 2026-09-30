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
import { readFileSync } from 'node:fs';
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

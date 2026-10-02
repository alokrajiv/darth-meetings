/**
 * TWO PEOPLE LINKING THEIR OWN RECORDINGS TO THE SAME OCCURRENCE END UP IN
 * ONE MEETING (owner, 2026-10-02 — lib/server/occurrence-join.ts).
 *
 * Ka Wen linked her tray recording to Teams occurrence X first: her meeting
 * `m-kawen` exists and the link shared it with the internal invitees, Ivan
 * among them. Ivan now links HIS recording of X:
 *
 *   - the candidate lookup finds `m-kawen` (same occurrence, different owner,
 *     visible to Ivan through his share) and says whether his recording may
 *     join it — the next week's occurrence, a full meeting, one that already
 *     holds his recording, and a read share he is not invited on are not;
 *   - the join appends his recording as another clip of `m-kawen` (through
 *     Phase 3b's `addClip`), writes the marker, writes NO meeting and NO
 *     share; a refused add (the clip cap) leaves nothing behind;
 *   - a read share on the invite becomes edit; one not on the invite is 403;
 *   - a recording still transcribing joins audio-only and its text is merged
 *     when it lands; with MW_COMBINE off the join is a reservation only;
 *   - `POST /api/recordings/:id/link` joins by default and `mode: 'separate'`
 *     makes a meeting of its own as before.
 *
 * Over the fake postgres tag: a tiny in-memory "database" answers the queries
 * the code actually runs, and the assertions are on what was executed. The
 * Phase 3b clip writer (`addClip` / `patchClip`) and the aligner are swapped
 * through the module's test seam — they have their own suites.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const IVAN = { userId: 'user-ivan', email: 'ivan@trames.sg', name: 'Ivan Tan' };
const KAWEN = { userId: 'user-kawen', email: 'kawen@trames.sg', name: 'Ka Wen Koh' };
const R_KAWEN = '11111111-1111-4111-8111-111111111111';
const R_IVAN = '22222222-2222-4222-8222-222222222222';
const T = '2026-10-02T06:00:00.000Z';
const EVENT = {
  id: 'ev-weekly_20261002T060000Z',
  title: 'Data team weekly',
  startTime: T,
  endTime: '2026-10-02T06:30:00.000Z',
  meetingCode: 'teams-0a1b2c3d4e5f',
  attendees: [
    { email: KAWEN.email, name: KAWEN.name },
    { email: IVAN.email, name: IVAN.name },
    { email: 'bea@trames.sg', name: 'Bea' },
  ],
};

interface Meeting {
  id: number;
  assemblyai_id: string;
  user_id: string;
  title: string;
  status: string;
  created_at: string;
  deleted_at: string | null;
  scratch: boolean;
  gmeet_context: Record<string, unknown>;
  imported_content: unknown;
  auto_notes: string | null;
  auto_report: string | null;
  shares: Record<string, 'edit' | 'read'>;
  recordings: string[];
}

let meetings: Meeting[] = [];
let transcribed = true;
let joinsMarker: Record<string, unknown> | null = null;

const kawenMeeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 501,
  assemblyai_id: 'm-kawen',
  user_id: KAWEN.userId,
  title: 'Data team weekly',
  status: 'completed',
  created_at: '2026-10-02T07:00:00.000Z',
  deleted_at: null,
  scratch: false,
  gmeet_context: {
    eventId: EVENT.id,
    startTime: T,
    meetingCode: EVENT.meetingCode,
    attendees: EVENT.attendees,
  },
  imported_content: null,
  auto_notes: null,
  auto_report: null,
  shares: { [IVAN.email]: 'edit', 'bea@trames.sg': 'edit' },
  recordings: [R_KAWEN],
  ...over,
});

type Actions = typeof import('@/lib/server/recording-actions');
type Join = typeof import('@/lib/server/occurrence-join');
type Pipeline = typeof import('@/lib/server/upload-pipeline');
let actions: Actions;
let join: Join;
let pipeline: Pipeline;

const ENV_KEYS = ['MW_CLIPS', 'MW_COMBINE', 'MW_RECORDINGS_WRITE', 'MW_RECORDINGS_BORN_BARE'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  actions = await import('@/lib/server/recording-actions');
  join = await import('@/lib/server/occurrence-join');
  pipeline = await import('@/lib/server/upload-pipeline');
});

afterAll(() => {
  join.__setJoinDepsForTests(null);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** What the in-memory database answers. */
function db(q: RenderedQuery): unknown[] {
  const t = q.text;
  if (t.includes('information_schema.tables')) return [{ tables: 4, columns: 2 }];
  if (t.includes('information_schema.columns')) return [{ n: t.includes("'standalone'") ? 6 : 1 }];
  if (t.includes('AS clip_count')) {
    // findOccurrenceMeetings — the caller-scoped predicate, emulated.
    const caller = q.params.find((p) => typeof p === 'string' && p.startsWith('user-')) as string;
    const email = q.params.find((p) => typeof p === 'string' && p.includes('@')) as string;
    const exclude = (q.params.find((p) => Array.isArray(p)) as number[] | undefined) ?? [];
    return meetings
      .filter((m) => !m.deleted_at && !m.scratch && !exclude.includes(m.id))
      .filter((m) => m.user_id === caller || m.shares[email] !== undefined)
      .map((m) => ({
        id: m.id,
        assemblyai_id: m.assemblyai_id,
        title: m.title,
        user_id: m.user_id,
        status: m.status,
        created_at: m.created_at,
        access: m.user_id === caller ? 'owner' : m.shares[email],
        event_id: m.gmeet_context.eventId ?? null,
        ical_uid: null,
        meeting_code: m.gmeet_context.meetingCode ?? null,
        join_web_url: null,
        occurrence_start: m.gmeet_context.startTime ?? null,
        caller_invited: ((m.gmeet_context.attendees as Array<{ email: string }>) ?? []).some(
          (a) => a.email === email
        ),
        clip_count: m.recordings.length,
        recording_ids: m.recordings,
      }));
  }
  if (t.includes('DISTINCT ON (user_id) user_id, user_email')) {
    return [
      { user_id: KAWEN.userId, user_email: KAWEN.email, user_name: KAWEN.name },
      { user_id: IVAN.userId, user_email: IVAN.email, user_name: IVAN.name },
    ];
  }
  if (t.includes('AS "__access"')) {
    const [caller, email, id] = [q.params[0], q.params[1], q.params[2]] as string[];
    const m = meetings.find((x) => x.assemblyai_id === id);
    if (!m) return [];
    const access = m.user_id === caller ? 'owner' : m.shares[email];
    if (!access) return [];
    return [{ ...m, __access: access }];
  }
  if (/FROM "[a-z_]+"\.recordings r WHERE r\.id = \$\d+::uuid AND r\.owner_user_id = \$/.test(t)) {
    return q.params.includes(IVAN.userId) && q.params.includes(R_IVAN)
      ? [{ id: R_IVAN, title: 'Ivan / Data team', standalone: true, owner_user_id: IVAN.userId }]
      : [];
  }
  if (/SELECT id, owner_user_id, source_kind, started_at/.test(t)) {
    return q.params.includes(R_IVAN)
      ? [{ id: R_IVAN, owner_user_id: IVAN.userId, deleted_at: null, started_at: T }]
      : [];
  }
  if (t.includes('WHERE r.id = ANY(')) return [{ id: R_IVAN, owner_user_id: IVAN.userId, transcribed }];
  if (t.includes('AS live')) return [{ live: 0, reserved: null }];
  if (t.includes('AS joins')) {
    const m = meetings[0]!;
    return joinsMarker ? [{ id: m.id, user_id: m.user_id, assemblyai_id: m.assemblyai_id, joins: joinsMarker }] : [];
  }
  if (/SELECT transcript_id, ord, recording_id, transcription_id/.test(t)) {
    const m = meetings.find((x) => x.id === q.params[0]) ?? meetings[0]!;
    return m.recordings.map((r, ord) => ({
      transcript_id: m.id,
      ord,
      recording_id: r,
      transcription_id: null,
      from_ms: 0,
      to_ms: null,
      offset_ms: 0,
      text_policy: r === R_IVAN && !transcribed ? 'exclude' : 'include',
    }));
  }
  if (t.includes("ARRAY['occurrenceJoins'") && /RETURNING id/.test(t)) return [{ id: meetings[0]!.id }];
  if (/SELECT \* FROM "[a-z_]+"\.transcripts WHERE user_id = \$1 AND assemblyai_id = \$2/.test(t)) {
    const m = meetings.find((x) => x.user_id === q.params[0] && x.assemblyai_id === q.params[1]);
    return m ? [m] : [];
  }
  // The meeting a separate link makes.
  if (t.includes('FOR UPDATE')) return [{ id: R_IVAN, active_transcription_id: null }];
  if (/INSERT INTO "[a-z_]+"\.transcripts/.test(t)) return [{ id: 77, assemblyai_id: 'm-ivan-own' }];
  if (/INSERT INTO "[a-z_]+"\.transcript_shares\b/.test(t)) {
    return [{ id: 1, transcript_id: q.params[0], shared_with_email: q.params[3] }];
  }
  if (/UPDATE "[a-z_]+"\.recordings/.test(t) && /RETURNING id/.test(t)) return [{ id: R_IVAN }];
  // The recording an upload is born as (design P7).
  if (/INSERT INTO "[a-z_]+"\.recordings AS r/.test(t)) {
    return [{ id: R_IVAN, title: 'Data team weekly', created_at: T, expires_at: null, upload_state: {} }];
  }
  if (/UPDATE "[a-z_]+"\.transcript_shares/.test(t)) return [{ id: 9, access: 'edit' }];
  return [];
}

const addCalls: Array<Record<string, unknown>> = [];
const patchCalls: Array<Record<string, unknown>> = [];
let addAnswer: () => unknown = () => ({
  ok: true,
  body: { ok: true, clips: [], spanMs: 0, recordingCount: 2, materialised: { utterances: 0, durationSec: null, speakerCount: null } },
});

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  meetings = [kawenMeeting()];
  transcribed = true;
  joinsMarker = null;
  addCalls.length = 0;
  patchCalls.length = 0;
  addAnswer = () => ({
    ok: true,
    body: { ok: true, clips: [], spanMs: 0, recordingCount: 2, materialised: { utterances: 0, durationSec: null, speakerCount: null } },
  });
  process.env.MW_CLIPS = '1';
  process.env.MW_COMBINE = '1';
  process.env.MW_RECORDINGS_WRITE = '1';
  delete process.env.MW_RECORDINGS_BORN_BARE;
  const g = globalThis as Record<string, unknown>;
  g.__mwTranscriptionVersionTables = undefined;
  g.__mwAaiJobIdColumn = undefined;
  g.__mwStandaloneColumns = undefined;
  g.__mwShareOriginColumn = undefined;
  respond = db;
  join.__setJoinDepsForTests({
    addClip: (async (input: Record<string, unknown>) => {
      addCalls.push(input);
      return addAnswer();
    }) as never,
    patchClip: (async (input: Record<string, unknown>) => {
      patchCalls.push(input);
      return { ok: true, body: { ok: true, clips: [], spanMs: 0, recordingCount: 2, materialised: {} } };
    }) as never,
    runAlign: false,
  });
});

const KEY = () => ({
  eventId: EVENT.id,
  iCalUID: null,
  meetingCode: EVENT.meetingCode,
  joinWebUrl: null,
  startTime: T,
});
const executed = (re: RegExp) => sql.executed.filter((q) => re.test(q.text));
const SHARE_INSERT = /INSERT INTO "[a-z_]+"\.transcript_shares\b/;
const MEETING_INSERT = /INSERT INTO "[a-z_]+"\.transcripts\b/;
const MARKER_SET = /'\{occurrenceJoins\}'/;

describe('the candidate lookup', () => {
  test('same occurrence, different owner, visible through the link share → Ivan’s candidate', async () => {
    const out = await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN });
    expect(out.defaultMode).toBe('join');
    expect(out.candidate?.meetingId).toBe('m-kawen');
    // Named from the activity identities — unless another suite's process-wide
    // `mock.module('@/db-ops/transcript-activity')` (meeting-search) answered.
    if (executed(/DISTINCT ON \(user_id\) user_id, user_email/).length > 0) {
      expect(out.candidate?.ownerName).toBe('Ka Wen Koh');
    }
    expect(out.candidate?.mine).toBe(false);
    expect(out.candidate?.access).toBe('edit');
    expect(out.candidate?.joinable).toBe(true);
  });

  test('not visible (no share) → nothing; trashed → nothing', async () => {
    meetings = [kawenMeeting({ shares: {} })];
    expect((await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN })).candidates).toEqual([]);
    meetings = [kawenMeeting({ deleted_at: '2026-10-02T08:00:00.000Z' })];
    expect((await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN })).candidates).toEqual([]);
  });

  test('the same recurring call NEXT week is another occurrence', async () => {
    meetings = [
      kawenMeeting({
        gmeet_context: { meetingCode: EVENT.meetingCode, startTime: '2026-10-09T06:00:00.000Z', attendees: EVENT.attendees },
      }),
    ];
    expect((await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN })).candidates).toEqual([]);
  });

  test('full / already holding this recording / no recording / read share off the invite — listed, not joinable', async () => {
    const cases: Array<[Partial<Meeting>, string]> = [
      [{ recordings: Array.from({ length: 6 }, (_, i) => `r-${i}`) }, 'full'],
      [{ recordings: [R_KAWEN, R_IVAN] }, 'already-in'],
      [{ recordings: [] }, 'no-recording'],
      [{ shares: { [IVAN.email]: 'read' }, gmeet_context: { eventId: EVENT.id, startTime: T, attendees: [] } }, 'read-only'],
    ];
    for (const [over, code] of cases) {
      meetings = [kawenMeeting(over)];
      const out = await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN });
      expect(out.candidates).toHaveLength(1);
      expect(out.candidates[0]!.joinable).toBe(false);
      expect(out.candidates[0]!.blockedCode).toBe(code as never);
      expect(out.candidates[0]!.blockedReason).toBeTruthy();
      expect(out.candidate).toBeNull();
    }
    // A read share ON the invite is joinable: the join makes them an editor.
    meetings = [kawenMeeting({ shares: { [IVAN.email]: 'read' } })];
    expect((await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN })).candidate?.joinable).toBe(true);
  });

  test('no clips on this server → no lookup at all', async () => {
    delete process.env.MW_CLIPS;
    const out = await join.occurrenceCandidates(IVAN, KEY(), { recordingId: R_IVAN });
    expect(out.candidate).toBeNull();
    expect(executed(/AS clip_count/)).toHaveLength(0);
  });
});

describe('the join', () => {
  test('appends Ivan’s recording to Ka Wen’s meeting — no second meeting, no share', async () => {
    const out = await join.joinOccurrenceMeeting({
      caller: IVAN,
      recordingId: R_IVAN,
      meetingId: 'm-kawen',
      how: 'link',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toMatchObject({
      joined: true,
      meetingId: 'm-kawen',
      recordingId: R_IVAN,
      text: 'merged',
      alignment: 'unaligned',
      shares: 0,
      upgradedToEditor: false,
    });
    expect(addCalls).toHaveLength(1);
    const add = addCalls[0]!;
    expect((add.access as { row: { assemblyai_id: string } }).row.assemblyai_id).toBe('m-kawen');
    expect(add).toMatchObject({ recordingId: R_IVAN, fromMs: 0, toMs: null, offsetMs: 0, textPolicy: 'include' });
    expect((add.by as { userId: string }).userId).toBe(IVAN.userId);
    expect(executed(MARKER_SET)).toHaveLength(1);
    expect(executed(MEETING_INSERT)).toHaveLength(0);
    expect(executed(SHARE_INSERT)).toHaveLength(0);
    expect(executed(/UPDATE "[a-z_]+"\.transcript_shares/)).toHaveLength(0);
  });

  test('the clip cap is respected — a refused add leaves no marker and no meeting', async () => {
    addAnswer = () => ({
      ok: false,
      status: 409,
      body: { error: 'A meeting can hold 6 recordings at most.', code: 'too-many-clips' },
    });
    const out = await join.joinOccurrenceMeeting({ caller: IVAN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'link' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(409);
    expect(out.code).toBe('too-many-clips');
    expect(executed(MARKER_SET)).toHaveLength(0);
    expect(executed(MEETING_INSERT)).toHaveLength(0);
  });

  test('someone else’s recording is 404, never added', async () => {
    const out = await join.joinOccurrenceMeeting({ caller: KAWEN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'link' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(404);
    expect(addCalls).toHaveLength(0);
  });

  test('a read share on the invite becomes edit; off the invite it is refused', async () => {
    meetings = [kawenMeeting({ shares: { [IVAN.email]: 'read' } })];
    let out = await join.joinOccurrenceMeeting({ caller: IVAN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'link' });
    expect(out.ok).toBe(true);
    const upgrade = executed(/UPDATE "[a-z_]+"\.transcript_shares/);
    expect(upgrade).toHaveLength(1);
    expect(upgrade[0]!.params).toContain('edit');
    expect(upgrade[0]!.params).toContain(IVAN.email);

    sql.executed.length = 0;
    addCalls.length = 0;
    meetings = [
      kawenMeeting({ shares: { [IVAN.email]: 'read' }, gmeet_context: { eventId: EVENT.id, startTime: T, attendees: [] } }),
    ];
    out = await join.joinOccurrenceMeeting({ caller: IVAN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'link' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(403);
    expect(addCalls).toHaveLength(0);
    expect(executed(/UPDATE "[a-z_]+"\.transcript_shares/)).toHaveLength(0);
  });

  test('still transcribing → audio-only now, text merged when it lands', async () => {
    transcribed = false;
    const out = await join.joinOccurrenceMeeting({ caller: IVAN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'upload' });
    expect(out.ok && out.body.text).toBe('pending');
    expect(addCalls[0]!.textPolicy).toBe('exclude');

    // The recording's transcription lands.
    meetings = [kawenMeeting({ recordings: [R_KAWEN, R_IVAN] })];
    transcribed = true;
    joinsMarker = {
      [R_IVAN]: { at: T, byUserId: IVAN.userId, by: IVAN.email, how: 'upload', text: 'pending', alignment: 'unaligned' },
    };
    const n = await join.settleOccurrenceJoins(R_IVAN);
    expect(n).toBe(1);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ ord: 1, textPolicy: 'include' });
    const claims = executed(/ARRAY\['occurrenceJoins'/);
    // The claim (pending|failed → merging) and the finish (merging → merged).
    expect(claims.some((q) => q.params.some((p) => Array.isArray(p) && p.includes('pending')))).toBe(true);
    expect(
      claims.some((q) => q.params.some((p) => typeof p === 'object' && p !== null && (p as { text?: string }).text === 'merged'))
    ).toBe(true);
    expect(executed(MEETING_INSERT)).toHaveLength(0);
  });

  test('a failed transcription marks the pending join failed — the backstop never fails anything', async () => {
    joinsMarker = {
      [R_IVAN]: { at: T, byUserId: IVAN.userId, by: IVAN.email, how: 'link', text: 'pending', alignment: 'unaligned' },
    };
    await join.settleOccurrenceJoins(R_IVAN, { status: 'error', reason: 'AssemblyAI error' });
    expect(patchCalls).toHaveLength(0);
    expect(
      executed(/ARRAY\['occurrenceJoins'/).some((q) =>
        q.params.some((p) => typeof p === 'object' && p !== null && (p as { text?: string }).text === 'failed')
      )
    ).toBe(true);
    sql.executed.length = 0;
    expect(await join.settleOccurrenceJoins(null, { status: 'error', reason: 'x' })).toBe(0);
    expect(sql.executed).toHaveLength(0);
  });

  test('MW_COMBINE off: a reservation — no clip, the meeting untouched, still no second meeting', async () => {
    delete process.env.MW_COMBINE;
    const out = await join.joinOccurrenceMeeting({ caller: IVAN, recordingId: R_IVAN, meetingId: 'm-kawen', how: 'link' });
    expect(out.ok && out.body.text).toBe('waiting-combine');
    expect(addCalls).toHaveLength(0);
    expect(executed(/meeting_clips \(transcript_id|INSERT INTO "[a-z_]+"\.meeting_clips/)).toHaveLength(0);
    expect(executed(MARKER_SET)).toHaveLength(1);
    expect(executed(MEETING_INSERT)).toHaveLength(0);

    // The flag comes on: the sweep turns the reservation into the join.
    process.env.MW_COMBINE = '1';
    joinsMarker = {
      [R_IVAN]: { at: T, byUserId: IVAN.userId, by: IVAN.email, how: 'link', text: 'waiting-combine', alignment: 'unaligned' },
    };
    expect(await join.settleOccurrenceJoins(null)).toBe(1);
    expect(addCalls).toHaveLength(1);
  });
});

describe('POST /api/recordings/:id/link — join by default, separate on request', () => {
  test('default: the occurrence already has Ka Wen’s meeting → joined, nothing made, nobody shared', async () => {
    const out = await actions.linkRecording(IVAN, R_IVAN, { event: EVENT });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toMatchObject({ joined: true, meetingId: 'm-kawen', shares: 0 });
    expect(addCalls).toHaveLength(1);
    expect(executed(MEETING_INSERT)).toHaveLength(0);
    expect(executed(SHARE_INSERT)).toHaveLength(0);
  });

  test('mode separate: no lookup, a meeting of its own, shared with the invitees as before', async () => {
    const out = await actions.linkRecording(IVAN, R_IVAN, { event: EVENT, mode: 'separate' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body).toMatchObject({ meeting: { id: 'm-ivan-own' }, joined: false });
    expect(executed(/AS clip_count/)).toHaveLength(0);
    expect(addCalls).toHaveLength(0);
    expect(executed(MEETING_INSERT)).toHaveLength(1);
    // Ka Wen and Bea are internal invitees; Ivan (the owner) is never shared.
    const emails = executed(SHARE_INSERT).map((q) => q.params[3]);
    expect(emails.sort()).toEqual(['bea@trames.sg', KAWEN.email]);
  });

  test('no visible meeting for the occurrence → the ordinary link, unchanged', async () => {
    meetings = [kawenMeeting({ shares: {} })];
    const out = await actions.linkRecording(IVAN, R_IVAN, { event: EVENT });
    expect(out.ok && (out.body as { joined?: boolean }).joined).toBe(false);
    expect(addCalls).toHaveLength(0);
    expect(executed(MEETING_INSERT)).toHaveLength(1);
  });

  test('an explicit join that is refused is answered, not papered over with a second meeting', async () => {
    addAnswer = () => ({ ok: false, status: 409, body: { error: 'full', code: 'too-many-clips' } });
    const explicit = await actions.linkRecording(IVAN, R_IVAN, { event: EVENT, mode: 'join' });
    expect(explicit.ok).toBe(false);
    expect(executed(MEETING_INSERT)).toHaveLength(0);
    // The default mode falls back to a meeting of its own.
    sql.executed.length = 0;
    const fallback = await actions.linkRecording(IVAN, R_IVAN, { event: EVENT });
    expect(fallback.ok).toBe(true);
    expect(executed(MEETING_INSERT)).toHaveLength(1);
  });
});

describe('an upload linked to the occurrence (the tray’s Link card, the web stepper, darth-cli --event)', () => {
  const open = (over: Partial<Parameters<Pipeline['openUpload']>[1]> = {}) =>
    pipeline.openUpload(IVAN as never, {
      originalFilename: 'Ivan - Data team.m4a',
      contentType: 'audio/mp4',
      linkedEvent: EVENT,
      reportPref: null,
      bytesTotal: 47_000_000,
      uuid: R_IVAN,
      recorderRecordingId: null,
      ...over,
    });

  test('default: born a RECORDING and joined to Ka Wen’s meeting before a byte moves', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    transcribed = false;
    const opened = await open();
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.joined).toMatchObject({ joined: true, meetingId: 'm-kawen', text: 'pending', shares: 0 });
    expect(opened.spec.bornBare?.recordingId).toBe(R_IVAN);
    expect(opened.spec.placeholderId).toBe(`rec-${R_IVAN}`);
    // Audio only until the transcription lands.
    expect(addCalls[0]).toMatchObject({ recordingId: R_IVAN, textPolicy: 'exclude' });
    expect(executed(MEETING_INSERT)).toHaveLength(0);
    expect(executed(SHARE_INSERT)).toHaveLength(0);
    // The recording carries the event's title, and is never temporary.
    const rec = executed(/INSERT INTO "[a-z_]+"\.recordings AS r/)[0]!;
    expect(rec.params).toContain('Data team weekly');
  });

  test('linkMode separate: the ordinary linked upload — a placeholder meeting, shared with the invitees', async () => {
    process.env.MW_RECORDINGS_BORN_BARE = '1';
    const opened = await open({ linkMode: 'separate' });
    expect(opened.ok && opened.joined).toBeFalsy();
    expect(addCalls).toHaveLength(0);
    expect(executed(/AS clip_count/)).toHaveLength(0);
    expect(executed(MEETING_INSERT)).toHaveLength(1);
    expect(executed(SHARE_INSERT).length).toBeGreaterThan(0);
  });

  test('without born-bare uploads there is nothing to join WITH — the linked upload is unchanged', async () => {
    const opened = await open();
    expect(opened.ok && opened.joined).toBeFalsy();
    expect(addCalls).toHaveLength(0);
    expect(executed(MEETING_INSERT)).toHaveLength(1);
  });
});

describe('POST /api/transcripts/:id/link-event on a meeting that is just Ivan’s recording', () => {
  // Ivan made a meeting of his own recording earlier ("Make a meeting"); now
  // he links it to X, which already has Ka Wen's meeting.
  const ivanOwn = (over: Partial<Meeting> = {}): Meeting =>
    kawenMeeting({
      id: 777,
      assemblyai_id: 'm-ivan-own',
      user_id: IVAN.userId,
      title: 'Ivan / Data team',
      gmeet_context: { fromRecording: { recordingId: R_IVAN } },
      shares: {},
      recordings: [R_IVAN],
      ...over,
    });
  const accessOf = (m: Meeting) => ({ row: m as never, access: 'owner' as const, ownerUserId: m.user_id });

  test('it is folded into the occurrence’s meeting and goes to Ivan’s trash', async () => {
    const own = ivanOwn();
    meetings = [kawenMeeting(), own];
    const out = await join.foldIntoOccurrenceMeeting(IVAN, accessOf(own), KEY(), null);
    expect(out?.ok).toBe(true);
    if (!out?.ok) return;
    expect(out.body).toMatchObject({ joined: true, meetingId: 'm-kawen', foldedMeetingId: 'm-ivan-own' });
    expect(addCalls[0]).toMatchObject({ recordingId: R_IVAN });
    const trash = executed(/SET deleted_at = now\(\)/);
    expect(trash).toHaveLength(1);
    expect(trash[0]!.params).toContain('m-ivan-own');
    // Never its own candidate.
    expect(executed(/AS clip_count/)[0]!.params).toContainEqual([777]);
  });

  test('a meeting with notes of its own stays separate (an explicit join is told why)', async () => {
    const own = ivanOwn({ auto_notes: '## Notes' });
    meetings = [kawenMeeting(), own];
    expect(await join.foldIntoOccurrenceMeeting(IVAN, accessOf(own), KEY(), null)).toBeNull();
    const explicit = await join.foldIntoOccurrenceMeeting(IVAN, accessOf(own), KEY(), 'join');
    expect(explicit?.ok).toBe(false);
    if (explicit && !explicit.ok) expect(explicit.code).toBe('has-notes');
    expect(addCalls).toHaveLength(0);
    expect(executed(/SET deleted_at = now\(\)/)).toHaveLength(0);
  });

  test('separate, or MW_COMBINE off: the ordinary link', async () => {
    const own = ivanOwn();
    meetings = [kawenMeeting(), own];
    expect(await join.foldIntoOccurrenceMeeting(IVAN, accessOf(own), KEY(), 'separate')).toBeNull();
    delete process.env.MW_COMBINE;
    expect(await join.foldIntoOccurrenceMeeting(IVAN, accessOf(own), KEY(), null)).toBeNull();
    expect(addCalls).toHaveLength(0);
  });
});

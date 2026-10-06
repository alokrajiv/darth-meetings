/**
 * LINKING A MEETING TO A CALENDAR EVENT SHARES IT LIKE A CLOUD IMPORT
 * (owner, 2026-10-02 — reverses design P4's "a link never shares" of
 * 2026-09-23; docs/recordings-meetings-series-design.md §6.2 Q2).
 *
 *   - A tray-style Link (an upload opened with the occurrence as its linked
 *     event — the same `openUpload` the web stepper, the calendar row's
 *     Upload and `darth-cli meetings upload --event` go through) on an
 *     occurrence with 8 internal invitees shares the meeting with exactly
 *     those 8: edit access, stamped `origin = 'event-link'` (migration 048).
 *     The owner and the external guest on the invite are not shared.
 *   - `POST /api/recordings/:id/link` with an event does the same to the
 *     meeting it makes; "Make a meeting" (no event) shares nobody.
 *   - A re-run (`sourceId`) or bytes joining an existing meeting
 *     (`attachTo`) are not new links and share nobody.
 *   - Re-linking is idempotent: who already has a share is left exactly as
 *     they are (a person's read share is never upgraded or stamped).
 *   - The cloud-import arm is the same rule, unstamped.
 *   - Unlink takes the link-born shares back off (by origin).
 *   - Re-linking a meeting linked to event A to event B first takes A's
 *     link-born shares off everyone who is not an internal invitee of B
 *     (stamped rows only — a person's own share is never touched), then
 *     adds B's missing invitees; a first link removes nothing.
 *   - The RECORDING stays its owner's: a person the meeting is shared with
 *     can open the meeting, but every `/api/recordings/:id` route answers
 *     them 404.
 *
 * Over the fake postgres tag (db-ops/__tests__/helpers/fake-sql): every
 * query is rendered and logged, so the assertions are on the SQL the code
 * actually ran, not on a mocked helper.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const OWNER = {
  kind: 'session' as const,
  userId: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'alok@trames.sg',
  name: 'Alok',
  modules: ['meetings'],
  scope: 'readwrite' as const,
};
// Bea is on the invite, so the link shares the meeting with her.
const BEA = {
  kind: 'session' as const,
  userId: 'bbbbbbbb-0000-4000-8000-000000000002',
  email: 'bea@trames.sg',
  name: 'Bea',
  modules: ['meetings'],
  scope: 'readwrite' as const,
};
const RID = 'c0ffee00-0000-4000-8000-000000000001';

const INVITEES = [
  'bea@trames.sg',
  'chen@trames.sg',
  'dev@trames.sg',
  'eli@trames-engineering.com',
  'fay@trames.sg',
  'gus@trames.sg',
  'hana@trames-engineering.com',
  'ivan@trames.sg',
].map((email) => ({ email, name: email.split('@')[0], responseStatus: 'accepted' }));
// The owner (in mixed case, as calendars write it) and an external guest are
// on the invite too — neither is ever shared.
const ATTENDEES = [
  { email: 'Alok@trames.sg', name: 'Alok', responseStatus: 'accepted' },
  ...INVITEES,
  { email: 'guest@partner.example', name: 'Guest', responseStatus: 'accepted' },
];

const EVENT = {
  id: 'ev-triton',
  title: 'Triton next steps!',
  startTime: '2026-09-22T07:30:00.000Z',
  endTime: '2026-09-22T08:00:00.000Z',
  meetingCode: 'bgs-zqvv-dby',
  attendees: ATTENDEES,
};

type Pipeline = typeof import('@/lib/server/upload-pipeline');
type AutoShare = typeof import('@/lib/server/auto-share');
type ShareOrigin = typeof import('@/db-ops/share-origin');
type Actions = typeof import('@/lib/server/recording-actions');
let pipeline: Pipeline;
let autoShare: AutoShare;
let shareOrigin: ShareOrigin;
let actions: Actions;

// The session `withAuth` hands a route — swapped per test.
let currentUser: typeof OWNER | typeof BEA = OWNER;

const SHARE_INSERT = /INSERT INTO "[a-z_]+"\.transcript_shares\b/;
// Invitee shares only: the auditor policy's insert (auditor-shares.test.ts)
// rides the same calls and is asserted there.
const shareWrites = () =>
  sql.executed.filter((q) => SHARE_INSERT.test(q.text) && !q.text.includes('auditor_share_removals'));
const emailOf = (q: RenderedQuery) =>
  q.params.find((p): p is string => typeof p === 'string' && p.includes('@'));

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mock.module('@/lib/auth/with-auth', () => ({
    withAuth:
      (h: (ctx: { user: typeof OWNER; request: Request }, c: unknown) => Promise<Response>) =>
      (request: Request, context: unknown) =>
        h({ user: currentUser as typeof OWNER, request }, context),
  }));
  pipeline = await import('@/lib/server/upload-pipeline');
  autoShare = await import('@/lib/server/auto-share');
  shareOrigin = await import('@/db-ops/share-origin');
  actions = await import('@/lib/server/recording-actions');
});

/** The default "database": migrations 048/049 applied, writes echo a row. */
function baseRespond(q: RenderedQuery): unknown[] | undefined {
  if (q.text.includes('information_schema.columns')) {
    return [{ n: q.text.includes("'standalone'") ? 6 : 1 }];
  }
  if (/\.transcripts\b/.test(q.text) && /RETURNING/i.test(q.text) && !q.text.includes('meeting_clips')) {
    return [
      {
        id: 4242,
        user_id: OWNER.userId,
        assemblyai_id: 'up-11111111-2222-4333-8444-555555555555',
        status: 'uploading',
        title: 'Triton next steps!',
        gmeet_context: null,
        scratch: false,
      },
    ];
  }
  if (SHARE_INSERT.test(q.text)) {
    return [{ id: 1, transcript_id: q.params[0], shared_with_email: q.params[3] }];
  }
  return undefined;
}

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  currentUser = OWNER;
  const g = globalThis as { __mwStandaloneColumns?: unknown; __mwAaiJobIdColumn?: unknown };
  g.__mwStandaloneColumns = undefined;
  g.__mwAaiJobIdColumn = undefined;
  respond = (q) => baseRespond(q) ?? [];
});

const openLinked = (over: Partial<Parameters<Pipeline['openUpload']>[1]> = {}) =>
  pipeline.openUpload(OWNER as never, {
    originalFilename: 'Triton next steps.m4a',
    contentType: 'audio/mp4',
    linkedEvent: EVENT,
    reportPref: null,
    bytesTotal: 1_000_000,
    recorderRecordingId: null,
    ...over,
  });

describe('an upload linked to an event shares the meeting like an import', () => {
  test('tray-style Link on an occurrence with 8 internal invitees → those 8, edit, event-link', async () => {
    const opened = await openLinked();
    expect(opened.ok).toBe(true);
    const writes = shareWrites();
    expect(writes).toHaveLength(8);
    expect(writes.map(emailOf).sort()).toEqual(INVITEES.map((i) => i.email).sort());
    for (const q of writes) {
      expect(q.params[0]).toBe(4242); // the placeholder meeting
      expect(q.params).toContain('edit');
      expect(q.text).toContain('origin');
      expect(q.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
      // The OWNER shares (so Unlink's legacy signature arm still fits).
      expect(q.params[1]).toBe(OWNER.userId);
      expect(q.params[2]).toBe(OWNER.userId);
    }
    // Never the owner, never the external guest.
    const emails = writes.map(emailOf);
    expect(emails).not.toContain('alok@trames.sg');
    expect(emails).not.toContain('guest@partner.example');
    // The invitees are on the meeting's context too.
    const placeholderInsert = sql.executed.find((q) =>
      /INSERT INTO "[a-z_]+"\.transcripts\b/.test(q.text)
    )!;
    const ctx = placeholderInsert.params.find(
      (p): p is { attendees: Array<{ email: string }> } =>
        typeof p === 'object' && p !== null && Array.isArray((p as { attendees?: unknown }).attendees)
    );
    expect(ctx?.attendees.map((a) => a.email)).toEqual(ATTENDEES.map((a) => a.email));
  });

  test('an unlinked upload shares nobody', async () => {
    const opened = await openLinked({ linkedEvent: null, originalFilename: 'huddle.m4a', bytesTotal: 10 });
    expect(opened.ok).toBe(true);
    expect(sql.log.some((q) => q.text.includes('transcript_shares'))).toBe(false);
  });

  test('an event with no internal invitees shares nobody', async () => {
    const opened = await openLinked({
      linkedEvent: {
        ...EVENT,
        attendees: [ATTENDEES[0]!, { email: 'guest@partner.example', name: 'Guest' }],
      },
    });
    expect(opened.ok).toBe(true);
    expect(shareWrites()).toHaveLength(0);
  });

  test('bytes joining an existing meeting (attachTo) are not a new link — no share', async () => {
    const opened = await openLinked({
      attachTo: {
        meetingId: 'm-existing',
        offsetMs: 0,
        textPolicy: 'include',
        at: '2026-10-02T04:00:00.000Z',
      } as never,
    });
    expect(opened.ok).toBe(true);
    expect(shareWrites()).toHaveLength(0);
  });
});

describe('POST /api/recordings/:id/link — the meeting it makes is shared; the recording is not', () => {
  const linkRespond = (q: RenderedQuery): unknown[] => {
    // The owner's standalone recording.
    if (/FROM "[a-z_]+"\.recordings r WHERE r\.id = \$\d+::uuid AND r\.owner_user_id = \$/.test(q.text)) {
      return q.params.includes(OWNER.userId) ? [{ id: RID, title: 'Huddle', standalone: true }] : [];
    }
    // Still transcribing: the meeting is born processing (no media prep).
    if (q.text.includes('FOR UPDATE')) return [{ id: RID, active_transcription_id: null }];
    if (/INSERT INTO "[a-z_]+"\.transcripts/.test(q.text)) return [{ id: 77, assemblyai_id: 'm-77' }];
    return baseRespond(q) ?? [];
  };

  test('Link to an event → the internal invitees, stamped; `shares` says how many', async () => {
    respond = linkRespond;
    const out = await actions.linkRecording(OWNER, RID, { event: EVENT });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.body as { shares: number }).shares).toBe(8);
    const writes = shareWrites();
    expect(writes).toHaveLength(8);
    for (const q of writes) {
      expect(q.params[0]).toBe(77);
      expect(q.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
      expect(q.params).toContain('edit');
    }
    // Shares are rows on the MEETING only — nothing ties them to the recording.
    expect(sql.executed.some((q) => /recordings\b/.test(q.text) && q.text.includes('transcript_shares'))).toBe(
      false
    );
  });

  test('Make a meeting (no event) → no share', async () => {
    respond = linkRespond;
    const out = await actions.makeMeetingFromRecording(OWNER, RID, 'Ad-hoc call');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.body.shares).toBe(0);
    expect(sql.log.some((q) => q.text.includes('transcript_shares'))).toBe(false);
  });

  test('the settle that finishes an early-made meeting never shares (no second share, no DM)', () => {
    const settle = readFileSync(join(import.meta.dir, '..', 'recording-settle.ts'), 'utf8');
    expect(settle).not.toContain('transcript_shares');
    expect(settle).not.toContain('shareWithInternalInvitees');
    expect(settle).not.toContain('addShare');
  });
});

describe('re-link is idempotent and never rewrites a person’s share', () => {
  test('existing shares are skipped — a read share stays read and un-stamped', async () => {
    respond = (q) => {
      if (/SELECT \* FROM "[a-z_]+"\.transcript_shares WHERE transcript_id = \$1/.test(q.text)) {
        return [
          { shared_with_email: 'bea@trames.sg', access: 'read' },
          { shared_with_email: 'Chen@trames.sg', access: 'edit' },
        ];
      }
      return baseRespond(q) ?? [];
    };
    const n = await autoShare.shareWithInternalInvitees(
      'event-link',
      4242,
      OWNER.userId,
      OWNER.email,
      ATTENDEES
    );
    expect(n).toBe(6);
    const emails = shareWrites().map(emailOf);
    expect(emails).not.toContain('bea@trames.sg');
    expect(emails).not.toContain('chen@trames.sg');
    expect(emails).toHaveLength(6);
  });
});

describe('the cloud-import arm is the same rule, unstamped', () => {
  test('a Meet/Teams import shares with every internal invitee, edit, not link-born', async () => {
    const n = await autoShare.shareWithInternalInvitees(
      'cloud-import',
      4242,
      OWNER.userId,
      OWNER.email,
      ATTENDEES
    );
    expect(n).toBe(8);
    const writes = shareWrites();
    expect(writes).toHaveLength(8);
    expect(writes.map(emailOf).sort()).toEqual(INVITEES.map((i) => i.email).sort());
    for (const q of writes) {
      expect(q.params).toContain('edit');
      // No origin column in the INSERT: import shares are not link-born, so
      // "Unlink from event" never takes them.
      expect(q.text).not.toContain('origin');
    }
    // The import arm never reads the existing shares first (upsert as ever).
    expect(sql.executed.some((q) => /SELECT \* FROM "[a-z_]+"\.transcript_shares/.test(q.text))).toBe(false);
  });
});

describe('Unlink — link-born shares come off', () => {
  test('deletes origin = event-link rows (and the pre-048 signature), nothing broader', async () => {
    respond = (q) => {
      if (q.text.includes('information_schema.columns')) return [{ n: 1 }];
      if (/DELETE FROM "[a-z_]+"\.transcript_shares\b/.test(q.text)) {
        return [{ shared_with_email: 'bea@trames.sg' }, { shared_with_email: 'chen@trames.sg' }];
      }
      return [];
    };
    const removed = await shareOrigin.removeLinkBornShares(4242, OWNER.userId, [
      'Bea@trames.sg',
      'chen@trames.sg',
    ]);
    expect(removed).toEqual(['bea@trames.sg', 'chen@trames.sg']);
    const del = sql.executed.find((q) => /DELETE FROM "[a-z_]+"\.transcript_shares\b/.test(q.text))!;
    expect(del).toBeDefined();
    expect(del.text).toContain('transcript_id = $1');
    expect(del.params[0]).toBe(4242);
    // The very value the link arm stamps is the one Unlink deletes by.
    expect(del.text).toContain('origin =');
    expect(del.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
    // The unstamped arm is still pinned to the owner + edit + these emails …
    expect(del.params).toContainEqual(['bea@trames.sg', 'chen@trames.sg']);
    expect(del.params).toContain(OWNER.userId);
    // … and to shares older than the cutoff: a newer unstamped invitee share
    // was made by a person or a cloud import and survives.
    expect(del.text).toContain('shared_at <');
    expect(del.params).toContain(shareOrigin.LEGACY_LINK_SHARE_CUTOFF);
  });
});

describe('the recording stays personal — a share recipient reads the MEETING, not /api/recordings', () => {
  // A database where meeting 77 holds a clip on RID and is shared with Bea.
  const dbRespond = (q: RenderedQuery): unknown[] => {
    const base = baseRespond(q);
    if (base) return base;
    // Every recordings row belongs to the owner: only an owner predicate
    // naming him finds it.
    if (/"[a-z_]+"\.recordings\b/.test(q.text) && !q.text.includes('transcript_shares')) {
      if (!q.params.includes(OWNER.userId)) return [];
      return [
        {
          id: RID,
          owner_user_id: OWNER.userId,
          title: 'Huddle',
          source_kind: 'upload',
          created_at: '2026-10-02T01:00:00.000Z',
          standalone: true,
          all_clips: 0,
        },
      ];
    }
    // The old media-route arm: a meeting holding a clip, shared to Bea.
    if (q.text.includes('meeting_clips') && q.text.includes('transcript_shares')) {
      return q.params.includes(BEA.email) ? [{ ok: 1 }] : [];
    }
    // resolveAccess on the meeting: Bea holds a read share.
    if (q.text.includes('transcript_shares') && q.params.includes('m-77')) {
      return q.params.includes(BEA.email)
        ? [{ id: 77, user_id: OWNER.userId, assemblyai_id: 'm-77', gmeet_context: null, deleted_at: null, __access: 'read', access: 'read' }]
        : [];
    }
    return [];
  };

  const call = async (path: string, mod: string) => {
    const route = (await import(mod)) as { GET: (r: Request, c: unknown) => Promise<Response> };
    const req = new Request(`http://localhost${path}`) as Request & { nextUrl: URL };
    req.nextUrl = new URL(req.url);
    return route.GET(req, { params: Promise.resolve({ id: RID }) });
  };

  test('Bea can open the meeting', async () => {
    respond = dbRespond;
    const { resolveAccess } = await import('@/db-ops/transcript-access');
    const access = await resolveAccess(BEA.userId, BEA.email, 'm-77');
    expect(access).not.toBeNull();
  });

  test('…but every /api/recordings/:id route answers her 404 (the owner gets 200)', async () => {
    respond = dbRespond;
    currentUser = BEA;
    for (const [path, mod] of [
      [`/api/recordings/${RID}`, '@/app/api/recordings/[id]/route'],
      [`/api/recordings/${RID}/content`, '@/app/api/recordings/[id]/content/route'],
      [`/api/recordings/${RID}/audio`, '@/app/api/recordings/[id]/audio/route'],
    ] as const) {
      const res = await call(path, mod);
      expect(res.status).toBe(404);
    }
    // The media route no longer even asks whether a shared meeting holds it.
    expect(sql.executed.some((q) => q.text.includes('meeting_clips') && q.text.includes('transcript_shares'))).toBe(
      false
    );

    currentUser = OWNER;
    const own = await call(`/api/recordings/${RID}`, '@/app/api/recordings/[id]/route');
    expect(own.status).toBe(200);
  });
});

describe('re-link to a DIFFERENT event — the previous link’s shares do not outlive it', () => {
  // Event A (the meeting's current link) and event B (the one it is re-linked to).
  // Chen is on both; Bea and Dev were only on A; Ivan is new on B.
  const EVENT_B = {
    id: 'ev-b',
    title: 'Triton follow-up',
    startTime: '2026-10-01T07:30:00.000Z',
    endTime: '2026-10-01T08:00:00.000Z',
    attendees: [
      { email: 'Alok@trames.sg', name: 'Alok', responseStatus: 'accepted' },
      { email: 'Chen@trames.sg', name: 'Chen', responseStatus: 'accepted' },
      { email: 'ivan@trames.sg', name: 'Ivan', responseStatus: 'accepted' },
      { email: 'guest@partner.example', name: 'Guest', responseStatus: 'accepted' },
    ],
  };
  const B_INTERNAL = ['chen@trames.sg', 'ivan@trames.sg'];
  const DELETE_SHARES = /DELETE FROM "[a-z_]+"\.transcript_shares\b/;
  const SELECT_SHARES = /SELECT \* FROM "[a-z_]+"\.transcript_shares WHERE transcript_id = \$1/;
  const keepOf = (q: RenderedQuery) => q.params.find((p): p is string[] => Array.isArray(p));

  test('relinkSharesToEvent: stamped shares of non-B people go first, then only B’s missing invitees are added', async () => {
    respond = (q) => {
      if (DELETE_SHARES.test(q.text)) {
        return [{ shared_with_email: 'bea@trames.sg' }, { shared_with_email: 'dev@trames.sg' }];
      }
      // After the delete: Chen's link share (kept — he is on B) and Zed's
      // hand-made share (origin NULL — never touched).
      if (SELECT_SHARES.test(q.text)) {
        return [
          { shared_with_email: 'chen@trames.sg', access: 'edit', origin: 'event-link' },
          { shared_with_email: 'zed@trames.sg', access: 'read', origin: null },
        ];
      }
      return baseRespond(q) ?? [];
    };
    const out = await autoShare.relinkSharesToEvent(4242, OWNER.userId, OWNER.email, EVENT_B.attendees);
    expect(out.removed).toEqual(['bea@trames.sg', 'dev@trames.sg']);
    expect(out.shared).toBe(1);

    const del = sql.executed.find((q) => DELETE_SHARES.test(q.text))!;
    expect(del).toBeDefined();
    expect(del.params[0]).toBe(4242);
    // Stamped rows only — nothing that could match a person's own share.
    expect(del.text).toContain('origin =');
    expect(del.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
    expect(del.text).not.toContain('origin IS NULL');
    expect(del.text).not.toContain('shared_at <');
    // Keep = B's INTERNAL invitees, lower-cased; never the owner, never the guest.
    expect(del.text).toContain('NOT (');
    expect([...keepOf(del)!].sort()).toEqual(B_INTERNAL);

    // Order: the removal happens BEFORE the new event's shares are written.
    const writes = shareWrites();
    expect(writes.map(emailOf)).toEqual(['ivan@trames.sg']);
    expect(sql.executed.indexOf(writes[0]!)).toBeGreaterThan(sql.executed.indexOf(del));
    expect(writes[0]!.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
  });

  test('B with no internal invitees takes every stamped share off and adds none', async () => {
    respond = (q) => {
      if (DELETE_SHARES.test(q.text)) return [{ shared_with_email: 'bea@trames.sg' }];
      return baseRespond(q) ?? [];
    };
    const out = await autoShare.relinkSharesToEvent(4242, OWNER.userId, OWNER.email, [
      { email: 'alok@trames.sg' },
      { email: 'guest@partner.example' },
    ]);
    expect(out).toEqual({ shared: 0, removed: ['bea@trames.sg'] });
    const del = sql.executed.find((q) => DELETE_SHARES.test(q.text))!;
    expect(keepOf(del)).toEqual([]);
    expect(shareWrites()).toHaveLength(0);
  });

  test('without migration 048 nothing is stamped, so a re-link removes nothing', async () => {
    const g = globalThis as { __mwShareOriginColumn?: unknown };
    g.__mwShareOriginColumn = undefined;
    respond = (q) => {
      if (q.text.includes('information_schema.columns')) return [{ n: 0 }];
      return baseRespond(q) ?? [];
    };
    const removed = await shareOrigin.removeLinkBornSharesNotIn(4242, B_INTERNAL);
    expect(removed).toEqual([]);
    expect(sql.executed.some((q) => DELETE_SHARES.test(q.text))).toBe(false);
    g.__mwShareOriginColumn = undefined;
  });

  // The route: `POST /api/transcripts/:id/link-event` is the one path that
  // links an EXISTING meeting (the link dialog, the "Link to it" strips,
  // darth-cli `link`). `/api/recordings/:id/link` with an event always makes a
  // NEW meeting (a recording already in one answers 409 already-linked), and
  // every other link path (openUpload, split-to-an-event, a linked text
  // import) creates its meeting, so there is nothing previous to take off.
  const linkedRow = (ctx: Record<string, unknown> | null) => ({
    id: 4343,
    user_id: OWNER.userId,
    assemblyai_id: 'm-relink',
    status: 'uploading',
    title: 'Triton next steps!',
    scratch: false,
    local_audio_path: null,
    speaker_id_status: null,
    gmeet_context: ctx,
    __access: 'owner',
  });
  const routeRespond =
    (ctx: Record<string, unknown> | null) =>
    (q: RenderedQuery): unknown[] => {
      if (/FROM "[a-z_]+"\.transcripts t\s+LEFT JOIN "[a-z_]+"\.transcript_shares s/.test(q.text)) {
        return q.params.includes('m-relink') ? [linkedRow(ctx)] : [];
      }
      if (DELETE_SHARES.test(q.text)) return [{ shared_with_email: 'bea@trames.sg' }];
      if (SELECT_SHARES.test(q.text)) return [{ shared_with_email: 'chen@trames.sg', access: 'edit' }];
      // The people directory registration the route does for every attendee.
      if (/INSERT INTO "[a-z_]+"\.people\b/.test(q.text)) {
        return [{ id: 1, name: String(q.params[0]), email: String(q.params[1]) }];
      }
      return baseRespond(q) ?? [];
    };
  const postLink = async (event: unknown) => {
    const route = (await import('@/app/api/transcripts/[id]/link-event/route')) as {
      POST: (r: Request, c: unknown) => Promise<Response>;
    };
    const req = new Request('http://localhost/api/transcripts/m-relink/link-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    return route.POST(req, { params: Promise.resolve({ id: 'm-relink' }) });
  };

  test('link-event on a meeting linked to A, to B → A’s shares for non-B people come off, B’s missing are added', async () => {
    respond = routeRespond({ eventId: 'ev-triton', eventTitle: 'Triton next steps!', attendees: ATTENDEES });
    const res = await postLink(EVENT_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shared: number; sharesRemoved: string[] };
    expect(body.sharesRemoved).toEqual(['bea@trames.sg']);
    expect(body.shared).toBe(1);
    const del = sql.executed.find((q) => DELETE_SHARES.test(q.text))!;
    expect(del).toBeDefined();
    expect([...keepOf(del)!].sort()).toEqual(B_INTERNAL);
    const writes = shareWrites();
    expect(writes.map(emailOf)).toEqual(['ivan@trames.sg']);
    expect(sql.executed.indexOf(writes[0]!)).toBeGreaterThan(sql.executed.indexOf(del));
  });

  test('link-event on a meeting that was never linked removes nothing (a first link only adds)', async () => {
    respond = routeRespond(null);
    const res = await postLink(EVENT_B);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shared: number; sharesRemoved: string[] };
    expect(body.sharesRemoved).toEqual([]);
    expect(sql.executed.some((q) => DELETE_SHARES.test(q.text))).toBe(false);
    expect(shareWrites().map(emailOf)).toEqual(['ivan@trames.sg']);
  });
});

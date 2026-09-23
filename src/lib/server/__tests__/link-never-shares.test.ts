/**
 * Design step P4 (docs/recordings-meetings-series-design.md §2.2 F5, §6.2
 * Q2/Q8; owner decision 2026-09-23): LINKING A RECORDING TO A CALENDAR
 * OCCURRENCE NEVER CREATES SHARES. Only meetings carry shares, and sharing
 * is a separate act the person takes.
 *
 *   - A tray-style Link (an upload opened with the occurrence as its linked
 *     event — the same `openUpload` the web stepper, the calendar row's
 *     Upload and `darth-cli meetings upload --event` go through) on an
 *     occurrence with 8 internal invitees writes 0 `transcript_shares` rows,
 *     yet the invitees are on the meeting's context, where share suggestions
 *     read them from.
 *   - The cloud-import arm is unchanged: it still shares with every internal
 *     invitee, edit access.
 *   - Unlink still takes the link-born shares made before P4 back off
 *     (`origin = 'event-link'`, migration 048), touching nothing else.
 *
 * Over the fake postgres tag (db-ops/__tests__/helpers/fake-sql): every
 * query is rendered and logged, so "0 shares" is asserted on the SQL the code
 * actually ran, not on a mocked helper.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];

const OWNER = {
  userId: 'aaaaaaaa-0000-4000-8000-000000000001',
  email: 'alok@trames.sg',
  name: 'Alok',
};

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
// The owner and an external guest are on the invite too — neither is a share
// candidate on any arm.
const ATTENDEES = [
  { email: OWNER.email, name: 'Alok', responseStatus: 'accepted' },
  ...INVITEES,
  { email: 'guest@partner.example', name: 'Guest', responseStatus: 'accepted' },
];

type Pipeline = typeof import('@/lib/server/upload-pipeline');
type AutoShare = typeof import('@/lib/server/auto-share');
type ShareOrigin = typeof import('@/db-ops/share-origin');
let pipeline: Pipeline;
let autoShare: AutoShare;
let shareOrigin: ShareOrigin;

const shareWrites = () =>
  sql.executed.filter((q) => /INSERT INTO "[a-z_]+"\.transcript_shares\b/.test(q.text));

beforeAll(async () => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  pipeline = await import('@/lib/server/upload-pipeline');
  autoShare = await import('@/lib/server/auto-share');
  shareOrigin = await import('@/db-ops/share-origin');
});

beforeEach(() => {
  sql.log.length = 0;
  sql.executed.length = 0;
  respond = (q) => {
    // Migration 048 is applied.
    if (q.text.includes('information_schema.columns')) return [{ n: 1 }];
    // Whatever a transcripts INSERT/UPDATE returns: a plausible row.
    if (/\.transcripts\b/.test(q.text) && /RETURNING/i.test(q.text)) {
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
    if (/INSERT INTO "[a-z_]+"\.transcript_shares\b/.test(q.text)) {
      return [{ id: 1, transcript_id: q.params[0], shared_with_email: q.params[3] }];
    }
    return [];
  };
});

describe('P4 — a user link never shares', () => {
  test('tray-style Link on an occurrence with 8 internal invitees → 0 shares', async () => {
    const opened = await pipeline.openUpload(
      { userId: OWNER.userId, email: OWNER.email, name: OWNER.name } as never,
      {
        originalFilename: 'Triton next steps.m4a',
        contentType: 'audio/mp4',
        linkedEvent: {
          id: 'ev-triton',
          title: 'Triton next steps!',
          startTime: '2026-09-22T07:30:00.000Z',
          endTime: '2026-09-22T08:00:00.000Z',
          meetingCode: 'bgs-zqvv-dby',
          attendees: ATTENDEES,
        },
        reportPref: null,
        bytesTotal: 1_000_000,
        recorderRecordingId: null,
      }
    );
    expect(opened.ok).toBe(true);
    // The placeholder was created …
    expect(sql.executed.some((q) => /INSERT INTO "[a-z_]+"\.transcripts\b/.test(q.text))).toBe(
      true
    );
    // … and nobody was shared on it.
    expect(shareWrites()).toHaveLength(0);
    expect(sql.log.some((q) => q.text.includes('transcript_shares'))).toBe(false);

    // The invitees ARE on the meeting — that is what share-suggestions reads
    // (ctx.attendees) to offer "Share with the 8 invitees?".
    const placeholderInsert = sql.executed.find((q) =>
      /INSERT INTO "[a-z_]+"\.transcripts\b/.test(q.text)
    )!;
    const ctx = placeholderInsert.params.find(
      (p): p is { attendees: Array<{ email: string }> } =>
        typeof p === 'object' && p !== null && Array.isArray((p as { attendees?: unknown }).attendees)
    );
    expect(ctx?.attendees.map((a) => a.email)).toEqual(ATTENDEES.map((a) => a.email));
  });

  test('an unlinked upload shares nobody either', async () => {
    const opened = await pipeline.openUpload(
      { userId: OWNER.userId, email: OWNER.email, name: OWNER.name } as never,
      {
        originalFilename: 'huddle.m4a',
        contentType: 'audio/mp4',
        linkedEvent: null,
        reportPref: null,
        bytesTotal: 10,
      }
    );
    expect(opened.ok).toBe(true);
    expect(shareWrites()).toHaveLength(0);
  });
});

describe('Q8 — the cloud-import arm still shares', () => {
  test('a Meet/Teams import shares with every internal invitee, edit, not link-born', async () => {
    const n = await autoShare.shareCloudImportWithInternalInvitees(
      'cloud-import',
      4242,
      OWNER.userId,
      OWNER.email,
      ATTENDEES
    );
    expect(n).toBe(8);
    const writes = shareWrites();
    expect(writes).toHaveLength(8);
    const emails = writes.map((q) => q.params.find((p) => typeof p === 'string' && p.includes('@')));
    expect(emails.sort()).toEqual(INVITEES.map((i) => i.email).sort());
    for (const q of writes) {
      expect(q.params).toContain('edit');
      // No origin column in the INSERT: import shares are not link-born, so
      // "Unlink from event" never takes them.
      expect(q.text).not.toContain('origin');
    }
  });
});

describe('Unlink — legacy link-born shares still come off', () => {
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
    expect(del.text).toContain('origin =');
    expect(del.params).toContain(shareOrigin.SHARE_ORIGIN_EVENT_LINK);
    // The unstamped arm is still pinned to the owner + edit + these emails.
    expect(del.params).toContainEqual(['bea@trames.sg', 'chen@trames.sg']);
    expect(del.params).toContain(OWNER.userId);
  });
});

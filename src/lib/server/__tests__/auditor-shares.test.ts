/**
 * AUDITOR SHARES (owner, 2026-10-06 — lib/auditor-policy.ts): a meeting with
 * someone from outside Tramés on it is shared read-only with the auditors.
 *
 *   - "outside" excludes the internal domains, calendar resources and
 *     personal mailboxes (a gmail-only guest is a candidate interview);
 *   - the owner is never added to their own meeting;
 *   - an existing share is never touched (ON CONFLICT DO NOTHING) and an
 *     auditor removed from the meeting is never re-added (the ledger guard);
 *   - no ledger (migration 052 not applied) → nobody is added.
 *
 * Over the fake postgres tag: assertions are on the SQL actually run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createFakeSql,
  type FakeSql,
  type RenderedQuery,
} from '../../../db-ops/__tests__/helpers/fake-sql';
import { externalParties, SHARE_ORIGIN_AUDITOR } from '@/lib/auditor-policy';

const INTERNAL = new Set(['trames.sg', 'trames-engineering.com']);

describe('externalParties', () => {
  test('a customer on the invite is an outside party', () => {
    expect(
      externalParties(['alok@trames.sg', 'Jack.Adams@Geodis.com', 'eli@trames-engineering.com'], INTERNAL)
    ).toEqual(['jack.adams@geodis.com']);
  });
  test('rooms, group calendars and personal mailboxes are not', () => {
    expect(
      externalParties(
        [
          'c_188abc@resource.calendar.google.com',
          'team@group.calendar.google.com',
          'ashraffwork1@gmail.com',
          'someone@hotmail.com',
          null,
          '',
          'not-an-email',
        ],
        INTERNAL
      )
    ).toEqual([]);
  });
  test('a candidate plus a customer still counts (the customer)', () => {
    expect(externalParties(['x@gmail.com', 'y@app.co.id'], INTERNAL)).toEqual(['y@app.co.id']);
  });
});

let sql: FakeSql;
let ledger = true;
type AutoShare = typeof import('@/lib/server/auto-share');
let autoShare: AutoShare;

const OWNER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHARE_INSERT = /INSERT INTO "[a-z_]+"\.transcript_shares\b/;
const shareWrites = () => sql.executed.filter((q) => SHARE_INSERT.test(q.text));
const emailOf = (q: RenderedQuery) =>
  q.params.find((p): p is string => typeof p === 'string' && p.includes('@'));

beforeAll(async () => {
  sql = createFakeSql((q) => {
    if (q.text.includes('information_schema.tables')) return [{ n: ledger ? 1 : 0 }];
    if (q.text.includes('information_schema.columns')) return [{ n: 1 }];
    if (SHARE_INSERT.test(q.text)) return [{ id: 1 }];
    return [];
  });
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  autoShare = await import('@/lib/server/auto-share');
});

beforeEach(() => {
  sql.executed.length = 0;
  ledger = true;
  (globalThis as { __mwAuditorLedger?: unknown }).__mwAuditorLedger = undefined;
});

// The probes cache on globalThis — leave nothing behind for the next file.
afterAll(() => {
  const g = globalThis as { __mwAuditorLedger?: unknown; __mwShareOriginColumn?: unknown };
  g.__mwAuditorLedger = undefined;
  g.__mwShareOriginColumn = undefined;
});

describe('shareWithAuditors', () => {
  test('outside party → every auditor but the owner gets a read auditor share', async () => {
    const added = await autoShare.shareWithAuditors(42, OWNER_ID, 'Kawen.Koh@trames.sg', [
      { email: 'kawen.koh@trames.sg' },
      { email: 'jack.adams@geodis.com' },
    ]);
    expect(added).toEqual(['alok@trames.sg', 'ivan@trames.sg']);
    const writes = shareWrites();
    expect(writes.map(emailOf)).toEqual(['alok@trames.sg', 'ivan@trames.sg']);
    for (const w of writes) {
      expect(w.params).toContain(SHARE_ORIGIN_AUDITOR);
      expect(w.text).toContain("'read'");
      expect(w.text).toMatch(/ON CONFLICT \(transcript_id, shared_with_email\) DO NOTHING/);
      expect(w.text).toContain('auditor_share_removals');
    }
  });

  test('the owner-auditor is not added to their own meeting', async () => {
    const added = await autoShare.shareWithAuditors(42, OWNER_ID, 'alok@trames.sg', [
      { email: 'buyer@danone.com' },
    ]);
    expect(added).toEqual(['ivan@trames.sg']);
  });

  test('internal-only or candidate-only meetings add nobody', async () => {
    expect(
      await autoShare.shareWithAuditors(42, OWNER_ID, 'kawen.koh@trames.sg', [
        { email: 'jacqueline.ng@trames.sg' },
        { email: 'ashraffwork1@gmail.com' },
      ])
    ).toEqual([]);
    expect(shareWrites()).toHaveLength(0);
  });

  test('no ledger (052 not applied) → nobody is added', async () => {
    ledger = false;
    expect(
      await autoShare.shareWithAuditors(42, OWNER_ID, 'kawen.koh@trames.sg', [{ email: 'x@geodis.com' }])
    ).toEqual([]);
    expect(shareWrites()).toHaveLength(0);
  });

  test('every import/link runs it: shareWithInternalInvitees adds invitees, then auditors', async () => {
    const n = await autoShare.shareWithInternalInvitees('cloud-import', 42, OWNER_ID, 'kawen.koh@trames.sg', [
      { email: 'kawen.koh@trames.sg' },
      { email: 'jacqueline.ng@trames.sg' },
      { email: 'john.vella@geodis.com' },
    ]);
    expect(n).toBe(1); // auditors are not counted as invitee shares
    expect(shareWrites().map(emailOf)).toEqual([
      'jacqueline.ng@trames.sg',
      'alok@trames.sg',
      'ivan@trames.sg',
    ]);
  });
});

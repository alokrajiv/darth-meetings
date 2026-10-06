/**
 * Curated-series permissions (docs/curated-series-spec.md §6). Following a
 * series grants read access to other people's meetings, so who follows and
 * what a followed series matches are auditor decisions. Replaces the D4
 * organiser-or-creator rule of the key-based series (series-owner.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { canRemoveFollower, seriesPermissions } from '@/lib/series-permissions';

const alok = { userId: 'bf547379-4c7e-4e17-932e-0246e50bfe54', email: 'alok@trames.sg' };
const ivan = { userId: 'ivan-id', email: 'Ivan@Trames.sg' };
const creator = { userId: 'creator-id', email: 'kawen.koh@trames.sg' };
const jac = { userId: 'jac-id', email: 'jacqueline.ng@trames.sg' };

describe('seriesPermissions', () => {
  test('an unfollowed series: anyone edits its matching; followers are auditor-only', () => {
    const p = seriesPermissions({ createdBy: creator.userId, followerEmails: [] }, jac);
    expect(p.editMatching).toBe(true);
    expect(p.manageFollowers).toBe(false);
    expect(p.isFollower).toBe(false);
  });
  test('a followed series: only an auditor edits patterns/priority', () => {
    const facts = { createdBy: creator.userId, followerEmails: ['alok@trames.sg'] };
    expect(seriesPermissions(facts, jac).editMatching).toBe(false);
    expect(seriesPermissions(facts, creator).editMatching).toBe(false); // not even its creator
    expect(seriesPermissions(facts, ivan).editMatching).toBe(true);
    expect(seriesPermissions(facts, alok).manageFollowers).toBe(true);
  });
  test('delete: the creator or an auditor', () => {
    const facts = { createdBy: creator.userId, followerEmails: [] };
    expect(seriesPermissions(facts, creator).delete).toBe(true);
    expect(seriesPermissions(facts, ivan).delete).toBe(true);
    expect(seriesPermissions(facts, jac).delete).toBe(false);
    expect(seriesPermissions({ createdBy: null, followerEmails: [] }, jac).delete).toBe(false);
  });
  test('delete: a FOLLOWED series is auditor-only — not even its creator (it would drop the followers)', () => {
    const facts = { createdBy: creator.userId, followerEmails: ['alok@trames.sg'] };
    expect(seriesPermissions(facts, creator).delete).toBe(false);
    expect(seriesPermissions(facts, ivan).delete).toBe(true);
  });
  test('isFollower is case-insensitive', () => {
    const p = seriesPermissions({ createdBy: null, followerEmails: ['jacqueline.ng@trames.sg'] }, {
      userId: 'x',
      email: 'Jacqueline.Ng@Trames.sg',
    });
    expect(p.isFollower).toBe(true);
  });
});

describe('canRemoveFollower', () => {
  test('a follower may remove themselves, nobody else', () => {
    expect(canRemoveFollower(jac, 'JACQUELINE.NG@trames.sg')).toBe(true);
    expect(canRemoveFollower(jac, 'alok@trames.sg')).toBe(false);
  });
  test('an auditor may remove anyone', () => {
    expect(canRemoveFollower(alok, 'jacqueline.ng@trames.sg')).toBe(true);
  });
});

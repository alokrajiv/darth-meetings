/**
 * Curated series v2 — the role table (docs/curated-series-spec.md §11.1):
 * owner / editor / follower / auditor / nobody, and the two auditor-series
 * guards (non-auditor editors, auditor owners). Pure.
 */
import { describe, expect, test } from 'bun:test';
import {
  canAddEditor,
  canRemoveFollower,
  canSeeSeries,
  canTransferTo,
  seriesPermissions,
  type SeriesCallerFacts,
  type SeriesRoleFacts,
} from '@/lib/series-permissions';

const facts = (over: Partial<SeriesRoleFacts> = {}): SeriesRoleFacts => ({
  ownerEmail: 'kawen.koh@trames.sg',
  ownerUserId: 'kawen-id',
  ownerIsAuditor: false,
  editorEmails: ['siqian@trames.sg'],
  followerEmails: ['jacqueline.ng@trames.sg'],
  ...over,
});
const who = (email: string, over: Partial<SeriesCallerFacts> = {}): SeriesCallerFacts => ({
  callerEmail: email,
  callerUserId: `${email}-id`,
  callerIsAuditor: false,
  ...over,
});
const owner = who('Kawen.Koh@trames.sg', { callerUserId: 'kawen-id' });
const editor = who('siqian@trames.sg');
const follower = who('Jacqueline.Ng@Trames.sg');
const auditor = who('ivan@trames.sg', { callerIsAuditor: true });
const stranger = who('radhika@trames.sg');

describe('the role table', () => {
  test('owner: everything', () => {
    const p = seriesPermissions(facts(), owner);
    expect(p.role).toBe('owner');
    expect([p.see, p.edit, p.manageEditors, p.manageFollowers, p.transfer, p.delete]).toEqual([
      true, true, true, true, true, true,
    ]);
  });
  test('owner is recognised by user id too (email aliases)', () => {
    expect(seriesPermissions(facts(), who('alias@trames.sg', { callerUserId: 'kawen-id' })).isOwner).toBe(true);
  });
  test('editor: edit + manage, never transfer or delete', () => {
    const p = seriesPermissions(facts(), editor);
    expect(p.role).toBe('editor');
    expect([p.see, p.edit, p.manageEditors, p.manageFollowers, p.transfer, p.delete]).toEqual([
      true, true, true, true, false, false,
    ]);
  });
  test('follower: sees, cannot edit or manage (case-insensitive email)', () => {
    const p = seriesPermissions(facts(), follower);
    expect(p.role).toBe('follower');
    expect([p.see, p.edit, p.manageFollowers, p.transfer, p.delete]).toEqual([true, false, false, false, false]);
  });
  test('auditor: sees every series (oversight), edits nothing unless owner/editor', () => {
    const p = seriesPermissions(facts(), auditor);
    expect(p.role).toBe('auditor');
    expect([p.see, p.edit, p.manageFollowers, p.transfer, p.delete]).toEqual([true, false, false, false, false]);
    expect(seriesPermissions(facts({ editorEmails: ['ivan@trames.sg'] }), auditor).edit).toBe(true);
  });
  test('anyone else: the series does not exist for them', () => {
    const p = seriesPermissions(facts(), stranger);
    expect(p.role).toBeNull();
    expect(p.see).toBe(false);
    expect(canSeeSeries(facts(), stranger)).toBe(false);
    expect(p.edit || p.manageFollowers || p.delete || p.transfer).toBe(false);
  });
  test('an ownerless series (backfill could not map the creator) is only visible to its people + auditors', () => {
    const f = facts({ ownerEmail: null, ownerUserId: null, editorEmails: [], followerEmails: [] });
    expect(canSeeSeries(f, stranger)).toBe(false);
    expect(canSeeSeries(f, auditor)).toBe(true);
  });
});

describe('auditor-owned series (reach = every meeting)', () => {
  const aud = facts({ ownerEmail: 'alok@trames.sg', ownerUserId: 'alok-id', ownerIsAuditor: true });
  test('a non-auditor editor (left over from an auditors-table change) loses editing', () => {
    const p = seriesPermissions(aud, editor);
    expect(p.isEditor).toBe(true);
    expect(p.edit).toBe(false);
    expect(p.manageFollowers).toBe(false);
  });
  test('adding a NON-auditor editor → 400; an auditor editor is fine', () => {
    const alok = who('alok@trames.sg', { callerUserId: 'alok-id', callerIsAuditor: true });
    expect(canAddEditor(aud, alok, false)).toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(canAddEditor(aud, alok, true)).toEqual({ ok: true });
  });
  test('on a normal series the owner adds anyone; a follower cannot add (403)', () => {
    expect(canAddEditor(facts(), owner, false)).toEqual({ ok: true });
    expect(canAddEditor(facts(), follower, false)).toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });
});

describe('transfer', () => {
  test('only the owner transfers', () => {
    expect(canTransferTo(facts(), editor, { isAuditor: false, nonAuditorEditorsAfter: 0 }).ok).toBe(false);
    expect(canTransferTo(facts(), owner, { isAuditor: false, nonAuditorEditorsAfter: 2 }).ok).toBe(true);
  });
  test('a non-auditor can NEVER make an auditor the owner (broad pattern + followers → auditor reach)', () => {
    const v = canTransferTo(facts(), owner, { isAuditor: true, nonAuditorEditorsAfter: 0 });
    expect(v).toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });
  test('an auditor owner may hand to another auditor — but not while non-auditor editors would remain', () => {
    const aud = facts({ ownerEmail: 'alok@trames.sg', ownerUserId: 'alok-id', ownerIsAuditor: true, editorEmails: [] });
    const alok = who('alok@trames.sg', { callerUserId: 'alok-id', callerIsAuditor: true });
    expect(canTransferTo(aud, alok, { isAuditor: true, nonAuditorEditorsAfter: 0 })).toEqual({ ok: true });
    expect(canTransferTo(aud, alok, { isAuditor: true, nonAuditorEditorsAfter: 1 })).toEqual(
      expect.objectContaining({ ok: false, status: 400 })
    );
  });
});

describe('canRemoveFollower', () => {
  test('a follower may remove themselves, nobody else', () => {
    expect(canRemoveFollower(facts(), follower, 'JACQUELINE.NG@trames.sg')).toBe(true);
    expect(canRemoveFollower(facts({ followerEmails: ['jacqueline.ng@trames.sg', 'x@trames.sg'] }), follower, 'x@trames.sg')).toBe(false);
  });
  test('owner and editors remove anyone; an auditor (not owner/editor) does not', () => {
    expect(canRemoveFollower(facts(), owner, 'jacqueline.ng@trames.sg')).toBe(true);
    expect(canRemoveFollower(facts(), editor, 'jacqueline.ng@trames.sg')).toBe(true);
    expect(canRemoveFollower(facts(), auditor, 'jacqueline.ng@trames.sg')).toBe(false);
  });
  test('a stranger cannot even remove themselves from a series they cannot see', () => {
    expect(canRemoveFollower(facts(), stranger, 'radhika@trames.sg')).toBe(false);
  });
});

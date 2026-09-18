import { describe, expect, test } from 'bun:test';
import {
  SERIES_NOT_MANAGER_MESSAGE,
  canManageSeries,
  seriesManageVerdict,
  type SeriesManagementFacts,
} from '@/lib/series-owner';

/**
 * D4 hole #4: series delete/merge only required visibility. The rule:
 * organiser of at least one attached occurrence, or the series' creator.
 * `attendee` below is the low-involvement user — she can SEE the series
 * (a member transcript was shared with her) but organised nothing and did
 * not create it.
 */
const creator = { userId: 'c478bf8e-1e50-4a0d-8841-db774fb3b2d2', email: 'alok@trames.sg' };
const organiser = { userId: '256b02f9-8614-41cf-9e38-e6402bb0da11', email: 'Swaralee@trames.sg' };
const attendee = { userId: '19679081-a63f-4058-8ea4-dc5705744c75', email: 'jacqueline.ng@trames.sg' };

const facts: SeriesManagementFacts = {
  createdBy: creator.userId,
  memberOrganizerEmails: ['swaralee@trames.sg', 'radhika@trames.sg'],
};

describe('seriesManageVerdict', () => {
  test('a visible-but-uninvolved attendee is refused with the clear message', () => {
    const v = seriesManageVerdict(facts, attendee);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(SERIES_NOT_MANAGER_MESSAGE);
    expect(canManageSeries(facts, attendee)).toBe(false);
  });
  test('the organiser of one attached occurrence may (email case-insensitive)', () => {
    expect(seriesManageVerdict(facts, organiser)).toEqual({ ok: true, via: 'organizer' });
  });
  test('the creator may, even when they organised nothing', () => {
    expect(seriesManageVerdict(facts, creator)).toEqual({ ok: true, via: 'creator' });
  });
  test('creator unknown (NULL) → organiser rule only', () => {
    const noCreator = { ...facts, createdBy: null };
    expect(canManageSeries(noCreator, creator)).toBe(false);
    expect(canManageSeries(noCreator, organiser)).toBe(true);
  });
  test('no organiser on any member (uploads-only series) → creator only', () => {
    const uploads = { createdBy: creator.userId, memberOrganizerEmails: [] };
    expect(canManageSeries(uploads, organiser)).toBe(false);
    expect(canManageSeries(uploads, attendee)).toBe(false);
    expect(canManageSeries(uploads, creator)).toBe(true);
  });
  test('nobody is special-cased: an unrelated user id/email never passes', () => {
    const admin = { userId: 'bf547379-4c7e-4e17-932e-0246e50bfe54', email: 'kkoh@trames.sg' };
    expect(canManageSeries(facts, admin)).toBe(false);
  });
  test('an empty caller email cannot match an empty organiser entry', () => {
    const weird = { createdBy: null, memberOrganizerEmails: [''] };
    expect(canManageSeries(weird, { userId: 'x', email: '' })).toBe(false);
  });
});

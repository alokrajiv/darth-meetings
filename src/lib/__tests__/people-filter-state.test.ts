/**
 * The client side of the `summary=` filter (2026-10-27): the listing's
 * PeopleFilters value round-trips through the URL and onto every fetch, and
 * the summary terms count in the Filter badge like every other term.
 */
import { describe, expect, test } from 'bun:test';
import {
  EMPTY_PEOPLE_FILTERS,
  appendPeopleFilterParams,
  countPeopleFilters,
  hasPeopleFilters,
  peopleFiltersKey,
  readPeopleFiltersFromUrl,
} from '@/components/people-filter';

describe('summary in PeopleFilters', () => {
  test('read from the URL: known values only, lower-cased, de-duplicated', () => {
    expect(readPeopleFiltersFromUrl('?summary=missing').summary).toEqual(['missing']);
    expect(readPeopleFiltersFromUrl('?summary=Missing,failed&summary=FAILED').summary).toEqual(['missing', 'failed']);
    expect(readPeopleFiltersFromUrl('?summary=bogus,missing').summary).toEqual(['missing']);
    expect(readPeopleFiltersFromUrl('?provider=teams').summary).toEqual([]);
  });

  test('written onto a fetch as the shared param name', () => {
    const p = new URLSearchParams();
    appendPeopleFilterParams(p, { ...EMPTY_PEOPLE_FILTERS, summary: ['missing', 'failed'] });
    expect(p.get('summary')).toBe('missing,failed');
    const none = new URLSearchParams();
    appendPeopleFilterParams(none, EMPTY_PEOPLE_FILTERS);
    expect(none.has('summary')).toBe(false);
  });

  test('counts in the badge, flips hasPeopleFilters, changes the key', () => {
    const f = { ...EMPTY_PEOPLE_FILTERS, summary: ['missing' as const] };
    expect(countPeopleFilters(f)).toBe(1);
    expect(countPeopleFilters({ ...f, provider: ['teams'], summary: ['missing', 'failed'] })).toBe(3);
    expect(hasPeopleFilters(f)).toBe(true);
    expect(hasPeopleFilters(EMPTY_PEOPLE_FILTERS)).toBe(false);
    expect(peopleFiltersKey(f)).not.toBe(peopleFiltersKey(EMPTY_PEOPLE_FILTERS));
  });
});

/**
 * Recent searches (lib/recent-searches.ts): newest first, deduped by query +
 * scope, capped at 5, sanitized from storage.
 */
import { describe, expect, test } from 'bun:test';
import {
  RECENT_SEARCH_MAX,
  pushRecentSearch,
  removeRecentSearch,
  sanitizeRecentSearches,
  type RecentSearch,
} from '../recent-searches';

const scope = { id: 'gmeet-1', title: 'Weekly sync' };

describe('pushRecentSearch', () => {
  test('newest first, capped at RECENT_SEARCH_MAX', () => {
    let list: RecentSearch[] = [];
    for (let i = 0; i < 8; i++) list = pushRecentSearch(list, { q: `q${i}`, scope: null, at: i });
    expect(list.map((r) => r.q)).toEqual(['q7', 'q6', 'q5', 'q4', 'q3']);
    expect(list).toHaveLength(RECENT_SEARCH_MAX);
  });

  test('the same query (case / spaces aside) with the same scope moves to the top once', () => {
    let list = pushRecentSearch([], { q: 'budget', scope: null, at: 1 });
    list = pushRecentSearch(list, { q: 'pricing', scope: null, at: 2 });
    list = pushRecentSearch(list, { q: '  Budget ', scope: null, at: 3 });
    expect(list.map((r) => r.q)).toEqual(['Budget', 'pricing']);
  });

  test('the same query in a meeting and across all meetings are two entries; the chip title refreshes', () => {
    let list = pushRecentSearch([], { q: 'budget', scope: null, at: 1 });
    list = pushRecentSearch(list, { q: 'budget', scope, at: 2 });
    expect(list).toHaveLength(2);
    list = pushRecentSearch(list, { q: 'budget', scope: { id: 'gmeet-1', title: 'Weekly sync (renamed)' }, at: 3 });
    expect(list).toHaveLength(2);
    expect(list[0]!.scope).toEqual({ id: 'gmeet-1', title: 'Weekly sync (renamed)' });
  });

  test('blank / oversized queries are not remembered', () => {
    expect(pushRecentSearch([], { q: '   ', scope: null, at: 1 })).toEqual([]);
    expect(pushRecentSearch([], { q: 'x'.repeat(201), scope: null, at: 1 })).toEqual([]);
  });
});

test('removeRecentSearch drops that query + scope only', () => {
  let list = pushRecentSearch([], { q: 'budget', scope: null, at: 1 });
  list = pushRecentSearch(list, { q: 'budget', scope, at: 2 });
  expect(removeRecentSearch(list, { q: 'BUDGET', scope }).map((r) => r.scope)).toEqual([null]);
});

describe('sanitizeRecentSearches', () => {
  test('bad rows dropped, sorted newest first, capped', () => {
    const raw = [
      { q: 'a1', scope: null, at: 1 },
      { q: '', at: 5 },
      'junk',
      { q: 'b2', scope: { id: 'x', title: 7 }, at: 9 },
      { q: 'c3', scope: { title: 'no id' }, at: 3 },
      null,
    ];
    expect(sanitizeRecentSearches(raw)).toEqual([
      { q: 'b2', scope: { id: 'x', title: '' }, at: 9 },
      { q: 'c3', scope: null, at: 3 },
      { q: 'a1', scope: null, at: 1 },
    ]);
  });
  test('not an array → empty', () => {
    expect(sanitizeRecentSearches({ q: 'x' })).toEqual([]);
    expect(sanitizeRecentSearches(null)).toEqual([]);
  });
});

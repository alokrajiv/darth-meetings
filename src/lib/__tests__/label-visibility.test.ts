import { describe, expect, test } from 'bun:test';
import {
  hideUnseenSeriesLabels,
  isSeriesLabelPathKey,
  labelVisibleToCaller,
} from '@/lib/label-visibility';

/**
 * D4 hole #1: the org-wide catalog listed every auto-created
 * `Series/<title>` label — a series title is a meeting title. Model a
 * low-involvement caller (jacqueline-style: one shared transcript under one
 * series) and check what the catalog rule serves them.
 */
describe('isSeriesLabelPathKey', () => {
  test('the reserved root and anything under it', () => {
    expect(isSeriesLabelPathKey('series')).toBe(true);
    expect(isSeriesLabelPathKey('series/data scrum')).toBe(true);
    expect(isSeriesLabelPathKey('series/lp-global/weekly')).toBe(true);
  });
  test('hand-made taxonomy is never a series node', () => {
    expect(isSeriesLabelPathKey('clients')).toBe(false);
    expect(isSeriesLabelPathKey('clients/series')).toBe(false);
    expect(isSeriesLabelPathKey('seriesx')).toBe(false);
    expect(isSeriesLabelPathKey('series-2026')).toBe(false);
  });
});

describe('labelVisibleToCaller (low-involvement caller)', () => {
  // The catalog rows as the counts query returns them for a caller who can
  // see exactly one transcript, tagged Series/Data scrum.
  const catalog = [
    { id: 1, path_key: 'series', count_visible: 1 },
    { id: 2, path_key: 'series/data scrum', count_visible: 1 },
    { id: 3, path_key: 'series/alok <> swaralee - lp', count_visible: 0 },
    { id: 4, path_key: 'series/exec 1:1', count_visible: 0 },
    { id: 5, path_key: 'clients', count_visible: 0 },
    { id: 6, path_key: 'clients/acme', count_visible: 0 },
    { id: 7, path_key: 'priority/urgent', count_visible: 0 },
  ];

  test('series nodes with no visible tagged transcript vanish', () => {
    expect(labelVisibleToCaller(catalog[2]!)).toBe(false);
    expect(labelVisibleToCaller(catalog[3]!)).toBe(false);
  });
  test('the series node they hold a transcript under stays, and so does the root', () => {
    expect(labelVisibleToCaller(catalog[1]!)).toBe(true);
    expect(labelVisibleToCaller(catalog[0]!)).toBe(true);
  });
  test('hand-made labels stay visible even at zero — they are the org taxonomy', () => {
    expect(labelVisibleToCaller(catalog[4]!)).toBe(true);
    expect(labelVisibleToCaller(catalog[5]!)).toBe(true);
    expect(labelVisibleToCaller(catalog[6]!)).toBe(true);
  });
  test('hideUnseenSeriesLabels keeps order and drops only the unseen series nodes', () => {
    expect(hideUnseenSeriesLabels(catalog).map((r) => r.id)).toEqual([1, 2, 5, 6, 7]);
  });
  test('a caller with NO visible series transcript loses the whole Series subtree', () => {
    const none = catalog.map((r) => ({ ...r, count_visible: 0 }));
    expect(hideUnseenSeriesLabels(none).map((r) => r.id)).toEqual([5, 6, 7]);
  });
});

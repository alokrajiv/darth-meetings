/**
 * "Search in this meeting" (lib/meeting-scope-search.ts): every term must be
 * in the utterance, transcript order, snippet bold ranges, the cap.
 */
import { describe, expect, test } from 'bun:test';
import { searchInMeeting, type ScopeUtterance } from '../meeting-scope-search';

const u = (index: number, text: string, speaker = 'Atira', startMs = index * 10_000): ScopeUtterance => ({
  index,
  startMs,
  speaker,
  text,
});

const utts = [
  u(0, 'Welcome everyone, let us start with the budget.'),
  u(1, 'The pricing for Q4 is still open.', 'Ben'),
  u(2, 'Budget and pricing both move next week.', 'Chen'),
  u(3, 'BUDGET review is on Friday.'),
];

describe('searchInMeeting', () => {
  test('one term: every utterance holding it, in transcript order, case-insensitive', () => {
    const r = searchInMeeting(utts, 'budget');
    expect(r.hits.map((h) => h.index)).toEqual([0, 2, 3]);
    expect(r.total).toBe(3);
    expect(r.terms).toEqual(['budget']);
  });

  test('several terms: ALL must be in the same utterance', () => {
    const r = searchInMeeting(utts, 'budget pricing');
    expect(r.hits.map((h) => h.index)).toEqual([2]);
    expect(r.hits[0]!.speaker).toBe('Chen');
    expect(r.hits[0]!.startMs).toBe(20_000);
  });

  test('snippet: whole short utterance, bold ranges on every term', () => {
    const [hit] = searchInMeeting(utts, 'pricing budget').hits;
    expect(hit!.snippet.text).toBe('Budget and pricing both move next week.');
    expect(hit!.snippet.ranges).toEqual([
      [0, 6],
      [11, 18],
    ]);
    expect(hit!.snippet.atStart).toBe(true);
    expect(hit!.snippet.atEnd).toBe(true);
  });

  test('no usable term (empty, 1-char words) → nothing', () => {
    expect(searchInMeeting(utts, '').hits).toEqual([]);
    expect(searchInMeeting(utts, 'a b').total).toBe(0);
  });

  test('the cap keeps the total', () => {
    const many = Array.from({ length: 12 }, (_, i) => u(i, `budget line ${i}`));
    const r = searchInMeeting(many, 'budget', 5);
    expect(r.hits).toHaveLength(5);
    expect(r.total).toBe(12);
  });

  test('a long utterance gets a cut snippet around the first match', () => {
    const long = `${'filler '.repeat(60)}the budget is here ${'tail '.repeat(60)}`;
    const [hit] = searchInMeeting([u(7, long)], 'budget').hits;
    expect(hit!.snippet.atStart).toBe(false);
    expect(hit!.snippet.atEnd).toBe(false);
    expect(hit!.snippet.text).toContain('budget');
    expect(hit!.snippet.text.length).toBeLessThanOrEqual(150);
  });
});

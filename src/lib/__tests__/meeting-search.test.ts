/**
 * The results panel's search, pure half (lib/meeting-search.ts): query →
 * terms, the bold-range finder, the snippet builder (offsets, word
 * boundaries, ellipsis flags, unicode) and the raw-row → hit mapping.
 */
import { describe, expect, test } from 'bun:test';
import {
  SNIPPET_LEN,
  buildSnippet,
  hitFromRow,
  likePatternOf,
  matchRanges,
  searchTermsOf,
  shapeMeetingSearch,
  splitByRanges,
  type MeetingSearchRawRow,
  type SearchSnippet,
} from '../meeting-search';

/** The bold words of a snippet, as text. */
const bold = (s: Pick<SearchSnippet, 'text' | 'ranges'>) => s.ranges.map(([a, b]) => s.text.slice(a, b));

describe('searchTermsOf', () => {
  test('splits on whitespace, trims edge punctuation and quotes', () => {
    expect(searchTermsOf('  "budget,"   review. ')).toEqual(['budget', 'review']);
    expect(searchTermsOf('(Q3) «plan»')).toEqual(['Q3', 'plan']);
  });
  test('drops 1-char words, NULs, case-insensitive duplicates', () => {
    expect(searchTermsOf('a budget B Budget BUDGET')).toEqual(['budget']);
    expect(searchTermsOf('bu\u0000dget')).toEqual(['budget']);
    expect(searchTermsOf('a b c')).toEqual([]);
    expect(searchTermsOf('')).toEqual([]);
  });
  test('a term contained in a longer one adds nothing under AND', () => {
    expect(searchTermsOf('rev review')).toEqual(['review']);
    expect(searchTermsOf('Review rev Budget')).toEqual(['Review', 'Budget']);
  });
  test('caps the term count and length; counts code points, not UTF-16 units', () => {
    expect(searchTermsOf('aa bb cc dd ee ff gg hh')).toHaveLength(6);
    expect(Array.from(searchTermsOf('x'.repeat(500))[0]!)).toHaveLength(120);
    // One emoji is 2 UTF-16 units but 1 code point → too short alone.
    expect(searchTermsOf('😀')).toEqual([]);
    expect(searchTermsOf('😀😀')).toEqual(['😀😀']);
  });
  test('NFC-normalises (a decomposed é equals the composed one)', () => {
    expect(searchTermsOf('café')).toEqual(['café']);
  });
});

describe('likePatternOf / shapeMeetingSearch', () => {
  test('escapes LIKE metacharacters', () => {
    expect(likePatternOf('50%_off\\x')).toBe('%50\\%\\_off\\\\x%');
  });
  test('one pattern + one lowered term per term; null when nothing is left', () => {
    expect(shapeMeetingSearch('Budget Review')).toEqual({
      terms: ['Budget', 'Review'],
      patterns: ['%Budget%', '%Review%'],
      lowered: ['budget', 'review'],
    });
    expect(shapeMeetingSearch(' a ')).toBeNull();
  });
});

describe('matchRanges', () => {
  test('every occurrence of every term, case-insensitive, merged and sorted', () => {
    const t = 'Budget review: the BUDGET was reviewed';
    expect(matchRanges(t, ['budget', 'review'])).toEqual([
      [0, 6],
      [7, 13],
      [19, 25],
      [30, 36],
    ]);
  });
  test('overlapping / touching terms merge into one range', () => {
    expect(matchRanges('abcdef', ['abcd', 'cdef'])).toEqual([[0, 6]]);
    expect(matchRanges('abcdef', ['abc', 'def'])).toEqual([[0, 6]]);
  });
  test('regex metacharacters in terms are literal', () => {
    expect(matchRanges('cost (est.) $5', ['(est.)', '$5'])).toEqual([
      [5, 11],
      [12, 14],
    ]);
  });
  test('offsets are UTF-16 indices into the original string (emoji before the match)', () => {
    const t = '🎉🎉 Kick-off für Ärger';
    const r = matchRanges(t, ['ärger', 'kick']);
    expect(r.map(([a, b]) => t.slice(a, b))).toEqual(['Kick', 'Ärger']);
  });
  test('nothing to find', () => {
    expect(matchRanges('', ['a'])).toEqual([]);
    expect(matchRanges('abc', [])).toEqual([]);
  });
});

describe('splitByRanges', () => {
  test('plain / bold parts in order, clamped', () => {
    expect(splitByRanges('the budget plan', [[4, 10]])).toEqual([
      { text: 'the ', match: false },
      { text: 'budget', match: true },
      { text: ' plan', match: false },
    ]);
    expect(splitByRanges('ab', [[0, 99]])).toEqual([{ text: 'ab', match: true }]);
    expect(splitByRanges('ab', [])).toEqual([{ text: 'ab', match: false }]);
  });
});

describe('buildSnippet', () => {
  const words = (n: number, w = 'lorem') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

  test('a short field is returned whole, collapsed, with both edges flagged', () => {
    const s = buildSnippet('We  agreed\non the\tbudget.', ['budget'], { windowAtStart: true, windowAtEnd: true });
    expect(s.text).toBe('We agreed on the budget.');
    expect(bold(s)).toEqual(['budget']);
    expect(s.atStart).toBe(true);
    expect(s.atEnd).toBe(true);
  });

  test('a match deep in a long field: ≤ lead context, cut on word boundaries, both ellipses', () => {
    const win = `${words(40)} the BUDGET target ${words(40, 'ipsum')}`;
    const s = buildSnippet(win, ['budget'], { windowAtStart: true, windowAtEnd: false });
    expect(s.atStart).toBe(false);
    expect(s.atEnd).toBe(false);
    expect(bold(s)).toEqual(['BUDGET']);
    const at = s.text.indexOf('BUDGET');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThanOrEqual(40);
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_LEN);
    // Word boundaries: first and last words are whole.
    expect(s.text.split(' ')[0]).toMatch(/^lorem\d+$/);
    expect(s.text.split(' ').at(-1)).toMatch(/^ipsum\d+$/);
  });

  test('ranges are computed on the final text (every term, all occurrences)', () => {
    const s = buildSnippet('budget review then budget again', ['budget', 'review'], {
      windowAtStart: true,
      windowAtEnd: true,
    });
    expect(s.ranges).toEqual([
      [0, 6],
      [7, 13],
      [19, 25],
    ]);
  });

  test('a window that starts mid-field drops its partial first word and never claims atStart', () => {
    const s = buildSnippet('rtial word then budget', ['budget'], { windowAtStart: false, windowAtEnd: true });
    expect(s.text).toBe('word then budget');
    expect(s.atStart).toBe(false);
    expect(s.atEnd).toBe(true);
  });

  test('no word boundary (CJK) → a hard cut that keeps the match and never splits a surrogate pair', () => {
    const cjk = '会議'.repeat(60) + '予算' + '😀'.repeat(100);
    const s = buildSnippet(cjk, ['予算'], { windowAtStart: true, windowAtEnd: false });
    expect(bold(s)).toEqual(['予算']);
    expect(s.text.length).toBeLessThanOrEqual(SNIPPET_LEN + 1);
    // No lone surrogate at either edge.
    const first = s.text.charCodeAt(0);
    const last = s.text.charCodeAt(s.text.length - 1);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(s.atEnd).toBe(false);
  });

  test('emoji before the match keep the offsets right', () => {
    const s = buildSnippet('🎉🎉🎉 launch plan 🚀', ['plan'], { windowAtStart: true, windowAtEnd: true });
    expect(bold(s)).toEqual(['plan']);
  });

  test('a match longer than the budget is kept whole', () => {
    const long = 'x'.repeat(200);
    const s = buildSnippet(`pre ${long} post`, [long], { windowAtStart: true, windowAtEnd: true });
    expect(bold(s)).toEqual([long]);
  });

  test('no match in the window → its start, no bold', () => {
    const s = buildSnippet('nothing here at all', ['budget'], { windowAtStart: true, windowAtEnd: true });
    expect(s.text).toBe('nothing here at all');
    expect(s.ranges).toEqual([]);
  });
});

describe('hitFromRow', () => {
  const row = (over: Partial<MeetingSearchRawRow> = {}): MeetingSearchRawRow => ({
    id: 'abc',
    user_id: 'u1',
    title: 'Weekly sync',
    original_filename: null,
    recorded_at: '2026-09-30T02:00:00.000Z',
    created_at: '2026-09-30T03:00:00.000Z',
    duration: '1830',
    access: 'owner',
    labels: null,
    has_event: true,
    recorder_recording_id: null,
    source: 'imported',
    provider: 'gmeet',
    snip_field: null,
    snip_window: null,
    snip_window_start: null,
    snip_at_end: null,
    ...over,
  });

  test('a body hit: matched_in = the snippet field, the snippet built from the window', () => {
    const h = hitFromRow(
      row({ snip_field: 'content', snip_window: 'and the budget was approved', snip_window_start: 1, snip_at_end: true }),
      ['budget'],
      null
    );
    expect(h.matched_in).toBe('content');
    expect(h.snippet && bold(h.snippet)).toEqual(['budget']);
    expect(h.snippet?.atStart).toBe(true);
    expect(h.at).toBe('2026-09-30T02:00:00.000Z');
    expect(h.duration).toBe(1830);
    expect(h.owner).toBeNull();
    expect(h.labels).toEqual([]);
  });

  test('a window from mid-field is not atStart', () => {
    const h = hitFromRow(
      row({ snip_field: 'notes', snip_window: 'xx the budget', snip_window_start: 200, snip_at_end: false }),
      ['budget'],
      null
    );
    expect(h.snippet?.atStart).toBe(false);
    expect(h.snippet?.atEnd).toBe(false);
  });

  test('title-only hit: no snippet; filename-only hit: the filename is the snippet', () => {
    expect(hitFromRow(row({ title: 'Budget sync' }), ['budget'], null)).toMatchObject({
      matched_in: 'title',
      snippet: null,
    });
    const f = hitFromRow(row({ title: 'Weekly', original_filename: 'budget-2026.m4a' }), ['budget'], null);
    expect(f.matched_in).toBe('filename');
    expect(f.snippet && bold(f.snippet)).toEqual(['budget']);
  });

  test('shared rows carry their owner; own rows never do; Date columns become ISO', () => {
    const owner = { email: 'atira@trames.sg', name: 'Atira' };
    expect(hitFromRow(row({ access: 'read' }), ['x'], owner).owner).toEqual(owner);
    expect(hitFromRow(row({ access: 'owner' }), ['x'], owner).owner).toBeNull();
    const d = hitFromRow(row({ recorded_at: null, created_at: new Date('2026-01-02T03:04:05Z') }), ['x'], null);
    expect(d.at).toBe('2026-01-02T03:04:05.000Z');
  });
});

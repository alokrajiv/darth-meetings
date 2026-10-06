/**
 * Curated-series patterns (docs/curated-series-spec.md §2): the pure
 * matcher every surface shares — stored meetings, calendar rows, the
 * preview and the seed. Real titles from the 2026-10-06 seed table.
 */
import { describe, expect, test } from 'bun:test';
import {
  editorToPatterns,
  factsFromCalendarRow,
  factsFromContext,
  MAX_PATTERNS,
  patternMatches,
  patternsToEditor,
  pickSeries,
  seriesMatches,
  validatePatterns,
  type SeriesFacts,
  type SeriesPattern,
} from '@/lib/series-patterns';

const facts = (over: Partial<SeriesFacts> = {}): SeriesFacts => ({
  title: null,
  emails: [],
  recurring: false,
  ...over,
});

describe('title patterns', () => {
  const ai: SeriesPattern = { kind: 'title', regex: '^AI - Daily' };
  test('case-insensitive, anchored like a JS RegExp', () => {
    expect(patternMatches(ai, facts({ title: 'AI - Daily standup' }))).toBe(true);
    expect(patternMatches(ai, facts({ title: 'ai - daily' }))).toBe(true);
    expect(patternMatches(ai, facts({ title: 'Re: AI - Daily' }))).toBe(false);
    expect(patternMatches(ai, facts({ title: null }))).toBe(false);
  });
  test('JS dialect: \\b and alternation work as written in the seed', () => {
    const data: SeriesPattern = { kind: 'title', regex: '^Data (weekly|QA)\\b' };
    expect(patternMatches(data, facts({ title: 'Data weekly sync' }))).toBe(true);
    expect(patternMatches(data, facts({ title: 'Data QA' }))).toBe(true);
    expect(patternMatches(data, facts({ title: 'Data QAT review' }))).toBe(false);
    const perfume: SeriesPattern = { kind: 'title', regex: 'spanish.*perf?ume' };
    expect(patternMatches(perfume, facts({ title: 'Ivan <> Jacq: Spanish perume chat' }))).toBe(true);
  });
  test('a series matches when ANY pattern does; none = nothing', () => {
    const jacq: SeriesPattern[] = [
      { kind: 'title', regex: 'spanish.*perf?ume' },
      { kind: 'title', regex: '^AI AM$' },
    ];
    expect(seriesMatches(jacq, facts({ title: 'AI AM' }))).toBe(true);
    expect(seriesMatches(jacq, facts({ title: 'AI AM review' }))).toBe(false);
    expect(seriesMatches([], facts({ title: 'anything' }))).toBe(false);
  });
});

describe('invite patterns', () => {
  const oneOnOne: SeriesPattern = {
    kind: 'invite',
    all: ['ivan@trames.sg', 'jacqueline.ng@trames.sg'],
    internalOnly: true,
    maxPeople: 3,
  };
  test('every "all" email must be on the invite', () => {
    expect(
      patternMatches(oneOnOne, facts({ emails: ['ivan@trames.sg', 'jacqueline.ng@trames.sg'] }))
    ).toBe(true);
    expect(patternMatches(oneOnOne, facts({ emails: ['ivan@trames.sg'] }))).toBe(false);
  });
  test('internalOnly refuses any outside attendee', () => {
    expect(
      patternMatches(
        oneOnOne,
        facts({ emails: ['ivan@trames.sg', 'jacqueline.ng@trames.sg', 'buyer@danone.com'] })
      )
    ).toBe(false);
  });
  test('maxPeople caps the invite size', () => {
    const big = ['ivan@trames.sg', 'jacqueline.ng@trames.sg', 'a@trames.sg', 'b@trames.sg'];
    expect(patternMatches(oneOnOne, facts({ emails: big }))).toBe(false);
  });
  test('"any" needs at least one; recurringOnly needs a recurring event', () => {
    const p: SeriesPattern = {
      kind: 'invite',
      all: ['ivan@trames.sg'],
      any: ['kawen.koh@trames.sg', 'swaralee@trames.sg'],
      recurringOnly: true,
    };
    expect(patternMatches(p, facts({ emails: ['ivan@trames.sg', 'swaralee@trames.sg'], recurring: true }))).toBe(true);
    expect(patternMatches(p, facts({ emails: ['ivan@trames.sg', 'swaralee@trames.sg'], recurring: false }))).toBe(false);
    expect(patternMatches(p, facts({ emails: ['ivan@trames.sg'], recurring: true }))).toBe(false);
  });
});

describe('pickSeries — several series match', () => {
  const series = [
    { id: 4, priority: 100, patterns: [{ kind: 'title', regex: '^Data' }] as SeriesPattern[] },
    { id: 9, priority: 50, patterns: [{ kind: 'title', regex: 'Data scrum' }] as SeriesPattern[] },
    { id: 2, priority: 50, patterns: [{ kind: 'title', regex: 'scrum' }] as SeriesPattern[] },
  ];
  test('lowest priority wins, then the lowest id', () => {
    expect(pickSeries(series, facts({ title: 'Data scrum' }))?.id).toBe(2);
    expect(pickSeries(series, facts({ title: 'Data weekly' }))?.id).toBe(4);
    expect(pickSeries(series, facts({ title: 'Lunch' }))).toBeNull();
  });
  test('an excluded series is skipped — the next winner takes it', () => {
    expect(pickSeries(series, facts({ title: 'Data scrum' }), new Set([2]))?.id).toBe(9);
    expect(pickSeries(series, facts({ title: 'Data scrum' }), new Set([2, 9, 4]))).toBeNull();
  });
});

describe('validatePatterns', () => {
  test('normalises valid input (emails lower-cased, false flags dropped)', () => {
    const v = validatePatterns([
      { kind: 'title', regex: '  ^Cool Beers ' },
      { kind: 'invite', all: ['Ivan@Trames.sg'], internalOnly: false, recurringOnly: true },
    ]);
    expect(v).toEqual({
      ok: true,
      patterns: [
        { kind: 'title', regex: '^Cool Beers' },
        { kind: 'invite', all: ['ivan@trames.sg'], recurringOnly: true },
      ],
    });
  });
  const bad: Array<[string, unknown]> = [
    ['non-array', { kind: 'title', regex: 'x' }],
    ['unknown kind', [{ kind: 'organizer', value: 'x' }]],
    ['regex that does not compile', [{ kind: 'title', regex: '^(Data' }]],
    ['regex over 300 chars', [{ kind: 'title', regex: 'a'.repeat(301) }]],
    ['catastrophic nested quantifier', [{ kind: 'title', regex: '(a+)+$' }]],
    ['empty title', [{ kind: 'title', regex: '   ' }]],
    ['invite with empty all', [{ kind: 'invite', all: [] }]],
    ['invalid email', [{ kind: 'invite', all: ['ivan@'] }]],
    ['invalid email in any', [{ kind: 'invite', all: ['ivan@trames.sg'], any: ['nope'] }]],
    ['maxPeople 0', [{ kind: 'invite', all: ['ivan@trames.sg'], maxPeople: 0 }]],
    ['too many patterns', Array.from({ length: MAX_PATTERNS + 1 }, () => ({ kind: 'title', regex: 'x' }))],
  ];
  for (const [name, input] of bad) {
    test(`rejects: ${name}`, () => {
      const v = validatePatterns(input);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
    });
  }
  test('every seed pattern passes (the seed table is valid input)', () => {
    for (const regex of [
      '^AI - Daily',
      '^Data (weekly|QA)\\b',
      '^DevOps (Engineering )?Scrum',
      '^Analytics (Cadence|transition)',
      'spanish.*perf?ume',
      'Paper, ?Nuts',
      '^LP-Global ?<> ?Trames Weekly',
      '^Ivan / Ka Wen',
    ]) {
      expect(validatePatterns([{ kind: 'title', regex }]).ok).toBe(true);
    }
  });
});

describe('adapters', () => {
  test('factsFromContext: event title wins over the row title; resources dropped', () => {
    const f = factsFromContext({
      title: 'Recording 2026-10-01',
      gmeet_context: {
        eventTitle: 'AI - Daily',
        organizerEmail: 'Alok@trames.sg',
        recurringEventId: 'abc_R20260101T010000',
        attendees: [
          { email: 'Eli@Trames.sg' },
          { email: 'c_188@resource.calendar.google.com' },
          { email: 'alok@trames.sg' },
          null,
        ],
      },
    });
    expect(f).toEqual({
      title: 'AI - Daily',
      emails: ['eli@trames.sg', 'alok@trames.sg'],
      recurring: true,
    });
  });
  test('factsFromContext: no context → own title, nobody, not recurring', () => {
    expect(factsFromContext({ title: ' Cool Beers ', gmeet_context: null })).toEqual({
      title: 'Cool Beers',
      emails: [],
      recurring: false,
    });
  });
  test('factsFromCalendarRow: the calendar_event_cache shape', () => {
    const f = factsFromCalendarRow({
      title: 'Weekly MCAP, SL',
      organizer_email: 'kawen.koh@trames.sg',
      recurring_event_id: null,
      attendees: [{ email: 'ivan@trames.sg' }, { email: 'team@group.calendar.google.com' }],
    });
    expect(f).toEqual({
      title: 'Weekly MCAP, SL',
      emails: ['ivan@trames.sg', 'kawen.koh@trames.sg'],
      recurring: false,
    });
  });
});

describe('editor round-trip', () => {
  test('one regex per line + one invite rule; extra invite rules survive a save', () => {
    const patterns: SeriesPattern[] = [
      { kind: 'title', regex: '^Juggling the Customers' },
      { kind: 'title', regex: '^DKSH Weekly Review' },
      { kind: 'invite', all: ['ivan@trames.sg'], maxPeople: 2 },
      { kind: 'invite', all: ['siqian@trames.sg'] },
    ];
    const state = patternsToEditor(patterns);
    expect(state.titles).toBe('^Juggling the Customers\n^DKSH Weekly Review');
    expect(state.invite.enabled).toBe(true);
    const back = validatePatterns(editorToPatterns(state));
    expect(back).toEqual({ ok: true, patterns });
  });
});

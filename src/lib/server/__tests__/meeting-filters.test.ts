import { describe, expect, test } from 'bun:test';
import {
  EMPTY_MEETING_FILTERS,
  MAX_FILTER_TERMS,
  MAX_FILTER_TERM_LEN,
  escapeLike,
  hasPeopleFilters,
  parseMeetingFilters,
  splitFilterList,
  toLikePatterns,
} from '@/lib/server/meeting-filters';

const qs = (s: string) => new URLSearchParams(s);

describe('splitFilterList', () => {
  test('splits on commas, trims, lower-cases, de-dupes, drops empties', () => {
    expect(splitFilterList(' Nicolas , @LP-Global.com,,nicolas ,')).toEqual([
      'nicolas',
      '@lp-global.com',
    ]);
  });
  test('null / empty → []', () => {
    expect(splitFilterList(null)).toEqual([]);
    expect(splitFilterList('')).toEqual([]);
    expect(splitFilterList(' , ')).toEqual([]);
  });
  test('strips NUL bytes (Postgres rejects them) instead of passing them through', () => {
    expect(splitFilterList('\u0000')).toEqual([]);
    expect(splitFilterList('ni\u0000colas,\u0000')).toEqual(['nicolas']);
  });
});

describe('parseMeetingFilters bounds', () => {
  test('too many OR terms → not ok (400), never a silently narrower result', () => {
    const many = Array.from({ length: MAX_FILTER_TERMS + 5 }, (_, i) => `a${i}@x.com`).join(',');
    const r = parseMeetingFilters(qs(`participant=${many}`));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain(`max ${MAX_FILTER_TERMS}`);
    expect(parseMeetingFilters(qs(`speaker=${many}`)).ok).toBe(false);
    // Exactly the cap is fine (duplicates collapse before counting).
    const atCap = Array.from({ length: MAX_FILTER_TERMS }, (_, i) => `a${i}`).join(',');
    expect(parseMeetingFilters(qs(`organizer=${atCap},${atCap}`)).ok).toBe(true);
  });
  test('over-long term → not ok (400)', () => {
    const long = 'x'.repeat(MAX_FILTER_TERM_LEN + 1);
    const r = parseMeetingFilters(qs(`participant=${long}`));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('too long');
    expect(parseMeetingFilters(qs(`participant=${'x'.repeat(MAX_FILTER_TERM_LEN)}`)).ok).toBe(true);
  });
  test('NUL in q is stripped before the length rule', () => {
    const r = parseMeetingFilters(qs('q=ab%00'));
    expect(r.ok && r.filters.q).toBe('ab');
    const nulOnly = parseMeetingFilters(qs('q=%00%00'));
    expect(nulOnly.ok && nulOnly.filters.q).toBeNull();
  });
});

describe('parseMeetingFilters', () => {
  test('no params → empty filters (not filtering)', () => {
    const r = parseMeetingFilters(qs(''));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.filters).toEqual(EMPTY_MEETING_FILTERS);
    expect(hasPeopleFilters(r.filters)).toBe(false);
  });

  test('parses every contract param', () => {
    const r = parseMeetingFilters(
      qs(
        'participant=@lp-global.com,Nicolas&organizer=swaralee&provider=teams,gmeet&speaker=Rita&q=LP%20weekly'
      )
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.filters).toEqual({
      participant: ['@lp-global.com', 'nicolas'],
      organizer: ['swaralee'],
      provider: ['teams', 'gmeet'],
      speaker: ['rita'],
      q: 'LP weekly',
    });
    expect(hasPeopleFilters(r.filters)).toBe(true);
  });

  test('provider accepts upload and is case-insensitive', () => {
    const r = parseMeetingFilters(qs('provider=Upload,TEAMS'));
    expect(r.ok && r.filters.provider).toEqual(['upload', 'teams']);
  });

  test('invalid provider → not ok (route answers 400)', () => {
    const r = parseMeetingFilters(qs('provider=bogus'));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toContain('bogus');
    // One bad value poisons the whole list — no silent partial filter.
    expect(parseMeetingFilters(qs('provider=teams,zoom')).ok).toBe(false);
  });

  test('empty provider list is "not filtering", not an error', () => {
    const r = parseMeetingFilters(qs('provider=&provider=,'));
    expect(r.ok && r.filters.provider).toEqual([]);
  });

  test('q shorter than 2 chars is ignored; q is trimmed but keeps case', () => {
    expect(parseMeetingFilters(qs('q=a')).ok && parseMeetingFilters(qs('q=a')).ok).toBe(true);
    const short = parseMeetingFilters(qs('q=%20a%20'));
    expect(short.ok && short.filters.q).toBeNull();
    const ok = parseMeetingFilters(qs('q=%20Data%20Scrum%20'));
    expect(ok.ok && ok.filters.q).toBe('Data Scrum');
  });

  test('repeated params behave like a comma list', () => {
    const r = parseMeetingFilters(qs('participant=a@x.com&participant=b@y.com'));
    expect(r.ok && r.filters.participant).toEqual(['a@x.com', 'b@y.com']);
  });

  test('accepts a plain record source too', () => {
    const r = parseMeetingFilters({ participant: 'X', provider: ['gmeet'], q: undefined });
    expect(r.ok && r.filters.participant).toEqual(['x']);
    expect(r.ok && r.filters.provider).toEqual(['gmeet']);
    expect(r.ok && r.filters.q).toBeNull();
  });

  test('hasPeopleFilters ignores q', () => {
    const r = parseMeetingFilters(qs('q=hello'));
    expect(r.ok && hasPeopleFilters(r.filters)).toBe(false);
  });
});

describe('LIKE pattern helpers', () => {
  test('escapes %, _ and backslash', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });
  test('wraps each term in % for ILIKE ANY', () => {
    expect(toLikePatterns(['nicolas', '@lp-global.com'])).toEqual([
      '%nicolas%',
      '%@lp-global.com%',
    ]);
  });
});

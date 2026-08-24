import { describe, expect, test } from 'bun:test';
import { MAX_SEGMENT, validateSegment } from '@/lib/labels';
import {
  SERIES_LABEL_ROOT,
  deriveSeriesLabelName,
  seriesLabelPath,
} from '@/lib/series-label-name';

describe('deriveSeriesLabelName', () => {
  test('plain title passes through', () => {
    const n = deriveSeriesLabelName('Data Cadence', 9);
    expect(n.base).toBe('Data Cadence');
    expect(n.suffixed).toBe('Data Cadence (#9)');
  });

  test('keeps angle brackets and punctuation (real series titles)', () => {
    const n = deriveSeriesLabelName('LP-Global<>Trames Weekly Catch Up', 5);
    expect(n.base).toBe('LP-Global<>Trames Weekly Catch Up');
    expect(n.suffixed).toBe('LP-Global<>Trames Weekly Catch Up (#5)');
  });

  test("replaces '/' (illegal in a segment) with '-'", () => {
    const n = deriveSeriesLabelName('TRAMES / BBN Weekly touch base', 13);
    expect(n.base).toBe('TRAMES - BBN Weekly touch base');
    expect(validateSegment(n.base).ok).toBe(true);
  });

  test('strips control characters and collapses whitespace', () => {
    const n = deriveSeriesLabelName('  Data\tScrum\n  weekly ', 7);
    expect(n.base).toBe('Data Scrum weekly');
  });

  test('empty / whitespace title degrades to Series #<id>', () => {
    expect(deriveSeriesLabelName('', 42).base).toBe('Series #42');
    expect(deriveSeriesLabelName('   ', 42).base).toBe('Series #42');
    expect(deriveSeriesLabelName('\t\n', 42).base).toBe('Series #42');
  });

  test('long titles truncate to MAX_SEGMENT code points, trimmed', () => {
    const long = 'A'.repeat(80);
    const n = deriveSeriesLabelName(long, 3);
    expect([...n.base].length).toBe(MAX_SEGMENT);
    expect(validateSegment(n.base).ok).toBe(true);
  });

  test('suffixed variant always fits MAX_SEGMENT and ends with the id marker', () => {
    const long = 'Very long recurring series title that keeps going on and on forever';
    const n = deriveSeriesLabelName(long, 12345);
    expect([...n.suffixed].length).toBeLessThanOrEqual(MAX_SEGMENT);
    expect(n.suffixed.endsWith(' (#12345)')).toBe(true);
    expect(validateSegment(n.suffixed).ok).toBe(true);
  });

  test('suffix is deterministic per series id (idempotent reuse)', () => {
    const a = deriveSeriesLabelName('Integration Cadence', 6);
    const b = deriveSeriesLabelName('Integration Cadence', 1);
    expect(a.base).toBe(b.base); // collision on base…
    expect(a.suffixed).not.toBe(b.suffixed); // …resolved by the id suffix
  });

  test('code-point truncation does not split surrogate pairs', () => {
    const emoji = '📞'.repeat(70);
    const n = deriveSeriesLabelName(emoji, 8);
    expect([...n.base].length).toBe(MAX_SEGMENT);
    expect(validateSegment(n.base).ok).toBe(true);
  });
});

describe('seriesLabelPath', () => {
  test('prefixes the reserved root', () => {
    expect(seriesLabelPath('Data Cadence')).toBe(`${SERIES_LABEL_ROOT}/Data Cadence`);
  });
});

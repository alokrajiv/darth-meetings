import { describe, expect, test } from 'bun:test';
import {
  REPORT_PREFS,
  defaultReportPref,
  normalizeReportPref,
  parseReportPref,
  reportLabel,
  storedReportPref,
  strongestReport,
} from '@/lib/report-pref';

/**
 * As built 2026-09-21: a generation always writes BOTH tiers, so 'summary'
 * is gone from the type. It is still accepted everywhere a value can arrive
 * from outside this build (old darth-cli, old tabs, prefs stored before
 * today) and read as the detailed default — nothing 400s, nothing migrates.
 */
describe('report prefs', () => {
  test('summary-only is not a value any more', () => {
    expect([...REPORT_PREFS]).toEqual(['detailed-video', 'detailed-text', 'later']);
    expect(REPORT_PREFS as readonly string[]).not.toContain('summary');
  });

  test('the default is video frames when there is video, text otherwise', () => {
    expect(defaultReportPref(true)).toBe('detailed-video');
    expect(defaultReportPref(false)).toBe('detailed-text');
  });

  test('live values pass through', () => {
    for (const p of REPORT_PREFS) expect(parseReportPref(p)).toBe(p);
  });

  test('legacy summary is read as the detailed default, never rejected', () => {
    expect(parseReportPref('summary')).toBe('detailed-video');
    expect(normalizeReportPref('summary', false)).toBe('detailed-text');
    expect(storedReportPref('summary')).toBe('detailed-video');
  });

  test('unrecognised parses to null; stored reads fall back to the default', () => {
    expect(parseReportPref('nonsense')).toBeNull();
    expect(parseReportPref(null)).toBeNull();
    expect(parseReportPref(undefined)).toBeNull();
    expect(parseReportPref('')).toBeNull();
    expect(storedReportPref(null)).toBe('detailed-video');
    expect(storedReportPref(undefined, false)).toBe('detailed-text');
    expect(storedReportPref('nonsense', false)).toBe('detailed-text');
  });

  test('strongestReport never lowers an ask, and ranks legacy as the default', () => {
    expect(strongestReport([])).toBe('later');
    expect(strongestReport([null, undefined])).toBe('later');
    expect(strongestReport(['later', 'detailed-text'])).toBe('detailed-text');
    expect(strongestReport(['detailed-text', 'detailed-video'])).toBe('detailed-video');
    expect(strongestReport(['detailed-video', 'later'])).toBe('detailed-video');
    // A colleague still on the retired value asks for the detailed default,
    // which outranks a text-only ask.
    expect(strongestReport(['detailed-text', 'summary'])).toBe('detailed-video');
    expect(strongestReport(['summary', 'later'])).toBe('detailed-video');
  });

  test('labels name both tiers, because both are always written', () => {
    expect(reportLabel('detailed-video')).toBe('summary + detailed report with video frames');
    expect(reportLabel('detailed-text')).toBe('summary + detailed report');
    expect(reportLabel('later')).toBe('nothing (decide on the page)');
    // Legacy rows render as what they will actually produce now.
    expect(reportLabel('summary')).toBe('summary + detailed report with video frames');
    expect(reportLabel(null)).toBe('summary + detailed report');
  });
});

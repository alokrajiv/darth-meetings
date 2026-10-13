import { describe, expect, test } from 'bun:test';
import { hasForeignScript, transcriptHealth } from '@/lib/transcript-health';
import type { TranscriptResponse } from '@/lib/format';

/**
 * The mixed-language signal (docs/transcription-merge-spec.md §2). SYNTHETIC
 * fixtures only. The "row 1134"-shaped case reproduces that row's published
 * facts (auto-detected `en` at language confidence 0.28, a block of
 * low-confidence turns, a few lines of invented foreign script) without any
 * of its text.
 */

function utterance(start: number, end: number, text: string, conf: number) {
  return {
    speaker: 'A',
    start,
    end,
    text,
    words: text.split(' ').map((t, i) => ({ text: t, start: start + i, end: start + i + 1, confidence: conf })),
  };
}

function payload(utterances: ReturnType<typeof utterance>[], extra: Partial<TranscriptResponse> = {}): TranscriptResponse {
  return {
    id: 'job-synthetic',
    status: 'completed',
    created: '2026-10-13T00:00:00Z',
    language_code: 'en',
    confidence: 0.9,
    utterances,
    ...extra,
  } as TranscriptResponse;
}

describe('hasForeignScript', () => {
  test('Thai, Devanagari, CJK, Hangul and Vietnamese-only letters count; plain accents do not', () => {
    expect(hasForeignScript('hello สวัสดี')).toBe(true);
    expect(hasForeignScript('नमस्ते')).toBe(true);
    expect(hasForeignScript('你好')).toBe(true);
    expect(hasForeignScript('안녕')).toBe(true);
    expect(hasForeignScript('được không')).toBe(true);
    expect(hasForeignScript('cafe résumé naïve')).toBe(false);
  });
});

describe('transcriptHealth', () => {
  test('a clean English call is not suspected', () => {
    const p = payload(
      Array.from({ length: 20 }, (_, i) => utterance(i * 10_000, i * 10_000 + 9_000, 'alpha beta gamma', 0.95)),
      { language_detection: true, language_confidence: 0.97, confidence: 0.95 }
    );
    const h = transcriptHealth(p);
    expect(h).toEqual({
      asrConfidence: 0.95,
      languageConfidence: 0.97,
      lowConfidenceShare: 0,
      foreignScriptShare: 0,
      mixedLanguageSuspected: false,
    });
  });

  test('a row-1134-shaped call (auto en at 0.28, low-confidence block, invented script) is suspected', () => {
    const english = Array.from({ length: 30 }, (_, i) =>
      utterance(i * 10_000, i * 10_000 + 9_000, 'alpha beta gamma', 0.93)
    );
    const garbled = Array.from({ length: 10 }, (_, i) =>
      utterance(300_000 + i * 10_000, 300_000 + i * 10_000 + 9_000, i < 4 ? 'xin được ạ' : 'saya tidak tahu', 0.55)
    );
    const h = transcriptHealth(
      payload([...english, ...garbled], { language_detection: true, language_confidence: 0.28, confidence: 0.82 })
    );
    expect(h.lowConfidenceShare).toBeCloseTo(10 / 40);
    expect(h.foreignScriptShare).toBeCloseTo(4 / 40);
    expect(h.mixedLanguageSuspected).toBe(true);
  });

  test('each trigger alone is enough', () => {
    const fine = (n: number) =>
      Array.from({ length: n }, (_, i) => utterance(i * 1000, i * 1000 + 900, 'alpha beta', 0.95));
    // low-confidence share ≥ 10% of speech time
    const low = transcriptHealth(payload([...fine(9), utterance(9000, 9900, 'zz zz', 0.5)]));
    expect(low.lowConfidenceShare).toBeCloseTo(0.1);
    expect(low.mixedLanguageSuspected).toBe(true);
    // foreign script on ≥ 3% of utterances of an en transcript
    const script = transcriptHealth(payload([...fine(32), utterance(40_000, 40_900, 'สวัสดี', 0.95)]));
    expect(script.mixedLanguageSuspected).toBe(true);
    // detection unsure
    const unsure = transcriptHealth(payload(fine(10), { language_detection: true, language_confidence: 0.4 }));
    expect(unsure.mixedLanguageSuspected).toBe(true);
    // …but a FORCED language has no detection confidence to be unsure about
    const forced = transcriptHealth(payload(fine(10), { language_confidence: 0.4 }));
    expect(forced.mixedLanguageSuspected).toBe(false);
  });

  test('a merged version is never flagged again (it IS the remedy), shares still reported', () => {
    const p = payload(
      [utterance(0, 9000, 'alpha beta', 0.95), utterance(9000, 18_000, 'saya tidak', 0.55)],
      { language_detection: true, language_confidence: 0.28 }
    );
    expect(transcriptHealth(p).mixedLanguageSuspected).toBe(true);
    const merged = transcriptHealth({ ...p, merge: { stats: {} } } as TranscriptResponse);
    expect(merged.mixedLanguageSuspected).toBe(false);
    expect(merged.lowConfidenceShare).toBeCloseTo(0.5);
  });

  test('foreign script only counts on an English transcript', () => {
    const p = payload([utterance(0, 900, '你好 世界', 0.95)], { language_code: 'zh' });
    expect(transcriptHealth(p).foreignScriptShare).toBe(0);
  });

  test('no utterances: zero shares, not NaN', () => {
    const h = transcriptHealth(payload([]));
    expect(h.lowConfidenceShare).toBe(0);
    expect(h.foreignScriptShare).toBe(0);
    expect(h.mixedLanguageSuspected).toBe(false);
  });
});

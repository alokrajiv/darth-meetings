/**
 * The automatic speaker-review decision, factored out of auto-review.ts
 * (2026-10-27) so the series path and the grace-window auto-proceed share
 * ONE rule. Thresholds are the ones auto-review.ts always had; the
 * enrolment gate (stricter) is new and only the grace path uses it.
 */
import { describe, expect, test } from 'bun:test';
import {
  ENROLL_ID_MIN,
  ENROLL_VOICE_MIN,
  ID_MIN,
  MIN_UTTERANCES,
  VOICE_MIN,
  evaluateAutoReview,
  isDiarizationLabel,
} from '../auto-review-eval';
import type { SpeakerLabel, SpeakerSuggestionMap } from '../format';

const REC = '11111111-1111-5111-8111-111111111111';
const label = (originalSpeaker: string, customName: string): SpeakerLabel => ({ originalSpeaker, customName, description: '' });
/** n utterances per speaker, in order. */
const utt = (...counts: Array<[string, number]>) =>
  counts.flatMap(([speaker, n]) => Array.from({ length: n }, () => ({ speaker })));
const voice = (name: string, confidence: number) => ({ name, confidence, source: 'voice' as const });
const idPass = (name: string, confidence: number) => ({ name, confidence, via: 'id' as const });

describe('thresholds — the values the series path always had', () => {
  test('named at 0.62 voice / 0.85 id; enrolled only at 0.80 voice / 0.90 id', () => {
    expect(VOICE_MIN).toBe(0.62);
    expect(ID_MIN).toBe(0.85);
    expect(MIN_UTTERANCES).toBe(2);
    expect(ENROLL_VOICE_MIN).toBe(0.8);
    expect(ENROLL_ID_MIN).toBe(0.9);
    expect(ENROLL_VOICE_MIN).toBeGreaterThan(VOICE_MIN);
    expect(ENROLL_ID_MIN).toBeGreaterThan(ID_MIN);
  });
});

describe('evaluateAutoReview', () => {
  test('all confident → passed, every name applied and merged', () => {
    const suggestions: SpeakerSuggestionMap = { A: voice('Test Person A', 0.87), B: voice('Test Person B', 0.9), C: idPass('Test Person C', 0.93) };
    const ev = evaluateAutoReview({ utterances: utt(['A', 5], ['B', 4], ['C', 3]), labels: [], suggestions });
    expect(ev.passed).toBe(true);
    expect(ev.blocker).toBeNull();
    expect(ev.applied.map((l) => `${l.originalSpeaker}=${l.customName}`)).toEqual(['A=Test Person A', 'B=Test Person B', 'C=Test Person C']);
    expect(ev.merged).toEqual(ev.applied);
  });

  test('one weak voice match (0.55) → blocked, with the reason, nothing applied', () => {
    const suggestions: SpeakerSuggestionMap = { A: voice('Test Person A', 0.87), B: voice('Test Person B', 0.55) };
    const ev = evaluateAutoReview({ utterances: utt(['A', 5], ['B', 4]), labels: [], suggestions });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toBe('"B" → Test Person B only at 55% (voice)');
    expect(ev.applied).toEqual([]);
    expect(ev.enroll).toEqual([]);
    expect(ev.merged).toEqual([]); // the saved labels, unchanged
  });

  test('a speaker with no suggestion at all blocks with its own sentence', () => {
    const ev = evaluateAutoReview({ utterances: utt(['A', 5], ['B', 4]), labels: [], suggestions: { A: voice('Test Person A', 0.9) } });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toBe('no confident identification for speaker "B"');
  });

  test('an id-pass guess below ID_MIN blocks and names the AI pass', () => {
    const ev = evaluateAutoReview({ utterances: utt(['A', 3]), labels: [], suggestions: { A: idPass('Test Person A', 0.8) } });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toBe('"A" → Test Person A only at 80% (AI pass)');
  });

  test('a one-utterance speaker is ignored — noise the reviewer skips too', () => {
    const ev = evaluateAutoReview({ utterances: utt(['A', 5], ['B', 1]), labels: [], suggestions: { A: voice('Test Person A', 0.9) } });
    expect(ev.passed).toBe(true);
    expect(ev.applied.map((l) => l.originalSpeaker)).toEqual(['A']);
  });

  test('a human-confirmed name is kept over a different suggestion and never overwritten', () => {
    const labels = [label('A', 'Confirmed Person A')];
    const ev = evaluateAutoReview({
      utterances: utt(['A', 5], ['B', 4]),
      labels,
      suggestions: { A: voice('Someone Else', 0.99), B: voice('Test Person B', 0.9) },
    });
    expect(ev.passed).toBe(true);
    expect(ev.applied.map((l) => l.originalSpeaker)).toEqual(['B']);
    expect(ev.merged.find((l) => l.originalSpeaker === 'A')?.customName).toBe('Confirmed Person A');
    // …and the confirmed name is NOT re-enrolled: the PUT that confirmed it
    // already enrolled this meeting. Only the strong applied one is.
    expect(ev.enroll.map((l) => l.originalSpeaker)).toEqual(['B']);
  });

  test('a blank saved label does not count as named', () => {
    const ev = evaluateAutoReview({ utterances: utt(['A', 3]), labels: [label('A', '  ')], suggestions: {} });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toContain('"A"');
  });

  test('everyone already named → passed with nothing to apply', () => {
    const labels = [label('A', 'Test Person A'), label('B', 'Test Person B')];
    const ev = evaluateAutoReview({ utterances: utt(['A', 3], ['B', 2]), labels, suggestions: {} });
    expect(ev).toEqual({ passed: true, blocker: null, applied: [], merged: labels, enroll: [] });
  });

  test('two speakers ending up with the same name block — the AI put one person on two voices', () => {
    const ev = evaluateAutoReview({
      utterances: utt(['A', 4], ['B', 3]),
      labels: [],
      suggestions: { A: voice('Test Person A', 0.9), B: idPass('test person a', 0.95) },
    });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toBe('two speakers both identified as Test Person A');
    expect(ev.applied).toEqual([]);
    expect(ev.enroll).toEqual([]);
  });

  test('a guess colliding with a human-confirmed name blocks too (case-insensitive)', () => {
    const labels = [label('A', 'Confirmed Person')];
    const ev = evaluateAutoReview({
      utterances: utt(['A', 4], ['B', 3]),
      labels,
      suggestions: { B: voice('confirmed person', 0.9) },
    });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toBe('two speakers both identified as Confirmed Person');
    expect(ev.merged).toEqual(labels); // nothing applied
  });

  test('two HUMAN-confirmed speakers sharing a name never block — diarization split one voice, a person said so', () => {
    const labels = [label('A', 'Test Person A'), label('B', 'test person a')];
    const ev = evaluateAutoReview({ utterances: utt(['A', 3], ['B', 3]), labels, suggestions: {} });
    expect(ev.passed).toBe(true);
    expect(ev.blocker).toBeNull();
    // …but a THIRD voice the AI would also call that name does block.
    const three = evaluateAutoReview({
      utterances: utt(['A', 3], ['B', 3], ['C', 3]),
      labels,
      suggestions: { C: voice('Test Person A', 0.95) },
    });
    expect(three.passed).toBe(false);
    expect(three.blocker).toBe('two speakers both identified as Test Person A');
  });

  test('a stale label for a speaker with no utterances in this meeting does not count as a duplicate', () => {
    const labels = [label('Z', 'Test Person A')];
    const ev = evaluateAutoReview({ utterances: utt(['A', 3]), labels, suggestions: { A: voice('Test Person A', 0.9) } });
    expect(ev.passed).toBe(true);
    expect(ev.applied.map((l) => l.originalSpeaker)).toEqual(['A']);
  });

  test('a label that is already a real name (transcript-mode imports) needs no resolution', () => {
    const ev = evaluateAutoReview({ utterances: utt(['Test Person A', 4], ['B', 3]), labels: [], suggestions: { B: voice('Test Person B', 0.7) } });
    expect(ev.passed).toBe(true);
    expect(ev.applied.map((l) => l.originalSpeaker)).toEqual(['B']);
  });

  test("combined-meeting labels `<recId>:A` are diarization labels — the prefix comes off first", () => {
    expect(isDiarizationLabel(`${REC}:A`)).toBe(true);
    expect(isDiarizationLabel(`${REC}:Speaker 2`)).toBe(true);
    expect(isDiarizationLabel(`${REC}:Test Person A`)).toBe(false);
    expect(isDiarizationLabel('A')).toBe(true);
    expect(isDiarizationLabel('Speaker 12')).toBe(true);
    expect(isDiarizationLabel('Test Person A')).toBe(false);
    // Without the rule every speaker would read as a real name and the pass
    // would "pass" having named nobody; with it the weak one blocks.
    const ev = evaluateAutoReview({
      utterances: utt([`${REC}:A`, 4], [`${REC}:B`, 3]),
      labels: [],
      suggestions: { [`${REC}:A`]: voice('Test Person A', 0.9), [`${REC}:B`]: voice('Test Person B', 0.5) },
    });
    expect(ev.passed).toBe(false);
    expect(ev.blocker).toContain(`"${REC}:B"`);
  });

  test('the first blocker (in utterance order) is the one reported', () => {
    const ev = evaluateAutoReview({ utterances: utt(['A', 2], ['B', 2]), labels: [], suggestions: {} });
    expect(ev.blocker).toBe('no confident identification for speaker "A"');
  });
});

describe('enrolment gating — a weak guess is named but never fed into a print', () => {
  test('0.70 voice → named, not enrolled; 0.85 voice → enrolled', () => {
    const ev = evaluateAutoReview({
      utterances: utt(['A', 3], ['B', 3]),
      labels: [],
      suggestions: { A: voice('Test Person A', 0.7), B: voice('Test Person B', 0.85) },
    });
    expect(ev.passed).toBe(true);
    expect(ev.merged.map((l) => l.originalSpeaker)).toEqual(['A', 'B']);
    expect(ev.enroll.map((l) => l.originalSpeaker)).toEqual(['B']);
  });

  test('id pass: 0.88 → named only; 0.92 → enrolled', () => {
    const ev = evaluateAutoReview({
      utterances: utt(['A', 3], ['B', 3]),
      labels: [],
      suggestions: { A: idPass('Test Person A', 0.88), B: idPass('Test Person B', 0.92) },
    });
    expect(ev.passed).toBe(true);
    expect(ev.enroll.map((l) => l.originalSpeaker)).toEqual(['B']);
  });

  test('enroll is a subset of applied — never a confirmed name, never a blank one', () => {
    const ev = evaluateAutoReview({
      utterances: utt(['A', 3], ['B', 3], ['C', 3]),
      labels: [label('C', 'Confirmed Person C'), label('Z', '')],
      suggestions: { A: voice('Test Person A', 0.65), B: idPass('Test Person B', 0.95) },
    });
    expect(ev.passed).toBe(true);
    for (const l of ev.enroll) expect(ev.applied).toContainEqual(l);
    expect(ev.enroll.map((l) => l.originalSpeaker)).toEqual(['B']);
  });
});

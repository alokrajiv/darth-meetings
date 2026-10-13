import { describe, expect, test } from 'bun:test';
import {
  contentUtterances,
  labelSpaceOf,
  mergeWarnings,
  orientMerge,
  parseMergeOptions,
  parseRunBody,
  parseRunMode,
  type MergeCandidate,
} from '@/lib/transcription-merge-plan';
import { submitLanguageFor } from '@/lib/aai-language';
import { planActivate, type TranscriptionFacts } from '@/lib/transcription-activate';
import { sameTranscriptionSettings } from '@/lib/transcriptions';

/**
 * The decisions around run modes and merged versions
 * (docs/transcription-merge-spec.md §3 + Amendment A). Pure; no fixtures
 * beyond invented ids.
 */

const cand = (id: string, languageCode: string | null, over: Partial<MergeCandidate> = {}): MergeCandidate => ({
  id,
  status: 'completed',
  languageCode,
  modelUsed: 'universal-3-5-pro',
  ...over,
});

describe('parseRunMode / parseMergeOptions / parseRunBody', () => {
  test('absent mode is replace; unknown mode is an error, never a silent replace', () => {
    expect(parseRunMode(undefined)).toEqual({ ok: true, mode: 'replace' });
    expect(parseRunMode('merge')).toEqual({ ok: true, mode: 'merge' });
    expect(parseRunMode('merged').ok).toBe(false);
  });

  test('merge options are bounded and named when wrong', () => {
    expect(parseMergeOptions(undefined)).toEqual({ ok: true, options: {} });
    expect(parseMergeOptions({ utteranceThreshold: 0.8, window: 4 })).toEqual({
      ok: true,
      options: { utteranceThreshold: 0.8, window: 4 },
    });
    const bad = parseMergeOptions({ wordThreshold: 7.5 });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain('wordThreshold');
    expect(parseMergeOptions({ window: 2.5 }).ok).toBe(false);
    expect(parseMergeOptions({ nope: 1 }).ok).toBe(false);
  });

  test('a run body: lenient on model/language as before, strict on mode', () => {
    const ok = parseRunBody({ languageCode: 'auto-en', mode: 'merge', mergeOptions: { minRun: 4 } });
    expect(ok.ok && ok.body).toEqual({
      speechModel: undefined,
      languageCode: 'auto-en',
      reason: undefined,
      force: false,
      mode: 'merge',
      mergeOptions: { minRun: 4 },
    });
    const junkLang = parseRunBody({ languageCode: 'indonesian please' });
    expect(junkLang.ok && junkLang.body.languageCode).toBeUndefined();
    expect(parseRunBody(null).ok).toBe(true);
    expect(parseRunBody({ mode: 'MERGE' }).ok).toBe(false);
  });
});

describe('submitLanguageFor (Amendment A §1)', () => {
  test("'auto-en' is detection expecting English, pinned to 3.5 Pro", () => {
    expect(submitLanguageFor('auto-en', 'universal')).toEqual({
      languageCode: undefined,
      expectedLanguages: ['en'],
      model: 'universal-3-5-pro',
    });
  });
  test("'auto' detects, a code forces, the model is the caller's", () => {
    expect(submitLanguageFor('auto', 'universal')).toEqual({ languageCode: undefined, model: 'universal' });
    expect(submitLanguageFor('id', 'universal-3-5-pro')).toEqual({
      languageCode: 'id',
      model: 'universal-3-5-pro',
    });
  });
});

describe('orientMerge — base is the English one, whichever was active (Amendment A §2)', () => {
  test('active English + forced id run → base = active', () => {
    expect(orientMerge(cand('act', 'en'), cand('run', 'id'))).toEqual({ kind: 'merge', base: 'act', fill: 'run' });
  });
  test('active Indonesian + auto-en run → base = the run', () => {
    expect(orientMerge(cand('act', 'id'), cand('run', 'en_us'))).toEqual({
      kind: 'merge',
      base: 'run',
      fill: 'act',
    });
  });
  test('both English / neither English → helper with a reason', () => {
    const both = orientMerge(cand('act', 'en'), cand('run', 'en'));
    expect(both.kind).toBe('helper');
    const neither = orientMerge(cand('act', 'id'), cand('run', 'zh'));
    expect(neither.kind).toBe('helper');
    expect(neither.kind === 'helper' && neither.why).toContain('auto-en');
  });
  test('a missing or unfinished counterpart → helper (never the raw fill)', () => {
    expect(orientMerge(null, cand('run', 'id')).kind).toBe('helper');
    expect(orientMerge(cand('act', 'en', { status: 'error' }), cand('run', 'id')).kind).toBe('helper');
    expect(orientMerge(cand('run', 'en'), cand('run', 'id')).kind).toBe('helper');
  });
});

describe('mergeWarnings (Amendment A §3)', () => {
  test('the right way round is silent', () => {
    expect(mergeWarnings(cand('b', 'en'), cand('f', 'id'))).toEqual([]);
  });
  test('the wrong way round says so', () => {
    expect(mergeWarnings(cand('b', 'id'), cand('f', 'en'))).toEqual([
      'base is not an English version',
      'fill is English',
    ]);
    expect(mergeWarnings(cand('b', 'en', { modelUsed: 'universal-2' }), cand('f', 'id'))).toEqual([
      'base ran on universal-2, not universal-3-5-pro',
    ]);
  });
});

describe('labelSpaceOf', () => {
  const bases: Record<string, string | null> = { m1: 'base', m2: 'm1', base: null, other: null, loop: 'loop' };
  const of = (id: string) => bases[id] ?? null;
  test('a merge (of a merge) shares its base’s labels', () => {
    expect(labelSpaceOf('m1', of)).toBe('base');
    expect(labelSpaceOf('m2', of)).toBe('base');
    expect(labelSpaceOf('base', of)).toBe('base');
    expect(labelSpaceOf('other', of)).toBe('other');
  });
  test('a self-loop terminates', () => {
    expect(labelSpaceOf('loop', of)).toBe('loop');
  });
});

describe('contentUtterances', () => {
  const p = {
    utterances: [
      { start: 0, end: 10, speaker: 'A', text: 'one' },
      { start: 10, end: 20, speaker: 'B', text: 'two', merged: true },
    ],
  };
  test('labels without names; merged flag carried', () => {
    expect(contentUtterances(p, null)).toEqual([
      { start: 0, end: 10, speaker: 'A', text: 'one' },
      { start: 10, end: 20, speaker: 'B', text: 'two', merged: true },
    ]);
  });
  test('confirmed names replace labels; an empty name does not', () => {
    const names = new Map([
      ['A', 'Person One'],
      ['B', '  '],
    ]);
    expect(contentUtterances(p, names).map((u) => u.speaker)).toEqual(['Person One', 'B']);
  });
});

describe('merged versions in the existing planners', () => {
  const facts = (over: Partial<TranscriptionFacts>): TranscriptionFacts => ({
    id: 'x',
    status: 'completed',
    createdAt: '2026-10-01T00:00:00.000Z',
    providerJobId: null,
    speechModel: 'universal-3-5-pro',
    languageCode: 'en',
    completedAt: null,
    durationSec: 60,
    speakerCount: 2,
    activatedBefore: false,
    ...over,
  });

  test('activating a merged version is never brand new (no speaker re-run, same labels)', () => {
    const plan = planActivate({
      transcriptId: 1,
      current: facts({ id: 'base', providerJobId: 'job-1' }),
      target: facts({ id: 'merged', createdAt: '2026-10-13T00:00:00.000Z', derived: true }),
      live: [],
      archived: [],
      hasNotes: false,
      hasReport: false,
      now: '2026-10-13T00:00:00.000Z',
    });
    expect(plan.ok && plan.brandNew).toBe(false);
    // An ordinary newer version still is.
    const ordinary = planActivate({
      transcriptId: 1,
      current: facts({ id: 'base' }),
      target: facts({ id: 'run', createdAt: '2026-10-13T00:00:00.000Z' }),
      live: [],
      archived: [],
      hasNotes: false,
      hasReport: false,
      now: '2026-10-13T00:00:00.000Z',
    });
    expect(ordinary.ok && ordinary.brandNew).toBe(true);
  });

  test('sameTranscriptionSettings: a merged active version never matches; auto-en is not auto', () => {
    const v = {
      speechModel: 'universal-3-5-pro',
      speechModelRequested: 'universal-3-5-pro',
      languageCode: 'en',
      languageDetected: true,
    };
    const ask = { speechModel: 'universal-3-5-pro', languageCode: 'auto' };
    expect(sameTranscriptionSettings(v, ask)).toBe(true);
    expect(sameTranscriptionSettings({ ...v, provider: 'merge' }, ask)).toBe(false);
    expect(sameTranscriptionSettings({ ...v, languageRequested: 'auto-en' }, ask)).toBe(false);
    expect(
      sameTranscriptionSettings({ ...v, languageRequested: 'auto-en' }, { ...ask, languageCode: 'auto-en' })
    ).toBe(true);
    expect(sameTranscriptionSettings(v, { ...ask, languageCode: 'auto-en' })).toBe(false);
  });
});

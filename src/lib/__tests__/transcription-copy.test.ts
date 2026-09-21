import { describe, expect, test } from 'bun:test';
import {
  askedBy,
  languageChoices,
  runningLine,
  setAsideSentence,
  versionCopy,
  versionsWorthShowing,
  whenStamp,
} from '../transcription-copy';
import type { RunningTranscription, TranscriptionVersion } from '../transcriptions';

// The Hypercare meeting (591b102e…) as Phase 2 sees it: AAI heard Indonesian
// on Universal-2 after being asked for 3.5 Pro; Atira re-ran it as English.
// Instants are written WITHOUT a zone so they parse as local time — the
// copy formats in local time, so the tests never depend on the machine's.
const version = (over: Partial<TranscriptionVersion> = {}): TranscriptionVersion => ({
  id: 't1',
  active: true,
  status: 'completed',
  provider: 'assemblyai',
  speechModel: 'universal-3-5-pro',
  speechModelRequested: 'universal-3-5-pro',
  languageCode: 'en',
  languageDetected: false,
  languageConfidence: null,
  speakerCount: 6,
  createdAt: '2026-09-21T16:30:00',
  completedAt: '2026-09-21T16:41:00',
  requestedBy: { email: 'atira.sarat@trames.sg', name: 'atira' },
  reason: null,
  editsSetAside: 0,
  speakerNamesSetAside: 0,
  error: null,
  ...over,
});

describe('runningLine — the calm line while a re-run is in flight', () => {
  const base: RunningTranscription = {
    transcriptionId: 't2',
    startedAt: '2026-09-22T14:02:00',
    by: { email: 'atira.sarat@trames.sg', name: 'atira' },
    speechModel: 'universal-3-5-pro',
    languageCode: 'en',
  };

  test('names the model, the language asked for, a 24-hour start, and says you can keep reading', () => {
    expect(runningLine(base)).toBe(
      'Transcribing again — Universal-3.5 Pro, English · started 14:02 · you can keep reading'
    );
  });

  test("'auto' is said as detection, not as a language code", () => {
    expect(runningLine({ ...base, languageCode: 'auto' })).toBe(
      'Transcribing again — Universal-3.5 Pro, language auto-detected · started 14:02 · you can keep reading'
    );
  });

  test('an unusable timestamp drops the clock instead of printing NaN', () => {
    expect(runningLine({ ...base, startedAt: 'not a time' })).toBe(
      'Transcribing again — Universal-3.5 Pro, English · you can keep reading'
    );
  });
});

describe('versionCopy — one line per version', () => {
  test('a plain completed version', () => {
    const c = versionCopy(version());
    expect(c.model).toBe('Universal-3.5 Pro');
    expect(c.language).toBe('English (chosen)');
    expect(c.when).toBe('Mon 21 Sep 2026 · 16:41');
    expect(c.who).toBe('Atira');
    expect(c.setAside).toBeNull();
    expect(c.error).toBeNull();
  });

  test('a fallback says what ran AND what was asked for', () => {
    const c = versionCopy(
      version({ speechModel: 'universal-2', speechModelRequested: 'universal-3-5-pro' })
    );
    expect(c.model).toBe('Universal-2 — asked for Universal-3.5 Pro');
  });

  test("our submit id 'universal' IS Universal-2 — never read as a fallback", () => {
    const c = versionCopy(
      version({ speechModel: 'universal-2', speechModelRequested: 'universal' })
    );
    expect(c.model).toBe('Universal-2');
  });

  test('a detected language is marked (auto), a forced one (chosen)', () => {
    expect(versionCopy(version({ languageCode: 'id', languageDetected: true })).language).toBe(
      'Indonesian (auto)'
    );
    expect(versionCopy(version({ languageCode: 'id', languageDetected: false })).language).toBe(
      'Indonesian (chosen)'
    );
  });

  test('parked edits and names read as English, singulars included', () => {
    expect(versionCopy(version({ editsSetAside: 12, speakerNamesSetAside: 3 })).setAside).toBe(
      '12 edits · 3 names set aside'
    );
    expect(versionCopy(version({ editsSetAside: 1 })).setAside).toBe('1 edit set aside');
    expect(versionCopy(version({ speakerNamesSetAside: 1 })).setAside).toBe('1 name set aside');
  });

  test('the reader sees their own run as "You"', () => {
    expect(versionCopy(version(), 'ATIRA.SARAT@trames.sg').who).toBe('You');
  });

  test('a failed version always carries a reason, even when the server sent none', () => {
    expect(versionCopy(version({ status: 'error', error: '  ' })).error).toBe(
      'It did not finish — no reason was recorded.'
    );
    expect(versionCopy(version({ status: 'error', error: 'AssemblyAI rejected the file' })).error).toBe(
      'AssemblyAI rejected the file'
    );
  });

  test('a version still running names what it was asked for and has no clock yet', () => {
    const c = versionCopy(
      version({
        status: 'processing',
        active: false,
        speechModel: null,
        speechModelRequested: 'universal-3-5-pro',
        languageCode: null,
        completedAt: null,
      })
    );
    expect(c.model).toBe('Universal-3.5 Pro');
    expect(c.language).toBeNull();
    expect(c.when).toBe('Mon 21 Sep 2026 · 16:30'); // createdAt
  });

  test('a version with nothing recorded says so instead of inventing a model', () => {
    expect(
      versionCopy(version({ speechModel: null, speechModelRequested: null })).model
    ).toBe('Model not recorded');
  });
});

describe('versionsWorthShowing — the disclosure is not a permanent fixture', () => {
  test('one healthy version is just "how this meeting was made"', () => {
    expect(versionsWorthShowing([version()])).toBe(false);
  });
  test('two versions, or a failed one, are worth a list', () => {
    expect(versionsWorthShowing([version(), version({ id: 't2', active: false })])).toBe(true);
    expect(versionsWorthShowing([version({ status: 'error' })])).toBe(true);
  });
});

describe('setAsideSentence — what happened to my edits and names', () => {
  test('both directions', () => {
    expect(
      setAsideSentence({
        ok: true,
        activeId: 't1',
        setAside: { edits: 12, speakerNames: 3 },
        restored: { edits: 4, speakerNames: 0 },
      })
    ).toBe(
      'Now reading this version. 4 edits came back; 12 edits and 3 speaker names stay with the version you left.'
    );
  });

  test('only parked', () => {
    expect(
      setAsideSentence({
        ok: true,
        activeId: 't1',
        setAside: { edits: 1, speakerNames: 0 },
        restored: { edits: 0, speakerNames: 0 },
      })
    ).toBe('Now reading this version. 1 edit stays with the version you left — switch back any time.');
  });

  test('only restored', () => {
    expect(
      setAsideSentence({
        ok: true,
        activeId: 't1',
        setAside: { edits: 0, speakerNames: 0 },
        restored: { edits: 0, speakerNames: 2 },
      })
    ).toBe('Now reading this version. 2 speaker names came back with it.');
  });

  test('a meeting nobody has edited says nothing alarming', () => {
    expect(
      setAsideSentence({
        ok: true,
        activeId: 't1',
        setAside: { edits: 0, speakerNames: 0 },
        restored: { edits: 0, speakerNames: 0 },
      })
    ).toBe('Now reading this version. No edits or speaker names were affected.');
  });
});

describe('languageChoices — the dialog field', () => {
  test('auto-detect is first and is what we send as "auto"', () => {
    const [first] = languageChoices(null);
    expect(first).toEqual({ value: 'auto', label: 'Auto-detect' });
  });

  test("the meeting's language is marked, en_us matching English", () => {
    const marked = languageChoices('en_us').filter((c) => c.label.includes('the current language'));
    expect(marked).toEqual([{ value: 'en', label: 'English — the current language' }]);
  });

  test('a language we do not list is still offerable', () => {
    const choices = languageChoices('pt');
    expect(choices[1]).toEqual({ value: 'pt', label: 'Portuguese — the current language' });
  });

  test('every option is a code we can actually send', () => {
    for (const c of languageChoices('id')) expect(c.value.length).toBeGreaterThan(0);
  });
});

describe('askedBy / whenStamp', () => {
  test('a person with no identity at all is simply not named', () => {
    expect(askedBy({ email: null, name: null })).toBeNull();
    expect(askedBy(null)).toBeNull();
  });
  test('24-hour stamps, junk in → null out', () => {
    expect(whenStamp('2026-09-21T16:41:00')).toBe('Mon 21 Sep 2026 · 16:41');
    expect(whenStamp(null)).toBeNull();
    expect(whenStamp('nope')).toBeNull();
  });
});

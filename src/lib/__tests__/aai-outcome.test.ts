import { describe, expect, test } from 'bun:test';
import type { TranscriptResponse } from '@/lib/format';
import {
  aaiOutcome,
  aaiOutcomeNote,
  aaiOutcomeSentence,
  languageLabel,
  pctLabel,
  type AaiOutcomeSource,
} from '@/lib/aai-outcome';

/**
 * Fixtures are the real prod payloads from
 * docs/eval-aai-code-switching-2026-09-21.md — row 920 (the complaint: an
 * English/Indonesian call silently downgraded to Universal-2 and written
 * entirely in Indonesian) and its English sibling.
 */

const englishRow: AaiOutcomeSource = {
  assemblyai_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  speech_model: 'universal-3-5-pro',
  language_code: 'en',
  imported_content: {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    status: 'completed',
    created: '2026-09-21T00:00:00Z',
    language_code: 'en',
    language_detection: true,
    language_confidence: 0.9812,
    confidence: 0.9431,
    speech_model: null,
    speech_models: ['universal-3-5-pro'],
    speech_model_used: 'universal-3-5-pro',
    keyterms_prompt: ['Ivan Seow', 'Ka Wen Koh'],
    metadata: null,
  } as TranscriptResponse,
};

/** Row 920, verbatim from prod (values quoted in the eval doc §1). */
const indonesianFallbackRow: AaiOutcomeSource = {
  assemblyai_id: '591b102e-2831-4eb3-aece-8172edde0133',
  speech_model: 'universal-3-5-pro',
  language_code: 'id',
  imported_content: {
    id: '591b102e-2831-4eb3-aece-8172edde0133',
    status: 'completed',
    created: '2026-09-21T00:00:00Z',
    language_code: 'id',
    language_detection: true,
    language_confidence: 0.9273,
    confidence: 0.616483,
    speech_model: null,
    speech_models: ['universal-3-5-pro'],
    speech_model_used: 'universal-2',
    keyterms_prompt: Array.from({ length: 36 }, (_, i) => `Attendee ${i}`),
    metadata: {
      warnings: [
        {
          message:
            '`keyterms_prompt` was not applied because it is only supported for the following languages when using the universal-2 speech_model: en, en_au, en_uk, en_us.',
        },
        {
          message:
            "'id' is not supported in universal-3-5-pro — transcription is handled by universal-2. To silence this warning, set speech_models: [\"universal-3-5-pro\", \"universal-2\"].",
        },
      ],
    },
  } as TranscriptResponse,
};

describe('aaiOutcome — the normal English row', () => {
  const o = aaiOutcome(englishRow);

  test('what we asked for is what ran', () => {
    expect(o.requested).toBe('universal-3-5-pro');
    expect(o.used).toBe('universal-3-5-pro');
    expect(o.downgraded).toBe(false);
  });

  test('nothing is worth flagging', () => {
    expect(o.reasons).toEqual([]);
    expect(o.noteworthy).toBe(false);
    expect(o.keytermsDropped).toBe(false);
    expect(aaiOutcomeNote(o)).toBeNull();
  });

  test('the plain sentence names the language and the model', () => {
    expect(aaiOutcomeSentence(o)).toBe(
      'Transcribed in English (auto-detected) by AssemblyAI Universal-3.5 Pro.'
    );
  });
});

describe('aaiOutcome — row 920, the Indonesian fallback', () => {
  const o = aaiOutcome(indonesianFallbackRow);

  test('the downgrade is visible', () => {
    expect(o.requested).toBe('universal-3-5-pro');
    expect(o.used).toBe('universal-2');
    expect(o.downgraded).toBe(true);
  });

  test('language, confidences and job id come off the payload', () => {
    expect(o.languageCode).toBe('id');
    expect(o.languageDetected).toBe(true);
    expect(o.languageConfidence).toBeCloseTo(0.9273, 4);
    expect(o.asrConfidence).toBeCloseTo(0.616483, 6);
    expect(o.jobId).toBe('591b102e-2831-4eb3-aece-8172edde0133');
  });

  test('AAI warnings are kept verbatim', () => {
    expect(o.warnings).toHaveLength(2);
    expect(o.warnings[0]).toContain('`keyterms_prompt` was not applied');
    expect(o.warnings[1]).toContain("'id' is not supported in universal-3-5-pro");
  });

  test('the 36 attendee names were sent and ignored', () => {
    expect(o.keytermsSent).toBe(36);
    expect(o.keytermsDropped).toBe(true);
  });

  test('every reason fires, downgrade first', () => {
    expect(o.reasons).toEqual([
      'downgraded',
      'non-english',
      'low-confidence',
      'keyterms-dropped',
      'warnings',
    ]);
    expect(o.noteworthy).toBe(true);
  });

  test('the plain sentence names the model that actually ran, and why', () => {
    expect(aaiOutcomeSentence(o)).toBe(
      'Transcribed in Indonesian (auto-detected) by AssemblyAI Universal-2 — ' +
        'Universal-3.5 Pro was asked for but does not support Indonesian yet, so AssemblyAI fell back.'
    );
  });

  test('the amber note warns about translated English, not about the model', () => {
    const note = aaiOutcomeNote(o)!;
    expect(note).toContain('English stretches may read as translations');
    expect(note).toContain('Advanced details');
  });
});

describe('aaiOutcome — old rows and rows that never ran AssemblyAI', () => {
  test('a pre-speech_model row that ran universal-2 is not a downgrade', () => {
    const o = aaiOutcome({
      assemblyai_id: 'legacy',
      speech_model: null,
      language_code: 'en_us',
      imported_content: {
        id: 'legacy',
        status: 'completed',
        created: '2026-05-01T00:00:00Z',
        language_code: 'en_us',
        confidence: 0.94,
        speech_model: 'universal',
        speech_model_used: 'universal-2',
      } as TranscriptResponse,
    });
    // 'universal' is how we spell Universal-2 on submit — comparing the raw
    // strings would flag all 285 pre-2026-09 rows as downgrades.
    expect(o.requested).toBe('universal-2');
    expect(o.used).toBe('universal-2');
    expect(o.downgraded).toBe(false);
    expect(o.noteworthy).toBe(false);
    expect(aaiOutcomeSentence(o)).toBe(
      'Transcribed in English by AssemblyAI Universal-2 (older model).'
    );
  });

  test("AAI's \"use a newer model\" nudge is listed but does not alarm the reader", () => {
    // ~300 healthy English rows carry exactly this warning. It is addressed
    // to us, not to whoever is reading the meeting.
    const o = aaiOutcome({
      assemblyai_id: 'nudged',
      speech_model: null,
      language_code: 'en_us',
      imported_content: {
        id: 'nudged',
        status: 'completed',
        created: '2026-05-01T00:00:00Z',
        language_code: 'en_us',
        confidence: 0.95,
        speech_model: 'universal',
        speech_model_used: 'universal-2',
        metadata: {
          warnings: [
            {
              message:
                'For highest accuracy and broadest language coverage: set "speech_models" to ["universal-3-5-pro", "universal-2"].',
            },
          ],
        },
      } as TranscriptResponse,
    });
    expect(o.warnings).toHaveLength(1); // still shown under Advanced details
    expect(o.reasons).toEqual([]);
    expect(aaiOutcomeNote(o)).toBeNull();
  });

  test('a payload with none of the outcome fields says nothing and does not crash', () => {
    const o = aaiOutcome({
      assemblyai_id: 'gmeet-abc',
      speech_model: null,
      language_code: null,
      imported_content: {
        id: 'gmeet-abc',
        status: 'completed',
        created: '2026-05-01T00:00:00Z',
      } as TranscriptResponse,
    });
    expect(o.requested).toBeNull();
    expect(o.used).toBeNull();
    expect(o.downgraded).toBe(false);
    expect(o.languageConfidence).toBeNull();
    expect(o.asrConfidence).toBeNull();
    expect(o.warnings).toEqual([]);
    expect(o.keytermsSent).toBe(0);
    expect(o.reasons).toEqual([]);
    expect(aaiOutcomeSentence(o)).toBeNull();
    expect(aaiOutcomeNote(o)).toBeNull();
  });

  test('no imported_content at all (job still running)', () => {
    const o = aaiOutcome({ assemblyai_id: 'x', speech_model: 'universal-3-5-pro' });
    expect(o.requested).toBe('universal-3-5-pro');
    expect(o.used).toBeNull();
    expect(o.downgraded).toBe(false);
    expect(o.noteworthy).toBe(false);
    expect(aaiOutcomeSentence(o)).toBe('Transcribed by AssemblyAI Universal-3.5 Pro.');
  });

  test('an empty object row is tolerated', () => {
    expect(() => aaiOutcome({})).not.toThrow();
    expect(aaiOutcome({}).jobId).toBeNull();
  });
});

describe('the low-confidence threshold', () => {
  const at = (confidence: number): AaiOutcomeSource => ({
    assemblyai_id: 'c',
    speech_model: 'universal-3-5-pro',
    language_code: 'en',
    imported_content: {
      id: 'c',
      status: 'completed',
      created: '2026-09-21T00:00:00Z',
      language_code: 'en',
      confidence,
      speech_models: ['universal-3-5-pro'],
      speech_model_used: 'universal-3-5-pro',
    } as TranscriptResponse,
  });

  test('0.8 is fine, just under it is not', () => {
    expect(aaiOutcome(at(0.8)).reasons).toEqual([]);
    expect(aaiOutcome(at(0.7999)).reasons).toEqual(['low-confidence']);
  });

  test('exactly 0 means an empty transcript, not a bad one — this card stays quiet', () => {
    // Row 919 in the eval: a 2-minute dead segment, confidence 0.
    expect(aaiOutcome(at(0)).reasons).toEqual([]);
    expect(aaiOutcome(at(0)).noteworthy).toBe(false);
  });

  test('the note quotes the percentage', () => {
    expect(aaiOutcomeNote(aaiOutcome(at(0.62)))).toContain('62%');
  });
});

describe('small formatters', () => {
  test('percentages round', () => {
    expect(pctLabel(0.616483)).toBe('62%');
    expect(pctLabel(null)).toBeNull();
  });

  test('language codes get names, unknown ones fall back to the code', () => {
    expect(languageLabel('id')).toBe('Indonesian');
    expect(languageLabel('en_us')).toBe('English');
    expect(languageLabel('zh')).toBe('Mandarin');
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel('qqq')).toBe('qqq');
  });
});

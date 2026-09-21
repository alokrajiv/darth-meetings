import { describe, expect, test } from 'bun:test';
import {
  planActivate,
  type ActivateInput,
  type AnnotationSet,
  type TranscriptionFacts,
} from '@/lib/transcription-activate';
import { sameTranscriptionSettings, type TranscriptionVersion } from '@/lib/transcriptions';

/**
 * The activate planner (Phase 2) — what a version switch archives, restores
 * and writes. Every case here is one the scratch-DB scenario then drives for
 * real; these pin the BOOKKEEPING so a regression names itself.
 */

const NOW = '2026-09-22T10:00:00.000Z';

function txn(over: Partial<TranscriptionFacts> = {}): TranscriptionFacts {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'completed',
    createdAt: '2026-09-01T00:00:00.000Z',
    providerJobId: 'job-1',
    speechModel: 'universal',
    languageCode: 'id',
    completedAt: '2026-09-01T00:05:00.000Z',
    durationSec: 3405,
    speakerCount: 4,
    activatedBefore: false,
    ...over,
  };
}

const NEWER = txn({
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  createdAt: '2026-09-22T09:00:00.000Z',
  providerJobId: 'job-2',
  speechModel: 'universal-3-5-pro',
  languageCode: 'en',
  completedAt: '2026-09-22T09:20:00.000Z',
  durationSec: 3405,
  speakerCount: 5,
});

function annotations(userId: string, edits: number, names: number): AnnotationSet {
  return {
    userId,
    edits: Object.fromEntries(
      Array.from({ length: edits }, (_, i) => [String(i), { text: `edited ${i}` }])
    ),
    speakers: {
      labels: Array.from({ length: names }, (_, i) => ({
        originalSpeaker: String.fromCharCode(65 + i),
        customName: `Person ${i}`,
        description: '',
      })),
      suggestions: null,
    },
  };
}

function input(over: Partial<ActivateInput> = {}): ActivateInput {
  return {
    transcriptId: 920,
    current: txn(),
    target: NEWER,
    live: [],
    archived: [],
    hasNotes: false,
    hasReport: false,
    now: NOW,
    ...over,
  };
}

describe('planActivate — refusals', () => {
  test('the version already being shown', () => {
    const d = planActivate(input({ target: txn() }));
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.alreadyActive).toBe(true);
  });

  test('a run that has not finished', () => {
    const d = planActivate(input({ target: txn({ id: 'x', status: 'processing' }) }));
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.error).toMatch(/still being transcribed/i);
  });

  test('a run that failed', () => {
    const d = planActivate(input({ target: txn({ id: 'x', status: 'error' }) }));
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.error).toMatch(/failed/i);
  });
});

describe('planActivate — the new run lands', () => {
  test('annotations are parked under the version being LEFT, not the new one', () => {
    const d = planActivate(input({ live: [annotations('u1', 12, 3)] }));
    if (!d.ok) throw new Error(d.error);
    expect(d.archive.transcriptionId).toBe(txn().id);
    expect(d.archive.sets.map((s) => s.userId)).toEqual(['u1']);
    expect(d.setAside).toEqual({ edits: 12, speakerNames: 3 });
    // Nothing comes back for a version nobody has annotated…
    expect(d.restore).toEqual([]);
    expect(d.restored).toEqual({ edits: 0, speakerNames: 0 });
    // …so the live rows must GO. Index-keyed edits against another version's
    // utterances would rewrite the wrong lines (design §4 landmine 2).
    expect(d.clearUsers).toEqual(['u1']);
  });

  test('every user is parked, not just the owner', () => {
    const d = planActivate(
      input({ live: [annotations('owner', 2, 1), annotations('collaborator', 5, 0)] })
    );
    if (!d.ok) throw new Error(d.error);
    expect(d.archive.sets.map((s) => s.userId).sort()).toEqual(['collaborator', 'owner']);
    expect(d.setAside).toEqual({ edits: 7, speakerNames: 1 });
    expect(d.clearUsers.sort()).toEqual(['collaborator', 'owner']);
  });

  test('the row takes the new version’s job, model, language, duration and speakers', () => {
    const d = planActivate(input());
    if (!d.ok) throw new Error(d.error);
    expect(d.row).toEqual({
      payloadFromTranscriptionId: NEWER.id,
      aaiJobId: 'job-2',
      speechModel: 'universal-3-5-pro',
      languageCode: 'en',
      durationSec: 3405,
      speakerCount: 5,
      completedAt: '2026-09-22T09:20:00.000Z',
    });
    expect(d.activeTranscriptionId).toBe(NEWER.id);
  });

  test('the older version is marked superseded and the new one is brand new', () => {
    const d = planActivate(input());
    if (!d.ok) throw new Error(d.error);
    expect(d.supersede).toEqual({ transcriptionId: txn().id, by: NEWER.id });
    expect(d.brandNew).toBe(true);
  });

  test('notes go stale only when there are notes', () => {
    const none = planActivate(input());
    if (!none.ok) throw new Error(none.error);
    expect(none.notesStale).toBeNull();

    const withNotes = planActivate(input({ hasNotes: true }));
    if (!withNotes.ok) throw new Error(withNotes.error);
    expect(withNotes.notesStale).toEqual({ since: NOW, fromTranscriptionId: txn().id });

    const withReport = planActivate(input({ hasReport: true }));
    if (!withReport.ok) throw new Error(withReport.error);
    expect(withReport.notesStale?.fromTranscriptionId).toBe(txn().id);
  });

  test('an empty annotation set is not parked at all', () => {
    const d = planActivate(
      input({ live: [{ userId: 'u1', edits: {}, speakers: { labels: [], suggestions: null } }] })
    );
    if (!d.ok) throw new Error(d.error);
    expect(d.archive.sets).toEqual([]);
    expect(d.clearUsers).toEqual([]);
  });

  test('a speaker row with no name typed in does not count as a name set aside', () => {
    const d = planActivate(
      input({
        live: [
          {
            userId: 'u1',
            edits: null,
            speakers: {
              labels: [
                { originalSpeaker: 'A', customName: '  ', description: '' },
                { originalSpeaker: 'B', customName: 'Atira', description: '' },
              ],
              suggestions: null,
            },
          },
        ],
      })
    );
    if (!d.ok) throw new Error(d.error);
    expect(d.setAside).toEqual({ edits: 0, speakerNames: 1 });
  });
});

describe('planActivate — switching back', () => {
  const backwards = () =>
    input({
      current: NEWER,
      target: txn({ activatedBefore: true }),
      live: [annotations('u1', 2, 1)],
      archived: [annotations('u1', 12, 3)],
    });

  test('the old version’s edits and names come back, the new one’s are parked', () => {
    const d = planActivate(backwards());
    if (!d.ok) throw new Error(d.error);
    expect(d.archive.transcriptionId).toBe(NEWER.id);
    expect(d.setAside).toEqual({ edits: 2, speakerNames: 1 });
    expect(d.restore.map((s) => s.userId)).toEqual(['u1']);
    expect(d.restored).toEqual({ edits: 12, speakerNames: 3 });
    // The user is on both sides, so the restore overwrites — no delete.
    expect(d.clearUsers).toEqual([]);
  });

  test('an older version never supersedes the newer one it replaces', () => {
    const d = planActivate(backwards());
    if (!d.ok) throw new Error(d.error);
    expect(d.supersede).toBeNull();
  });

  test('switching back is never brand new — the speaker passes do not re-run', () => {
    const d = planActivate(backwards());
    if (!d.ok) throw new Error(d.error);
    expect(d.brandNew).toBe(false);
  });

  test('switching FORWARD a second time is not brand new either', () => {
    const d = planActivate(
      input({
        current: txn({ activatedBefore: true }),
        target: { ...NEWER, activatedBefore: true },
      })
    );
    if (!d.ok) throw new Error(d.error);
    expect(d.brandNew).toBe(false);
    // …but it still supersedes, and the row still takes its payload.
    expect(d.supersede).toEqual({ transcriptionId: txn().id, by: NEWER.id });
  });

  test('a user who annotated only the version being left loses their rows', () => {
    const d = planActivate(
      input({
        current: NEWER,
        target: txn({ activatedBefore: true }),
        live: [annotations('u1', 2, 0), annotations('u2', 4, 0)],
        archived: [annotations('u1', 9, 0)],
      })
    );
    if (!d.ok) throw new Error(d.error);
    expect(d.clearUsers).toEqual(['u2']);
    expect(d.restore.map((s) => s.userId)).toEqual(['u1']);
  });
});

describe('planActivate — a meeting with no active pointer yet', () => {
  test('nothing is archived, nothing is superseded, notes stay fresh', () => {
    const d = planActivate(input({ current: null, live: [annotations('u1', 3, 1)], hasNotes: true }));
    if (!d.ok) throw new Error(d.error);
    expect(d.archive.sets).toEqual([]);
    expect(d.setAside).toEqual({ edits: 0, speakerNames: 0 });
    expect(d.supersede).toBeNull();
    expect(d.notesStale).toBeNull();
    // Still brand new: `createdAt` beats "no current" (epoch 0).
    expect(d.brandNew).toBe(true);
  });
});

describe('sameTranscriptionSettings — what the 409 confirm is built on', () => {
  const version = (over: Partial<TranscriptionVersion> = {}): TranscriptionVersion => ({
    id: 'v',
    active: true,
    status: 'completed',
    provider: 'assemblyai',
    speechModel: 'universal-2',
    speechModelRequested: 'universal-3-5-pro',
    languageCode: 'id',
    languageDetected: true,
    languageConfidence: 0.93,
    speakerCount: 4,
    createdAt: NOW,
    completedAt: NOW,
    requestedBy: null,
    reason: null,
    editsSetAside: 0,
    speakerNamesSetAside: 0,
    error: null,
    ...over,
  });

  test('no active version at all is never "the same"', () => {
    expect(sameTranscriptionSettings(null, { speechModel: 'universal', languageCode: 'auto' })).toBe(
      false
    );
  });

  test('auto vs auto on the same REQUESTED model is the same', () => {
    expect(
      sameTranscriptionSettings(version(), {
        speechModel: 'universal-3-5-pro',
        languageCode: 'auto',
      })
    ).toBe(true);
  });

  test('the Indonesian case: same model, forced language, is NOT the same', () => {
    // The whole point of docs/eval-aai-code-switching-2026-09-21.md item 3 —
    // asking for 3.5 Pro again but with `en` must not be refused.
    expect(
      sameTranscriptionSettings(version(), { speechModel: 'universal-3-5-pro', languageCode: 'en' })
    ).toBe(false);
  });

  test('the model that RAN does not decide it — what we asked for does', () => {
    // The active version ran Universal-2 after a fallback; asking for
    // Universal-2 deliberately is a different request.
    expect(
      sameTranscriptionSettings(version(), { speechModel: 'universal', languageCode: 'auto' })
    ).toBe(false);
  });

  test('a forced language matches only the same forced language', () => {
    const forced = version({ languageDetected: false, languageCode: 'en' });
    expect(
      sameTranscriptionSettings(forced, { speechModel: 'universal-3-5-pro', languageCode: 'en' })
    ).toBe(true);
    expect(
      sameTranscriptionSettings(forced, { speechModel: 'universal-3-5-pro', languageCode: 'auto' })
    ).toBe(false);
  });
});

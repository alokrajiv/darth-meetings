/**
 * Phase 3b, the other half of the privacy rule
 * (docs/recordings-phase3b-combine-spec.md §Privacy):
 *
 *   "`scopeMediaToRow` currently gives a row no media unless it has its own
 *    `local_audio_path` — extend it: media of a clip's recording is served
 *    when the CLIP exists on the meeting (the add is the consent)."
 *
 * The Phase 1 guard it extends is the one the 2026-09-21 diff gate found
 * (meeting id 4): two meetings sit on ONE recording because two people
 * imported the same AssemblyAI job, and only one of them ever held the bytes.
 * That case must keep answering `[]` — which is why the meeting's OWN (first,
 * primary) recording is still withheld and only an ADDED one is served.
 *
 * `mock.module` is process-wide, so only `server-only` and `@/lib/db` are
 * stubbed and nothing here touches a socket.
 */
import { describe, expect, mock, test } from 'bun:test';
import { createFakeSql } from '@/db-ops/__tests__/helpers/fake-sql';

const sql = createFakeSql(() => []);
mock.module('server-only', () => ({}));
mock.module('@/lib/db', () => ({ sql, default: sql }));

const { scopeMediaToRow, localMsIn } = await import('@/lib/server/recordings');
const { speakerNaming } = await import('@/lib/server/auto-notes');
const { buildSourcesBlock } = await import('@/lib/server/clip-combine');
import type { ResolvedMedia } from '@/lib/server/recordings';
import type { ClipEntry } from '@/lib/clips';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

function media(over: Partial<ResolvedMedia> = {}): ResolvedMedia {
  return {
    part: 1,
    mediaId: 'm1',
    recordingId: R1,
    filename: 'teams-day.mp4',
    isVideo: true,
    offsetMs: 0,
    durationMs: 17_700_000,
    transcribed: true,
    blobName: null,
    audioOnly: null,
    windowFromMs: null,
    windowToMs: null,
    ...over,
  };
}

const row = (over: Record<string, unknown> = {}) =>
  ({ id: 1, duration: 3600, local_audio_path: null, gmeet_context: null, ...over }) as Parameters<
    typeof scopeMediaToRow
  >[0];

describe('who gets to play which recording', () => {
  const both = [
    media(),
    media({ part: 2, mediaId: 'm2', recordingId: R2, filename: 'corridor.m4a', isVideo: false }),
  ];

  test('a reader of the meeting can play the ADDED recording', () => {
    // The meeting owns its own file, so nothing is withheld — and that
    // includes the recording somebody else added as a clip. The add was the
    // consent; the reader is reading the meeting they were shared.
    const out = scopeMediaToRow(row({ local_audio_path: 'teams-day.mp4' }), both, R1);
    expect(out.map((m) => m.recordingId)).toEqual([R1, R2]);
  });

  test('a meeting with no bytes of its own STILL serves a recording added to it', () => {
    const out = scopeMediaToRow(row(), both, R1);
    expect(out.map((m) => m.recordingId)).toEqual([R2]);
  });

  test('the Phase 1 guard is untouched: one shared recording, no path, no media', () => {
    // Meeting id 4 — the second importer of one AssemblyAI job. One
    // recording, which is its primary, so nothing survives the filter.
    expect(scopeMediaToRow(row(), [media()], R1)).toEqual([]);
    // …and with no primary named at all (fallback mode) it is still [].
    expect(scopeMediaToRow(row(), [media()], null)).toEqual([]);
  });

  test('fallback-mode media (no recording row) is never served without a path', () => {
    const fallback = [media({ recordingId: '', mediaId: '' })];
    expect(scopeMediaToRow(row(), fallback, R1)).toEqual([]);
  });
});

describe('meeting ms → file ms for a combined meeting', () => {
  test('each recording maps through ITS OWN placement, not the primary’s', () => {
    const teams = media({ offsetMs: 0 });
    const phone = media({ part: 2, recordingId: R2, offsetMs: 6_600_000 });
    // 2:00:00 into the meeting is 2:00:00 into the Teams video…
    expect(localMsIn(teams, 7_200_000)).toBe(7_200_000);
    // …and 0:10:00 into the phone clip that starts at 1:50:00.
    expect(localMsIn(phone, 7_200_000)).toBe(600_000);
  });
});

describe('the Sources block the AI prompts get', () => {
  const entry = (over: Partial<ClipEntry>): ClipEntry => ({
    ord: 0,
    recordingId: R1,
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    textPolicy: 'include',
    transcribed: true,
    durationMs: 17_700_000,
    sourceLabel: 'Teams recording',
    ownerEmail: 'kawen@trames.sg',
    ownerName: 'Kawen Koh',
    mine: false,
    primary: true,
    recordingDurationMs: 17_700_000,
    recordingStartedAt: null,
    ...over,
  });

  test('one recording gets no block at all', () => {
    expect(buildSourcesBlock([entry({})])).toBe('');
    // Two WINDOWS of one recording is still one recording (a split source).
    expect(buildSourcesBlock([entry({}), entry({ ord: 1, offsetMs: 1000 })])).toBe('');
  });

  test('two recordings are described with their placement, policy and namespace', () => {
    const block = buildSourcesBlock([
      entry({}),
      entry({
        ord: 1,
        recordingId: R2,
        offsetMs: 6_600_000,
        durationMs: 6_900_000,
        textPolicy: 'gap_fill',
        sourceLabel: 'Upload · corridor.m4a',
        mine: true,
        primary: false,
      }),
    ]);
    expect(block).toContain('captured 2 times');
    expect(block).toContain('Teams recording');
    expect(block).toContain('Kawen Koh');
    expect(block).toContain('Upload · corridor.m4a');
    expect(block).toContain('1h 50m');
    expect(block).toContain('ONLY where the other recordings caught no speech');
    // The fact the model most needs: a letter is per recording.
    expect(block).toContain(R2.slice(0, 8));
    expect(block).toContain('diarized on its own');
  });

  test('a recording added while still transcribing says so', () => {
    const block = buildSourcesBlock([
      entry({}),
      entry({ ord: 1, recordingId: R2, textPolicy: 'exclude', transcribed: false, primary: false }),
    ]);
    expect(block).toContain('not transcribed yet');
    expect(block).toContain('audio only');
  });
});

describe('what the AI prompts call a speaker', () => {
  test('a single-recording meeting is unchanged — bare letters, identity map', () => {
    const naming = speakerNaming(['A', 'B', 'C']);
    expect(naming.namespaced).toBe(false);
    expect(naming.of('A')).toBe('A');
    expect(naming.resolve('A')).toBe('A');
    // Nothing on prod carries a prefix, so every prompt stays byte-identical.
    expect(naming.resolve('Z')).toBeNull();
  });

  test('a combined meeting gets short per-recording aliases, and the way back', () => {
    const naming = speakerNaming([`${R1}:A`, `${R1}:B`, `${R2}:A`]);
    expect(naming.namespaced).toBe(true);
    // Pasting a uuid into the prompt tells the model nothing; stripping the
    // prefix would merge two different people who are both "A".
    expect(naming.of(`${R1}:A`)).toBe('1A');
    expect(naming.of(`${R1}:B`)).toBe('1B');
    expect(naming.of(`${R2}:A`)).toBe('2A');
    // The ID pass matches the model's answer back to the label
    // `speaker_mappings` is keyed by — this is the step that would silently
    // drop every guess if the alias were one-way.
    expect(naming.resolve('2A')).toBe(`${R2}:A`);
    expect(naming.resolve(' 1B ')).toBe(`${R1}:B`);
    // A model that echoed the full label back is understood too.
    expect(naming.resolve(`${R1}:A`)).toBe(`${R1}:A`);
    expect(naming.resolve('3C')).toBeNull();
  });

  test('a Meet import whose labels are real names is not namespaced', () => {
    const naming = speakerNaming(['Kawen Koh', 'Atira Wijaya']);
    expect(naming.namespaced).toBe(false);
    expect(naming.of('Kawen Koh')).toBe('Kawen Koh');
  });
});

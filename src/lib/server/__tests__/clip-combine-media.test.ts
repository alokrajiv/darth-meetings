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

const { scopeMediaToRow, localMsIn, mediaFromGraph, mediaPartsByRecording } = await import(
  '@/lib/server/recordings'
);
const { speakerNaming } = await import('@/lib/server/auto-notes');
const { buildSourcesBlock } = await import('@/lib/server/clip-combine');
import type { ResolvedMedia } from '@/lib/server/recordings';
import type { MeetingRecordingGraph } from '@/db-ops/recordings';
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
    keptMs: null,
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
    sourceKind: 'teams',
    shortLabel: 'Teams',
    ownerEmail: 'kawen@trames.sg',
    ownerName: 'Kawen Koh',
    mine: false,
    primary: true,
    recordingDurationMs: 17_700_000,
    recordingStartedAt: null,
    mediaPart: 1,
    mediaParts: [1],
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

  test('two people recording the same minutes: the overlap window is stated, both texts kept', () => {
    // Ka Wen's tray from 0:00 for 30 min, Ivan's joined at 10:00 for 30 min.
    const block = buildSourcesBlock([
      entry({ durationMs: 1_800_000, recordingDurationMs: 1_800_000, sourceLabel: 'Recorded on Ka Wen’s Mac' }),
      entry({
        ord: 1,
        recordingId: R2,
        offsetMs: 600_000,
        durationMs: 1_800_000,
        recordingDurationMs: 1_800_000,
        sourceLabel: 'Recorded on Ivan’s Mac',
        primary: false,
      }),
    ]);
    expect(block).toContain('OVERLAP 10m 00s–30m 00s of the meeting');
    expect(block).toContain('Recorded on Ka Wen’s Mac');
    expect(block).toContain('Recorded on Ivan’s Mac');
    expect(block).toContain(`"${R1.slice(0, 8)}…:<letter>"`);
    expect(block).toContain(`"${R2.slice(0, 8)}…:<letter>"`);
    expect(block).toContain('appear TWICE');
    expect(block).toContain('reconcile');
  });

  test('recordings that follow each other get no overlap line', () => {
    const block = buildSourcesBlock([
      entry({ durationMs: 600_000, recordingDurationMs: 600_000 }),
      entry({ ord: 1, recordingId: R2, offsetMs: 600_000, durationMs: 600_000, recordingDurationMs: 600_000, primary: false }),
    ]);
    expect(block).not.toContain('OVERLAP');
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

/**
 * `?part=N` — the numbering `ClipEntry.mediaPart` is filled from.
 *
 * It walks playable FILES, not recordings, and the case that breaks every
 * client-side derivation is a NON-PRIMARY recording holding more than one:
 * a Meet call that stopped and restarted, added to a meeting that already had
 * a capture, with a third recording after it. Counting recordings says the
 * third is part 3; the file it would actually fetch is the Meet's second
 * segment. Hence the number is served.
 */
describe('the ?part=N numbering, walked over files', () => {
  const R3 = '33333333-3333-4333-8333-333333333333';

  function graph(
    clips: Array<{ ord: number; recording_id: string; offset_ms: number }>,
    files: Array<{ recording_id: string; kind: 'canonical' | 'part'; ord: number; filename: string | null }>
  ): MeetingRecordingGraph {
    return {
      clips: clips.map((c) => ({
        transcript_id: 1,
        ord: c.ord,
        recording_id: c.recording_id,
        transcription_id: null,
        from_ms: 0,
        to_ms: null,
        offset_ms: c.offset_ms,
        text_policy: 'include',
        created_by: null,
        created_at: '2026-09-22T00:00:00.000Z',
      })),
      recordings: [],
      transcriptions: [],
      media: files.map((f, i) => ({
        id: `m${i + 1}`,
        recording_id: f.recording_id,
        kind: f.kind,
        ord: f.ord,
        offset_ms: f.kind === 'canonical' ? 0 : 600_000 * f.ord,
        duration_ms: 600_000,
        filename: f.filename,
        blob_name: null,
        bytes: null,
        has_video: null,
        sha256: null,
        source_ref: null,
        of_media_id: null,
        created_at: '2026-09-22T00:00:00.000Z',
      })),
    };
  }

  const played = row({ local_audio_path: 'teams-day.mp4' });

  test('one file each: recording order IS part order', () => {
    const media = mediaFromGraph(
      played,
      graph(
        [
          { ord: 0, recording_id: R1, offset_ms: 0 },
          { ord: 1, recording_id: R2, offset_ms: 110_000 },
        ],
        [
          { recording_id: R1, kind: 'canonical', ord: 0, filename: 'teams-day.mp4' },
          { recording_id: R2, kind: 'canonical', ord: 0, filename: 'corridor.m4a' },
        ]
      )
    );
    expect([...mediaPartsByRecording(media)]).toEqual([
      [R1, [1]],
      [R2, [2]],
    ]);
  });

  test('a SECOND recording with two files takes two numbers, and the third starts at 4', () => {
    const media = mediaFromGraph(
      played,
      graph(
        [
          { ord: 0, recording_id: R1, offset_ms: 0 },
          { ord: 1, recording_id: R2, offset_ms: 110_000 },
          { ord: 2, recording_id: R3, offset_ms: 500_000 },
        ],
        [
          { recording_id: R1, kind: 'canonical', ord: 0, filename: 'teams-day.mp4' },
          // Meet stopped and restarted: canonical + one stop/restart part.
          { recording_id: R2, kind: 'canonical', ord: 0, filename: 'meet-1.mp4' },
          { recording_id: R2, kind: 'part', ord: 1, filename: 'meet-2.mp4' },
          { recording_id: R3, kind: 'canonical', ord: 0, filename: 'corridor.m4a' },
        ]
      )
    );
    const parts = mediaPartsByRecording(media);
    expect(parts.get(R1)).toEqual([1]);
    expect(parts.get(R2)).toEqual([2, 3]);
    // The number a client that counted recordings would have got wrong (3).
    expect(parts.get(R3)).toEqual([4]);
    // …and the canonical of each recording is the FIRST of its parts, which
    // is what `ClipEntry.mediaPart` takes.
    expect(media.find((m) => m.part === 2)!.filename).toBe('meet-1.mp4');
    expect(media.find((m) => m.part === 4)!.filename).toBe('corridor.m4a');
  });

  test('timeline order, not `ord`: a clip added later but placed first numbers first', () => {
    const media = mediaFromGraph(
      played,
      graph(
        [
          { ord: 0, recording_id: R1, offset_ms: 900_000 },
          { ord: 1, recording_id: R2, offset_ms: 0 },
        ],
        [
          { recording_id: R1, kind: 'canonical', ord: 0, filename: 'late.mp4' },
          { recording_id: R2, kind: 'canonical', ord: 0, filename: 'early.m4a' },
        ]
      )
    );
    expect(mediaPartsByRecording(media).get(R2)).toEqual([1]);
    expect(mediaPartsByRecording(media).get(R1)).toEqual([2]);
  });

  test('a file whose bytes are not held RESERVES its number and gets no part', () => {
    // `audio/route.ts` indexes `videoParts[N-2]`, so a segment fetched later
    // must keep the number it always had.
    const media = mediaFromGraph(
      played,
      graph(
        [
          { ord: 0, recording_id: R1, offset_ms: 0 },
          { ord: 1, recording_id: R2, offset_ms: 110_000 },
        ],
        [
          { recording_id: R1, kind: 'canonical', ord: 0, filename: 'teams-day.mp4' },
          { recording_id: R1, kind: 'part', ord: 1, filename: null },
          { recording_id: R2, kind: 'canonical', ord: 0, filename: 'corridor.m4a' },
        ]
      )
    );
    const parts = mediaPartsByRecording(media);
    expect(parts.get(R1)).toEqual([1]);
    expect(parts.get(R2)).toEqual([3]);
  });

  test('a recording the privacy scope withheld has NO part — a clip on it gets none', () => {
    // The meeting holds no bytes of its own, so its primary recording is
    // withheld (the Phase 1 guard) while the ADDED one is served.
    const media = mediaFromGraph(
      row(),
      graph(
        [
          { ord: 0, recording_id: R1, offset_ms: 0 },
          { ord: 1, recording_id: R2, offset_ms: 110_000 },
        ],
        [
          { recording_id: R1, kind: 'canonical', ord: 0, filename: 'teams-day.mp4' },
          { recording_id: R2, kind: 'canonical', ord: 0, filename: 'corridor.m4a' },
        ]
      )
    );
    const parts = mediaPartsByRecording(media);
    expect(parts.get(R1)).toBeUndefined();
    // …and the one that IS served keeps the number it was given, so the
    // chip and `/audio?part=2` still agree.
    expect(parts.get(R2)).toEqual([2]);
  });

  test('no clips at all falls back to the row’s own file', () => {
    const media = mediaFromGraph(played, graph([], []));
    expect(media.map((m) => m.part)).toEqual([1]);
    // Fallback media has no recording id, so nothing can be keyed to it.
    expect([...mediaPartsByRecording(media)]).toEqual([]);
  });
});

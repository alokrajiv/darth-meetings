import { describe, expect, test } from 'bun:test';
import type { GmeetContext } from '../format';
import {
  canonicalKeyOf,
  deriveRecordingGraph,
  desiredClipFor,
  isRealAaiId,
  ownerRowOf,
  providerOf,
  recordingFilenames,
  recordingIdFor,
  skipReason,
  sourceKindOf,
  transcriptionStatusOf,
  uuidv5,
  type GraphFileFacts,
  type GraphMeetingRow,
} from '../recording-graph';

/**
 * The rules the backfill and the app's dual-write BOTH run. A change here
 * changes what `scripts/recordings-backfill.ts` writes on prod and what
 * `lib/server/recording-sync.ts` writes on every upload — the two must stay
 * one implementation, which is what this file is guarding.
 */

const AAI = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function row(over: Partial<GraphMeetingRow> = {}): GraphMeetingRow {
  return {
    id: 1,
    user_id: 'u1',
    assemblyai_id: AAI,
    original_filename: 'board.m4a',
    status: 'completed',
    created_at: '2026-09-01T10:00:00Z',
    completed_at: '2026-09-01T10:10:00Z',
    duration: 18,
    language_code: 'en',
    speech_model: 'universal',
    local_audio_path: `${AAI}.m4a`,
    deleted_at: null,
    gmeet_context: null,
    has_content: true,
    ...over,
  };
}

describe('ids', () => {
  test('uuidv5 matches the published RFC 4122 vector', () => {
    // uuidv5(DNS namespace, 'python.org') — the canonical example.
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d'
    );
  });

  test('the same key always yields the same recording id', () => {
    expect(recordingIdFor(AAI)).toBe(recordingIdFor(AAI));
    expect(recordingIdFor(AAI)).not.toBe(recordingIdFor('t1'));
  });

  test('every media and transcription id hangs off the recording id', () => {
    const a = deriveRecordingGraph(row());
    const b = deriveRecordingGraph(row());
    expect(a.media.map((m) => m.id)).toEqual(b.media.map((m) => m.id));
    expect(a.transcription.id).toBe(b.transcription.id);
  });
});

describe('canonical key', () => {
  test('a real AssemblyAI job is the key, so two importers collapse', () => {
    expect(canonicalKeyOf(row({ id: 7, user_id: 'u1' }))).toBe(AAI);
    expect(canonicalKeyOf(row({ id: 9, user_id: 'u2' }))).toBe(AAI);
  });

  test('everything else keys on the row id, which survives a promotion', () => {
    expect(canonicalKeyOf(row({ id: 42, assemblyai_id: 'up-abc' }))).toBe('t42');
    // Ownership transfer changes user_id but not the key.
    expect(canonicalKeyOf(row({ id: 42, assemblyai_id: 'up-abc', user_id: 'u2' }))).toBe('t42');
  });

  test('synthetic ids are not real AssemblyAI ids', () => {
    expect(isRealAaiId(AAI)).toBe(true);
    for (const id of ['gmeet-x', 'teams-x', 'ext-x', `up-${AAI}`, `defer-${AAI}`]) {
      expect(isRealAaiId(id)).toBe(false);
    }
  });
});

describe('classification', () => {
  test('the tray wins over every other signal, marker or reverse link', () => {
    expect(sourceKindOf(row({ gmeet_context: { recorder: { recordingId: 'r' } } }))).toBe('recorder');
    expect(sourceKindOf(row({ recorder_recording_id: 'r' }))).toBe('recorder');
  });

  test('a Meet VIDEO import has a real AssemblyAI id — the context decides', () => {
    expect(sourceKindOf(row({ gmeet_context: { videoFileId: 'drive-1' } }))).toBe('meet');
    expect(sourceKindOf(row({ gmeet_context: { provider: 'teams' } as GmeetContext }))).toBe('teams');
    expect(providerOf(row())).toBe('assemblyai');
  });

  test('id prefixes decide the parsed imports', () => {
    expect(sourceKindOf(row({ assemblyai_id: 'gmeet-1' }))).toBe('meet');
    expect(providerOf(row({ assemblyai_id: 'gmeet-1' }))).toBe('meet-doc');
    expect(providerOf(row({ assemblyai_id: 'teams-1' }))).toBe('teams-vtt');
    expect(providerOf(row({ assemblyai_id: 'ext-1' }))).toBe('text');
  });

  test('a bare AssemblyAI id with no bytes and no context is an import', () => {
    expect(sourceKindOf(row({ local_audio_path: null, gmeet_context: null }))).toBe('aai-import');
    expect(sourceKindOf(row({ gmeet_context: null }))).toBe('upload');
  });

  test('status collapses to the three the transcription knows', () => {
    expect(transcriptionStatusOf(row({ status: 'completed' }))).toBe('completed');
    expect(transcriptionStatusOf(row({ status: 'error' }))).toBe('error');
    for (const s of ['queued', 'processing', 'uploading', 'waiting']) {
      expect(transcriptionStatusOf(row({ status: s }))).toBe('processing');
    }
  });
});

describe('skip rules', () => {
  test('a placeholder with nothing behind it is skipped', () => {
    expect(skipReason(row({ assemblyai_id: 'up-1', has_content: false, local_audio_path: null })))
      .toContain('placeholder');
    expect(skipReason(row({ assemblyai_id: 'defer-1', has_content: false, local_audio_path: null })))
      .toContain('placeholder');
  });

  test('a placeholder that OWNS bytes is not skipped (a kept ingest failure)', () => {
    expect(
      skipReason(row({ assemblyai_id: 'up-1', has_content: false, local_audio_path: 'up-1.m4a' }))
    ).toBeNull();
  });

  test('a real row is never skipped', () => {
    expect(skipReason(row())).toBeNull();
    expect(skipReason(row({ has_content: false, local_audio_path: null }))).toBeNull();
  });
});

describe('the plain 1:1 meeting', () => {
  const graph = deriveRecordingGraph(row());

  test('one canonical file, no parts, one wall-time transcription', () => {
    expect(graph.media).toHaveLength(1);
    expect(graph.media[0]!.kind).toBe('canonical');
    expect(graph.media[0]!.filename).toBe(`${AAI}.m4a`);
    expect(graph.media[0]!.hasVideo).toBe(false);
    expect(graph.transcription.covers).toEqual({ media: [graph.media[0]!.id], timeline: 'wall' });
    expect(graph.transcription.providerJobId).toBe(AAI);
  });

  test('the clip is the whole recording, in place', () => {
    expect(desiredClipFor(1)).toEqual({
      transcriptId: 1,
      ord: 0,
      transcriptionId: null,
      fromMs: 0,
      toMs: null,
      offsetMs: 0,
      textPolicy: 'include',
    });
  });

  test('duration is seconds on the row, ms on the recording', () => {
    expect(graph.recording.durationMs).toBe(18_000);
  });

  test('unprobed means no bytes and no derivative rows', () => {
    expect(graph.filesProbed).toBe(false);
    expect(graph.media[0]!.bytes).toBeNull();
  });
});

describe('Meet stop/restart — parts of ONE recording (DEC-1)', () => {
  const gmeet: GmeetContext = {
    videoFileId: 'drive-9',
    actuals: {
      anchorIso: '2026-09-03T10:00:00Z',
      recordings: [{ fileId: 'drive-9', startTime: '2026-09-03T10:00:00Z' }],
    },
    videoParts: [
      { fileId: 'p2', startTime: '2026-09-03T10:35:10Z', endTime: '2026-09-03T11:01:00Z' },
      {
        fileId: 'p3',
        startTime: '2026-09-03T11:02:00Z',
        endTime: '2026-09-03T11:40:30Z',
        filename: 'c.part3.mp4',
      },
    ],
  } as GmeetContext;
  const graph = deriveRecordingGraph(row({ local_audio_path: 'c.mp4', gmeet_context: gmeet }));

  test('offsets are the wall-clock delta lib/part-offsets.ts computes', () => {
    const parts = graph.media.filter((m) => m.kind === 'part');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.offsetMs).toBe(35 * 60_000 + 10_000);
    expect(parts[1]!.offsetMs).toBe(62 * 60_000);
    expect(parts[0]!.durationMs).toBe(25 * 60_000 + 50_000);
  });

  test('a part whose bytes are not stored keeps its row and its number', () => {
    const parts = graph.media.filter((m) => m.kind === 'part');
    expect(parts[0]!.filename).toBeNull();
    expect(parts[1]!.filename).toBe('c.part3.mp4');
  });

  test('the job heard only the canonical — that is the amber warning', () => {
    const canonical = graph.media.find((m) => m.kind === 'canonical')!;
    expect(graph.transcription.covers.media).toEqual([canonical.id]);
    expect(graph.transcription.covers.timeline).toBe('wall');
  });

  test('started_at is the Meet anchor', () => {
    expect(graph.recording.startedAt).toBe('2026-09-03T10:00:00.000Z');
  });
});

describe('stitched and combined uploads', () => {
  test('uploadedParts become parts and the canonical is stamped derived', () => {
    const graph = deriveRecordingGraph(
      row({
        local_audio_path: 'd.mp4',
        gmeet_context: {
          uploadedParts: [
            { index: 1, originalFilename: 'part1.mp4', durationSec: 432, offsetSec: 0 },
            { index: 2, originalFilename: 'part2.mp4', comment: 'room mic', durationSec: 468, offsetSec: 432 },
          ],
        } as GmeetContext,
      })
    );
    const canonical = graph.media.find((m) => m.kind === 'canonical')!;
    expect(canonical.sourceRef).toMatchObject({ derived: 'concat' });
    const parts = graph.media.filter((m) => m.kind === 'part');
    expect(parts.map((p) => p.offsetMs)).toEqual([0, 432_000]);
    expect(parts.map((p) => p.filename)).toEqual([null, null]);
    expect(parts[1]!.sourceRef).toMatchObject({ comment: 'room mic' });
    // A concat job heard everything, on concat time.
    expect(graph.transcription.covers.timeline).toBe('concat');
    expect(graph.transcription.covers.media).toHaveLength(3);
  });

  test('combinedParts is a COUNT — N bare part rows', () => {
    const graph = deriveRecordingGraph(
      row({ local_audio_path: 'e.mp4', gmeet_context: { combinedParts: 3 } as GmeetContext })
    );
    const parts = graph.media.filter((m) => m.kind === 'part');
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.filename === null && p.offsetMs === null)).toBe(true);
    expect(parts[0]!.sourceRef).toEqual({ combined: true });
  });

  test('the longest of the three shapes wins — never double counted', () => {
    const graph = deriveRecordingGraph(
      row({
        local_audio_path: 'f.mp4',
        gmeet_context: {
          combinedParts: 2,
          uploadedParts: [
            { index: 1, offsetSec: 0 },
            { index: 2, offsetSec: 10 },
            { index: 3, offsetSec: 20 },
          ],
        } as GmeetContext,
      })
    );
    expect(graph.media.filter((m) => m.kind === 'part')).toHaveLength(3);
  });
});

describe('§5a started_at', () => {
  test('the Meet anchor wins', () => {
    const graph = deriveRecordingGraph(
      row({
        gmeet_context: { actuals: { anchorIso: '2026-09-02T09:00:00Z' } } as GmeetContext,
        recorder_started_at: '2026-09-02T08:00:00Z',
      })
    );
    expect(graph.recording.startedAt).toBe('2026-09-02T09:00:00.000Z');
  });

  test('else the tray recording start', () => {
    const graph = deriveRecordingGraph(
      row({ recorder_recording_id: 'r1', recorder_started_at: '2026-09-02T08:00:00Z' })
    );
    expect(graph.recording.startedAt).toBe('2026-09-02T08:00:00.000Z');
    expect(graph.recording.sourceKind).toBe('recorder');
    expect(graph.recording.recorderRecordingId).toBe('r1');
  });

  test('neither — the recording timeline is not anchored to a clock', () => {
    expect(deriveRecordingGraph(row()).recording.startedAt).toBeNull();
  });

  test('a garbage anchor is not a timestamp', () => {
    const graph = deriveRecordingGraph(
      row({ gmeet_context: { actuals: { anchorIso: 'not a date' } } as GmeetContext })
    );
    expect(graph.recording.startedAt).toBeNull();
  });
});

describe('file facts', () => {
  const r = row({
    local_audio_path: 'c.mp4',
    gmeet_context: {
      videoParts: [{ fileId: 'p2', filename: 'c.part2.mp4' }],
    } as GmeetContext,
  });

  test('recordingFilenames lists the canonical plus every stored part', () => {
    expect(recordingFilenames(r)).toEqual(['c.mp4', 'c.part2.mp4']);
  });

  test('probed bytes land on the rows and extracts become audio_only', () => {
    const files: GraphFileFacts = {
      audio: new Map([
        ['c.mp4', 1234],
        ['c.part2.mp4', 99],
      ]),
      audioOnly: new Map([['c', 77]]),
    };
    const graph = deriveRecordingGraph(r, files);
    expect(graph.filesProbed).toBe(true);
    expect(graph.media.find((m) => m.kind === 'canonical')!.bytes).toBe(1234);
    const extracts = graph.media.filter((m) => m.kind === 'audio_only');
    expect(extracts).toHaveLength(1);
    expect(extracts[0]!.filename).toBe('c.m4a');
    expect(extracts[0]!.bytes).toBe(77);
    expect(extracts[0]!.ofMediaId).toBe(graph.media.find((m) => m.kind === 'canonical')!.id);
    // The extract is never part of what the job heard.
    expect(graph.transcription.covers.media).not.toContain(extracts[0]!.id);
  });

  test('a part gets its own extract row, with its own id space', () => {
    const graph = deriveRecordingGraph(r, {
      audio: new Map(),
      audioOnly: new Map([
        ['c', 1],
        ['c.part2', 2],
      ]),
    });
    const extracts = graph.media.filter((m) => m.kind === 'audio_only');
    expect(extracts).toHaveLength(2);
    expect(new Set(extracts.map((e) => e.id)).size).toBe(2);
  });

  test('no faststart rows: the remux rewrites the source in place', () => {
    const graph = deriveRecordingGraph(r, { audio: new Map(), audioOnly: new Map([['c', 1]]) });
    expect(graph.media.some((m) => m.kind === 'faststart')).toBe(false);
  });
});

describe('the shared AssemblyAI job (landmine #14)', () => {
  const first = row({ id: 10, user_id: 'u1', created_at: '2026-09-02T10:00:00Z' });
  const second = row({ id: 11, user_id: 'u2', created_at: '2026-09-02T11:00:00Z' });

  test('the earlier created_at owns it', () => {
    expect(ownerRowOf([second, first])!.id).toBe(10);
  });

  test('a tie is broken by the lower row id', () => {
    const a = row({ id: 11, created_at: '2026-09-02T10:00:00Z' });
    const b = row({ id: 10, created_at: '2026-09-02T10:00:00Z' });
    expect(ownerRowOf([a, b])!.id).toBe(10);
  });

  test('both derive ONE recording; the owner supplies its fields', () => {
    const owner = ownerRowOf([first, second])!;
    const graph = deriveRecordingGraph(owner);
    expect(graph.recording.id).toBe(recordingIdFor(AAI));
    expect(graph.recording.ownerUserId).toBe('u1');
    expect(graph.payloadFromTranscriptId).toBe(10);
  });

  test('ownerRowOf of nothing is nothing', () => {
    expect(ownerRowOf([])).toBeNull();
  });
});

describe('a text / Meet-doc import has no media at all', () => {
  const graph = deriveRecordingGraph(
    row({ assemblyai_id: 'gmeet-1', local_audio_path: null, gmeet_context: { meetingCode: 'x' } as GmeetContext })
  );

  test('no files, an empty covers list, no provider job', () => {
    expect(graph.media).toHaveLength(0);
    expect(graph.transcription.covers).toEqual({ media: [], timeline: 'wall' });
    expect(graph.transcription.providerJobId).toBeNull();
    expect(graph.transcription.provider).toBe('meet-doc');
  });
});

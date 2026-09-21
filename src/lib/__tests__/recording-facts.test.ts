import { describe, expect, test } from 'bun:test';
import { formatBytes } from '../format';
import { recordingFacts, recordingMediaOf, recordingSourceOf, type RecordingFactsRow } from '../recording-facts';

// The Hypercare row (591b102e…, 2026-09-21) as an Editor sees it: Atira's
// Darth Recorder upload, 8 segments, 56m 45s, 648 379 934 bytes, video.
const hypercare: RecordingFactsRow = {
  assemblyai_id: '591b102e-2831-4eb3-aece-8172edde0133',
  source: 'uploaded',
  original_filename: '2026-09-21 16.36.41 teams part1.mp4',
  local_audio_path: '591b102e-2831-4eb3-aece-8172edde0133.mp4',
  duration: 3405,
  upload_bytes_total: 648379934,
  created_at: '2026-09-21T09:06:00Z',
  recorded_at: '2026-09-21T08:30:00Z',
  access: 'edit',
  owner_email: 'atira.sarat@trames.sg',
  owner_name: 'atira',
  gmeet_context: {
    recorder: { recordingId: '37f51f19-4d73-445d-a829-33bba26eb6c4' },
    eventId: 'x',
    startTime: '2026-09-21T08:30:00Z',
    endTime: '2026-09-21T09:30:00Z',
    uploadedParts: [
      { index: 2, originalFilename: '2026-09-21 16.36.41 teams part2.mp4', durationSec: 123, offsetSec: 432 },
      { index: 1, originalFilename: '2026-09-21 16.36.41 teams part1.mp4', durationSec: 432, offsetSec: 0 },
      { index: 3, durationSec: 700, offsetSec: 555 },
      { index: 4 },
      { index: 5 },
      { index: 6 },
      { index: 7 },
      { index: 8 },
    ],
  },
};

describe('recordingFacts — Darth Recorder upload seen by an editor', () => {
  const f = recordingFacts(hypercare);
  test('source sentence names the owner, never the file', () => {
    expect(f.source).toBe('mac');
    expect(f.lead).toBe('Recorded on Atira’s Mac');
    expect(f.tail).toBe('with Darth Recorder');
    expect(f.lead).not.toContain('.mp4');
  });
  test('facts line: segments · duration · size · media', () => {
    expect(f.facts).toEqual(['8 segments', '56m 45s', formatBytes(648379934), 'video']);
    expect(f.segmentCount).toBe(8);
    expect(f.media).toBe('video');
  });
  test('segments are sorted and keep the filename for the tooltip only', () => {
    expect(f.segments.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.segments[0]).toEqual({ index: 1, offsetSec: 0, durationSec: 432, comment: null, filename: '2026-09-21 16.36.41 teams part1.mp4' });
    expect(f.segments[3]).toEqual({ index: 4, offsetSec: null, durationSec: null, comment: null, filename: null });
    expect(f.segmentsNote).toContain('screen-share');
    expect(f.filename).toBe('2026-09-21 16.36.41 teams part1.mp4');
  });
  test('same day held and uploaded → no held-vs-added line', () => {
    expect(f.heldVsAdded).toBeNull();
  });
  test('the owner sees "your Mac"', () => {
    expect(recordingFacts({ ...hypercare, access: 'owner' }).lead).toBe('Recorded on your Mac');
  });
});

describe('recordingFacts — other sources', () => {
  const base: RecordingFactsRow = {
    assemblyai_id: 'abc',
    source: 'uploaded',
    original_filename: 'call.m4a',
    local_audio_path: 'abc.m4a',
    duration: 61,
    created_at: '2026-08-11T02:00:00Z',
    recorded_at: '2026-08-04T02:00:00Z',
    gmeet_context: null,
  };
  test('plain audio upload: no segments word, audio media, held-vs-added when days differ', () => {
    const f = recordingFacts(base);
    expect(f.source).toBe('file');
    expect(f.lead).toBe('Uploaded audio');
    expect(f.facts).toEqual(['1m 1s', 'audio']);
    expect(f.segmentCount).toBe(1);
    expect(f.segmentsNote).toBeNull();
    expect(f.heldVsAdded).toBe('held 4 Aug, uploaded 11 Aug');
  });
  test('stitched upload with comments', () => {
    const f = recordingFacts({
      ...base,
      gmeet_context: {
        uploadedParts: [
          { index: 1, originalFilename: 'a.m4a', comment: 'room mic' },
          { index: 2, originalFilename: 'b.m4a' },
        ],
      },
    });
    expect(f.facts[0]).toBe('2 segments');
    expect(f.segmentsNote).toContain('per-file notes');
    expect(f.segments[0]?.comment).toBe('room mic');
  });
  test('Meet import with a combined recording', () => {
    const f = recordingFacts({
      ...base,
      source: 'imported',
      assemblyai_id: 'uuid-1',
      original_filename: null,
      local_audio_path: 'uuid-1.mp4',
      drive_file_id: 'drive',
      gmeet_context: { provider: 'gmeet', combinedParts: 2, videoParts: [{ fileId: 'f2' }] },
    });
    expect(f.source).toBe('meet');
    expect(f.lead).toBe('Recorded in Google Meet');
    expect(f.segmentCount).toBe(2);
    expect(f.segmentsNote).toContain('combined');
    expect(f.extraVideos).toBe(1);
    expect(f.media).toBe('video');
  });
  test('Teams and text imports', () => {
    expect(recordingSourceOf({ ...base, source: 'imported', gmeet_context: { provider: 'teams' } })).toBe('teams');
    const text = recordingFacts({ ...base, source: 'imported', original_filename: 'notes.txt', local_audio_path: null });
    expect(text.source).toBe('text');
    expect(text.media).toBe('none');
    expect(text.facts).toEqual(['1m 1s']);
    expect(text.lead).toBe('Imported transcript');
  });
  test('media detection prefers the stored file over the original name', () => {
    expect(recordingMediaOf({ ...base, original_filename: 'x.mp4', local_audio_path: 'x.m4a' })).toBe('audio');
    expect(recordingMediaOf({ ...base, original_filename: 'x.mp4', local_audio_path: null })).toBe('video');
    expect(recordingMediaOf({ ...base, original_filename: 'x', local_audio_path: null })).toBe('audio');
  });
});

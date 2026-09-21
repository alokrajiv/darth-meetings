/**
 * "A row is a meeting, never a file" — the listing must never print a
 * filename as a title, and bare uploads must be recognised so the Recordings
 * tab (not the timeline) holds them (docs/listing-ui-redesign.md §3, §6).
 */
import { describe, expect, test } from 'bun:test';
import {
  hasNoRealTitle,
  isBareRecording,
  looksLikeFilename,
  meetingTitleOf,
  recordingSourceLabel,
  type TitleRowFields,
} from '../meeting-title';

const row = (over: Partial<TitleRowFields> = {}): TitleRowFields => ({
  title: null,
  original_filename: null,
  has_event: false,
  scratch: false,
  deleted_at: null,
  recorded_at: '2026-09-20T14:00:04Z',
  created_at: '2026-09-20T14:05:00Z',
  recorder_recording_id: null,
  source: 'uploaded',
  provider: null,
  ...over,
});

describe('looksLikeFilename', () => {
  test('media and document extensions', () => {
    for (const t of ['2026-09-20 22.00.04 display part1.mp4', 'TFCN.m4a', 'call.MOV', 'notes.vtt', 'x.docx']) {
      expect(looksLikeFilename(t)).toBe(true);
    }
  });
  test('the recorder naming without an extension', () => {
    expect(looksLikeFilename('2026-09-21 11.02.54 meet part1')).toBe(true);
  });
  test('phone voice-memo defaults', () => {
    expect(looksLikeFilename('New Recording 3')).toBe(true);
    expect(looksLikeFilename('Voice 042')).toBe(true);
  });
  test('real meeting titles are not filenames', () => {
    expect(looksLikeFilename('Alok <> Paola - Post SG - PPT Review')).toBe(false);
    expect(looksLikeFilename('Data scrum - 2026/09/21 11:30 IST - Recording')).toBe(false);
    expect(looksLikeFilename('Triton next steps!')).toBe(false);
    expect(looksLikeFilename('Recording of the offsite')).toBe(false);
  });
});

describe('hasNoRealTitle / isBareRecording', () => {
  test('empty title is bare', () => {
    expect(isBareRecording(row())).toBe(true);
  });
  test('title equal to the filename is bare', () => {
    expect(isBareRecording(row({ title: 'TFCN.m4a', original_filename: 'TFCN.m4a' }))).toBe(true);
  });
  test('a linked event is never bare, whatever the title', () => {
    expect(isBareRecording(row({ title: 'x.mp4', has_event: true }))).toBe(false);
  });
  test('temporary and trashed rows are never bare', () => {
    expect(isBareRecording(row({ scratch: true }))).toBe(false);
    expect(isBareRecording(row({ deleted_at: '2026-09-21T00:00:00Z' }))).toBe(false);
  });
  test('a human title is not bare even without an event', () => {
    expect(isBareRecording(row({ title: 'Customer call — Bega' }))).toBe(false);
    expect(hasNoRealTitle({ title: 'Customer call — Bega', original_filename: 'x.m4a' })).toBe(false);
  });
});

describe('meetingTitleOf', () => {
  const now = new Date('2026-09-21T10:00:00Z');
  test('a real title is returned as-is', () => {
    const t = meetingTitleOf(row({ title: '  Lothal scrum ', original_filename: 'a.mp4' }), now);
    expect(t).toEqual({ primary: 'Lothal scrum', kind: 'title', filename: 'a.mp4' });
  });
  test('a filename title becomes a derived recording title with the date', () => {
    const t = meetingTitleOf(
      row({ title: '2026-09-20 22.00.04 display part1.mp4', original_filename: '2026-09-20 22.00.04 display part1.mp4', recorder_recording_id: 'r1' }),
      now
    );
    expect(t.kind).toBe('derived');
    expect(t.primary.startsWith('Recording from your Mac · ')).toBe(true);
    expect(t.primary).not.toContain('.mp4');
    expect(t.filename).toBe('2026-09-20 22.00.04 display part1.mp4');
  });
  test('source label per provenance', () => {
    expect(recordingSourceLabel({ recorder_recording_id: 'r', source: 'uploaded', provider: null })).toBe('Recording from your Mac');
    expect(recordingSourceLabel({ recorder_recording_id: null, source: 'imported', provider: 'gmeet' })).toBe('Meet recording');
    expect(recordingSourceLabel({ recorder_recording_id: null, source: 'imported', provider: 'teams' })).toBe('Teams recording');
    expect(recordingSourceLabel({ recorder_recording_id: null, source: 'uploaded', provider: null })).toBe('Uploaded recording');
    expect(recordingSourceLabel({ recorder_recording_id: null, source: 'imported', provider: null })).toBe('Pasted transcript');
  });
});

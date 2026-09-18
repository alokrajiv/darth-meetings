/**
 * Registry rows stuck at `recording` (a tray process that died mid-recording)
 * must never render as a live recording: the picker folds them to local /
 * upload_failed against the tray's snapshot, and the calendar row copy calls a
 * day-old one "never finished" instead of "now…".
 */
import { describe, expect, test } from 'bun:test';
import { foldStaleRecording, type CompanionRecording } from '../companion/companion-client';
import { recorderRowCopy, RECORDING_STALE_MS, type RecorderRecordingRef } from '../recorder';

const row = (over: Partial<CompanionRecording> = {}): CompanionRecording => ({
  id: 'r1',
  files: [],
  bytes: 0,
  duration: 0,
  started_at: '2026-09-16T13:23:18Z',
  call: { kind: 'whatsapp', app: 'WhatsApp' },
  status: 'recording',
  transcript_id: null,
  error: null,
  matched: null,
  ...over,
});

describe('foldStaleRecording', () => {
  test('a live recording (same id) stays as it is', () => {
    expect(foldStaleRecording(row(), { recording: true, recordingId: 'r1' }).status).toBe('recording');
  });
  test('a live recording on a tray that omits recording_id stays as it is', () => {
    expect(foldStaleRecording(row(), { recording: true, recordingId: null }).status).toBe('recording');
  });
  test('tray idle + no files → upload_failed with a reason', () => {
    const r = foldStaleRecording(row(), { recording: false, recordingId: null });
    expect(r.status).toBe('upload_failed');
    expect(r.error).toContain('never finished');
  });
  test('tray recording something else + files with bytes → local (Upload works)', () => {
    const r = foldStaleRecording(row({ files: ['/a.mov'], bytes: 12 }), { recording: true, recordingId: 'other' });
    expect(r.status).toBe('local');
    expect(r.error).toBeNull();
  });
  test('non-recording rows pass through untouched', () => {
    const local = row({ status: 'local' });
    expect(foldStaleRecording(local, { recording: false, recordingId: null })).toBe(local);
  });
});

describe('recorderRowCopy for a stuck recording row', () => {
  const rec = (startedAt: string): RecorderRecordingRef => ({
    id: 'r1',
    mine: true,
    ownerEmail: 'alok@trames.sg',
    hostname: null,
    status: 'recording',
    startedAt,
    durationS: null,
    transcriptId: null,
    nudgedAt: null,
  });
  const now = Date.parse('2026-09-19T02:00:00Z');
  test('a fresh one is "now…"', () => {
    const c = recorderRowCopy(rec('2026-09-19T01:30:00Z'), { now });
    expect(c.text).toBe('Recording on your Mac now…');
    expect(c.action).toBeNull();
  });
  test('one older than the stale window "never finished"', () => {
    const c = recorderRowCopy(rec(new Date(now - RECORDING_STALE_MS - 1000).toISOString()), { now });
    expect(c.text).toBe('Recording on your Mac never finished');
    expect(c.action).toBeNull();
  });
  test('no started_at cannot be judged → still "now…"', () => {
    expect(recorderRowCopy({ ...rec('x'), startedAt: null }, { now }).text).toBe('Recording on your Mac now…');
  });
});

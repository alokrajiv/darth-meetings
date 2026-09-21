/**
 * The recording strip's state table (docs/listing-ui-redesign.md §4): every
 * state → the sentence, the tone and the ONE action. Numbers are never
 * invented — a 6-part 696 MB upload says "part 3 of 6 · 298 MB of 696 MB".
 */
import { describe, expect, test } from 'bun:test';
import {
  provenanceTitle,
  sourceOfArchiveRow,
  stripForArchiveRow,
  stripForCalendarRow,
  stripForRecorderRef,
  type ArchiveStripRow,
  type CalendarStripRow,
} from '../recording-strip';
import type { RecorderRecordingRef } from '../recorder';

const fmtBytes = (n: number) => `${Math.round(n / 1_000_000)} MB`;
const fmtDuration = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`;
const opts = { fmtBytes, fmtDuration };

const arow = (over: Partial<ArchiveStripRow> = {}): ArchiveStripRow => ({
  assemblyai_id: 'abc',
  status: 'completed',
  source: 'uploaded',
  provider: null,
  recorder_recording_id: null,
  recording_count: 1,
  duration: 2672,
  ...over,
});

describe('sourceOfArchiveRow', () => {
  test('recorder beats provider', () => {
    expect(sourceOfArchiveRow(arow({ recorder_recording_id: 'r', provider: 'gmeet' }))).toBe('mac');
  });
  test('gmeet- ids without a provider column are Meet', () => {
    expect(sourceOfArchiveRow(arow({ assemblyai_id: 'gmeet-x', source: 'imported' }))).toBe('meet');
  });
  test('imported without provider is pasted text', () => {
    expect(sourceOfArchiveRow(arow({ source: 'imported' }))).toBe('text');
  });
});

describe('stripForArchiveRow — silence is the default', () => {
  test('a transcribed single cloud recording has NO strip', () => {
    expect(stripForArchiveRow(arow({ provider: 'gmeet', source: 'imported' }), opts)).toBeNull();
  });
  test('a transcribed uploaded file has NO strip', () => {
    expect(stripForArchiveRow(arow(), opts)).toBeNull();
  });
  test('a transcribed Mac recording with 6 segments says so', () => {
    const m = stripForArchiveRow(arow({ recorder_recording_id: 'r', recording_count: 6 }), opts)!;
    expect(m.state).toBe('transcribed');
    expect(m.text).toBe('Recorded on your Mac · 6 segments · 44m 32s');
    expect(m.action).toBeNull();
    expect(m.busy).toBe(false);
  });

  test('a shared Mac recording names the owner, not "your Mac"', () => {
    const m = stripForArchiveRow(
      arow({ recorder_recording_id: 'r', recording_count: 8, duration: 3405, access: 'edit', owner_email: 'atira.sarat@trames.sg' }),
      opts
    )!;
    expect(m.text).toBe('Recorded on Atira’s Mac · 8 segments · 56m 45s');
    expect(stripForArchiveRow(arow({ recorder_recording_id: 'r', access: 'owner' }), opts)!.text).toContain('your Mac');
    const up = stripForArchiveRow(arow({ recorder_recording_id: 'r', status: 'uploading', access: 'read', owner_name: 'Atira Sarat' }), opts)!;
    expect(up.text).toContain('Uploading from Atira’s Mac');
  });
  test('a Meet meeting with two videos', () => {
    const m = stripForArchiveRow(arow({ provider: 'gmeet', source: 'imported', recording_count: 2, duration: 1293 }), opts)!;
    expect(m.text).toBe('Meet recording · 2 parts · 21m 33s');
  });
});

describe('stripForArchiveRow — in flight', () => {
  test('multi-part Mac upload reads part N of M over the whole recording', () => {
    const m = stripForArchiveRow(
      arow({
        status: 'uploading',
        recorder_recording_id: 'r',
        upload_bytes_received: 298_000_000,
        upload_bytes_total: 696_000_000,
        upload_parts_done: 2,
        upload_parts_total: 6,
      }),
      opts
    )!;
    expect(m.state).toBe('uploading');
    expect(m.text).toBe('Uploading from your Mac · part 3 of 6 · 298 MB of 696 MB');
    expect(m.progress).toEqual({ pct: 42, label: 'part 3 of 6 · 298 MB of 696 MB', live: false });
    expect(m.busy).toBe(true);
  });
  test('the tray’s live numbers win and are marked live', () => {
    const m = stripForArchiveRow(
      arow({ status: 'uploading', recorder_recording_id: 'r', upload_bytes_received: 1, upload_bytes_total: 15_000_000 }),
      { ...opts, live: { pct: 43, bytesSent: 298_000_000, bytesTotal: 696_000_000 } }
    )!;
    expect(m.text).toBe('Uploading from your Mac · 43% · 298 MB of 696 MB · live');
    expect(m.progress?.live).toBe(true);
  });
  test('single-file upload with a percentage', () => {
    const m = stripForArchiveRow(
      arow({ status: 'uploading', upload_bytes_received: 120_000_000, upload_bytes_total: 280_000_000 }),
      opts
    )!;
    expect(m.text).toBe('Uploading · 42% · 120 MB of 280 MB');
  });
  test('bytes caught up → received / handing off', () => {
    const m = stripForArchiveRow(
      arow({ status: 'uploading', upload_bytes_received: 10, upload_bytes_total: 10 }),
      opts
    )!;
    expect(m.state).toBe('received');
  });
  test('no numbers at all → just "Uploading…"', () => {
    const m = stripForArchiveRow(arow({ status: 'uploading' }), opts)!;
    expect(m.text).toBe('Uploading…');
    expect(m.progress).toBeNull();
  });
  test('transcribing folds segments + duration', () => {
    const m = stripForArchiveRow(arow({ status: 'processing', recorder_recording_id: 'r', recording_count: 6 }), opts)!;
    expect(m.state).toBe('transcribing');
    expect(m.text).toBe('Transcribing… · 6 segments · 44m 32s');
  });
  test('queued counts as transcribing', () => {
    expect(stripForArchiveRow(arow({ status: 'queued' }), opts)!.state).toBe('transcribing');
  });
  test('deferred import waiting on Google', () => {
    const m = stripForArchiveRow(
      arow({ assemblyai_id: 'defer-1', status: 'waiting', provider: 'gmeet', source: 'imported', deferred_mode: 'video' }),
      opts
    )!;
    expect(m.state).toBe('waiting');
    expect(m.text).toBe('Google is still preparing the video file · import runs itself');
  });
  test('background deferred import', () => {
    const m = stripForArchiveRow(
      arow({ assemblyai_id: 'defer-1', status: 'waiting', provider: 'teams', source: 'imported', deferred_background: 'true' }),
      opts
    )!;
    expect(m.text.startsWith('Importing in the background')).toBe(true);
  });
});

describe('stripForArchiveRow — failed', () => {
  test('ingest failure offers Retry', () => {
    const m = stripForArchiveRow(
      arow({ assemblyai_id: 'up-1', status: 'error', deferred_error: 'AssemblyAI balance negative' }),
      opts
    )!;
    expect(m.state).toBe('failed');
    expect(m.tone).toBe('err');
    expect(m.text).toBe('Upload failed — AssemblyAI balance negative');
    expect(m.action?.kind).toBe('retry');
  });
  test('a given-up deferred import has no retry', () => {
    const m = stripForArchiveRow(
      arow({ assemblyai_id: 'defer-1', status: 'error', provider: 'gmeet', source: 'imported', deferred_error: 'gave up' }),
      opts
    )!;
    expect(m.text).toBe('Import failed — gave up');
    expect(m.action).toBeNull();
  });
});

describe('provenanceTitle', () => {
  test('mentions the source, the auto state and the filename', () => {
    const t = provenanceTitle(arow({ provider: 'gmeet', source: 'imported', auto_state: 'passed', original_filename: 'Data scrum - Recording' }));
    expect(t).toContain('Google Meet');
    expect(t).toContain('without review');
    expect(t).toContain('Data scrum - Recording');
  });
});

const ref = (over: Partial<RecorderRecordingRef> = {}): RecorderRecordingRef => ({
  id: 'r1',
  mine: true,
  ownerEmail: 'alok@trames.sg',
  hostname: null,
  status: 'local',
  startedAt: '2026-09-21T03:02:54Z',
  durationS: 2671,
  transcriptId: null,
  nudgedAt: null,
  ...over,
});

describe('stripForRecorderRef', () => {
  const now = Date.parse('2026-09-21T05:00:00Z');
  test('mine, tray connected → Upload', () => {
    const m = stripForRecorderRef(ref(), { trayConnected: true, fmtDuration, now });
    expect(m.state).toBe('on-mac');
    expect(m.text).toBe('On your Mac · 44m 31s · not uploaded yet');
    expect(m.action).toMatchObject({ kind: 'upload', label: 'Upload' });
  });
  test('mine, no tray → Open Darth Recorder', () => {
    const m = stripForRecorderRef(ref(), { trayConnected: false, fmtDuration, now });
    expect(m.action?.kind).toBe('open-recorder');
  });
  test('mine, upload failed → Retry upload, err tone', () => {
    const m = stripForRecorderRef(ref({ status: 'upload_failed' }), { trayConnected: true, fmtDuration, now });
    expect(m.state).toBe('failed');
    expect(m.text).toBe('On your Mac · 44m 31s · upload failed');
    expect(m.action?.label).toBe('Retry upload');
  });
  test('a colleague’s Mac → Ask <first name> to upload', () => {
    const m = stripForRecorderRef(ref({ mine: false, ownerEmail: 'kawen.koh@trames.sg' }), { trayConnected: true, fmtDuration, now });
    expect(m.text).toBe("On Kawen's Mac · 44m 31s");
    expect(m.action).toMatchObject({ kind: 'nudge', label: 'Ask Kawen to upload' });
  });
  test('already asked → no action', () => {
    const m = stripForRecorderRef(ref({ mine: false, ownerEmail: 'kawen.koh@trames.sg' }), {
      trayConnected: true,
      fmtDuration,
      now,
      nudgedAt: '2026-09-21T04:00:00Z',
    });
    expect(m.action).toBeNull();
  });
  test('uploaded → Open transcript', () => {
    const m = stripForRecorderRef(ref({ status: 'uploaded', transcriptId: 't1' }), { trayConnected: false, fmtDuration, now });
    expect(m.state).toBe('transcribed');
    expect(m.action?.kind).toBe('open');
  });
  test('recording now vs. a stale recording', () => {
    expect(stripForRecorderRef(ref({ status: 'recording' }), { trayConnected: true, fmtDuration, now }).state).toBe('recording');
    const stale = stripForRecorderRef(ref({ status: 'recording', startedAt: '2026-09-19T03:02:54Z' }), { trayConnected: true, fmtDuration, now });
    expect(stale.state).toBe('on-mac');
    expect(stale.text).toContain('never finished');
    expect(stale.action).toBeNull();
  });
  test('uploading', () => {
    const m = stripForRecorderRef(ref({ status: 'uploading' }), { trayConnected: true, fmtDuration, now });
    expect(m.state).toBe('uploading');
    expect(m.busy).toBe(true);
  });
});

const crow = (over: Partial<CalendarStripRow> = {}): CalendarStripRow => ({
  provider: 'gmeet',
  hasMeet: true,
  hasRecording: false,
  hasTranscript: false,
  recordingCount: 0,
  recordingPreparing: false,
  transcriptPreparing: false,
  durationSecs: 973,
  recordingState: null,
  transcriptState: null,
  evidenceCheckedAt: null,
  layer: 'norec',
  ...over,
});

describe('stripForCalendarRow', () => {
  test('nothing known, never probed → no strip (the Add recording menu is the row’s action)', () => {
    expect(stripForCalendarRow(crow(), { fmtDuration, canImport: false })).toBeNull();
  });
  test('probed and empty → "Nothing at Google"', () => {
    const m = stripForCalendarRow(crow({ recordingState: 'none', transcriptState: 'none' }), { fmtDuration, canImport: false })!;
    expect(m.state).toBe('none');
    expect(m.text.startsWith('Nothing at Google')).toBe(true);
  });
  test('recording + transcript at Google → Import…', () => {
    const m = stripForCalendarRow(
      crow({ layer: 'unimported', hasRecording: true, hasTranscript: true, recordingCount: 1 }),
      { fmtDuration, canImport: true }
    )!;
    expect(m.state).toBe('cloud-available');
    expect(m.text).toBe('Recording at Google · transcript · 16m 13s');
    expect(m.action?.kind).toBe('import');
  });
  test('two recordings at Microsoft', () => {
    const m = stripForCalendarRow(
      crow({ provider: 'teams', layer: 'unimported', hasRecording: true, recordingCount: 2, durationSecs: null }),
      { fmtDuration, canImport: true }
    )!;
    expect(m.text).toBe('Recording ×2 at Microsoft');
  });
  test('preparing', () => {
    const m = stripForCalendarRow(crow({ recordingPreparing: true }), { fmtDuration, canImport: false })!;
    expect(m.state).toBe('cloud-preparing');
    expect(m.busy).toBe(true);
  });
});

/**
 * The two pure helpers behind the Recorder upload UX (docs/recorder-upload-ux.md
 * §4, P2, P5): the picker's ordering and the one sentence a mid-upload listing
 * row shows. Both must never invent a number — the 2026-09-21 bug was "uploading
 * — 77% · 12.1 MB of 15 MB" on a 696 MB, 6-part upload.
 */
import { describe, expect, test } from 'bun:test';
import {
  sortRecordingsForPicker,
  uploadProgressCopy,
  type CompanionRecording,
} from '../companion/companion-client';

const row = (over: Partial<CompanionRecording> = {}): CompanionRecording => ({
  id: 'r1',
  files: ['/a.mp4'],
  bytes: 10,
  duration: 60,
  started_at: '2026-09-21T03:02:54Z',
  call: null,
  status: 'local',
  transcript_id: null,
  error: null,
  matched: null,
  ...over,
});

describe('sortRecordingsForPicker', () => {
  test('newest first', () => {
    const rows = [
      row({ id: 'old', started_at: '2026-09-01T10:00:00Z' }),
      row({ id: 'new', started_at: '2026-09-21T10:00:00Z' }),
      row({ id: 'mid', started_at: '2026-09-10T10:00:00Z' }),
    ];
    expect(sortRecordingsForPicker(rows, {}).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  test('rows with no start time sink to the bottom, in their original order', () => {
    const rows = [
      row({ id: 'nulA', started_at: null }),
      row({ id: 'dated', started_at: '2026-09-01T10:00:00Z' }),
      row({ id: 'nulB', started_at: 'not a date' }),
    ];
    expect(sortRecordingsForPicker(rows, {}).map((r) => r.id)).toEqual(['dated', 'nulA', 'nulB']);
  });

  test('the row matched to the dialog’s event is pinned above a newer one', () => {
    const rows = [
      row({ id: 'newer', started_at: '2026-09-21T10:00:00Z' }),
      row({ id: 'mine', started_at: '2026-09-01T10:00:00Z', matched: { event_id: 'ev1' } }),
    ];
    expect(sortRecordingsForPicker(rows, { eventId: 'ev1' }).map((r) => r.id)).toEqual([
      'mine',
      'newer',
    ]);
  });

  test('older matches shape the match on `id`', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', matched: { id: 'ev1' } })];
    expect(sortRecordingsForPicker(rows, { eventId: 'ev1' })[0]!.id).toBe('b');
  });

  test('no eventId / no match → pure newest-first, input untouched', () => {
    const rows = [
      row({ id: 'a', started_at: '2026-09-01T10:00:00Z' }),
      row({ id: 'b', started_at: '2026-09-21T10:00:00Z', matched: { event_id: 'other' } }),
    ];
    const out = sortRecordingsForPicker(rows, { eventId: 'ev1' });
    expect(out.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

const MB = 1024 * 1024;

describe('uploadProgressCopy', () => {
  test('a Recorder multi-part upload says part N of M and the group bytes', () => {
    expect(
      uploadProgressCopy({
        received: 298 * MB,
        total: 696 * MB,
        partsDone: 2,
        partsTotal: 6,
        fromRecorder: true,
      })
    ).toBe('uploading from your Mac — part 3 of 6 · 298 MB of 696 MB');
  });

  test('a single file keeps the percentage', () => {
    expect(uploadProgressCopy({ received: 298 * MB, total: 696 * MB })).toBe(
      'uploading — 42% · 298 MB of 696 MB'
    );
  });

  test('an unknown total never shows a percentage', () => {
    expect(uploadProgressCopy({ received: 298 * MB, total: 0 })).toBe('uploading — 298 MB so far');
  });

  test('nothing known at all', () => {
    expect(uploadProgressCopy({})).toBe('uploading…');
    expect(uploadProgressCopy({ fromRecorder: true })).toBe('uploading from your Mac…');
  });

  test('received caught up with the total = handed off', () => {
    expect(uploadProgressCopy({ received: 696 * MB, total: 696 * MB, fromRecorder: true })).toBe(
      'upload received — handing off to transcription…'
    );
  });

  test('live companion numbers beat the server’s and are labelled', () => {
    expect(
      uploadProgressCopy({
        received: 12 * MB,
        total: 15 * MB,
        fromRecorder: true,
        partsDone: 0,
        partsTotal: 6,
        live: { pct: 43, bytesSent: 298 * MB, bytesTotal: 696 * MB },
      })
    ).toBe('uploading from your Mac — part 1 of 6 · 298 MB of 696 MB · live');
  });

  test('live pct alone still wins over a stale server total', () => {
    expect(uploadProgressCopy({ received: 0, total: 0, live: { pct: 43 } })).toBe(
      'uploading — 43% · live'
    );
  });

  test('live progress suppresses the handed-off line while bytes are still moving', () => {
    expect(
      uploadProgressCopy({
        received: 16 * MB,
        total: 16 * MB,
        live: { pct: 12, bytesSent: 80 * MB, bytesTotal: 696 * MB },
      })
    ).toBe('uploading — 12% · 80 MB of 696 MB · live');
  });

  test('a single-part group is not a "part 1 of 1"', () => {
    expect(uploadProgressCopy({ received: MB, total: 2 * MB, partsDone: 0, partsTotal: 1 })).toBe(
      'uploading — 50% · 1.0 MB of 2.0 MB'
    );
  });

  test('the last part in flight never overshoots the total', () => {
    expect(
      uploadProgressCopy({ received: 600 * MB, total: 696 * MB, partsDone: 6, partsTotal: 6, fromRecorder: true })
    ).toBe('uploading from your Mac — part 6 of 6 · 600 MB of 696 MB');
  });

  test('the caller’s byte formatter is used when given', () => {
    expect(
      uploadProgressCopy({ received: 1, total: 2, fmt: (b) => `${b}b` })
    ).toBe('uploading — 50% · 1b of 2b');
  });
});

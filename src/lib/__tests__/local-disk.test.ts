/**
 * Tray 0.3.22 `local_disk` on the web: parsing (older trays omit it), the byte labels (must
 * match the tray menu's `DiskUsage.bytesLabel`), and the Settings card line.
 */
import { describe, expect, test } from 'bun:test';
import { formatDiskBytes, localDiskLine, parseLocalDisk, type CompanionLocalDisk } from '../companion/local-disk';

const wire = {
  dir: '/Users/me/Movies/Darth Recorder',
  total_bytes: 515_012_173,
  files: 14,
  recordings: 13,
  pending_upload_bytes: 5_121_195,
  pending_upload_recordings: 6,
  kept_bytes: 5_121_195,
  uploaded_bytes: 0,
  recording_bytes: 0,
  orphan_bytes: 509_890_978,
  orphan_files: 7,
  orphans_scanned_at: '2026-10-02T02:30:00Z',
  computed_at: '2026-10-02T02:30:01Z',
};

describe('parseLocalDisk', () => {
  test('0.3.22 snapshot', () => {
    const d = parseLocalDisk(wire);
    expect(d).toEqual({
      dir: '/Users/me/Movies/Darth Recorder',
      totalBytes: 515_012_173,
      files: 14,
      recordings: 13,
      pendingUploadBytes: 5_121_195,
      pendingUploadRecordings: 6,
      keptBytes: 5_121_195,
      uploadedBytes: 0,
      recordingBytes: 0,
      orphanBytes: 509_890_978,
      orphanFiles: 7,
      computedAt: '2026-10-02T02:30:01Z',
    });
  });

  test('older tray / junk → null', () => {
    expect(parseLocalDisk(undefined)).toBeNull();
    expect(parseLocalDisk(null)).toBeNull();
    expect(parseLocalDisk('x')).toBeNull();
    expect(parseLocalDisk({ total_bytes: 1 })).toBeNull();
  });

  test('orphans not walked yet stay unknown, not 0', () => {
    const d = parseLocalDisk({ ...wire, orphan_bytes: null, orphan_files: null });
    expect(d?.orphanBytes).toBeNull();
    expect(d?.orphanFiles).toBeNull();
  });
});

describe('formatDiskBytes (same labels as the tray menu)', () => {
  test.each([
    [0, '0 B'],
    [-5, '0 B'],
    [999, '999 B'],
    [1000, '1.0 KB'],
    [5_100_000, '5.1 MB'],
    [9_960_000, '10 MB'],
    [491_000_000, '491 MB'],
    [999_600_000, '1.0 GB'],
    [1_234_000_000, '1.2 GB'],
  ])('%p → %p', (b, s) => expect(formatDiskBytes(b)).toBe(s));
});

describe('localDiskLine', () => {
  const base = parseLocalDisk(wire) as CompanionLocalDisk;
  test('with pending', () => {
    expect(localDiskLine(base)).toBe('On this Mac: 515 MB in 13 recordings · 5.1 MB waiting to upload');
  });
  test('nothing pending → clause left out', () => {
    expect(localDiskLine({ ...base, pendingUploadBytes: 0 })).toBe('On this Mac: 515 MB in 13 recordings');
  });
  test('one recording', () => {
    expect(localDiskLine({ ...base, totalBytes: 1_200_000_000, recordings: 1, pendingUploadBytes: 480_000_000 })).toBe(
      'On this Mac: 1.2 GB in 1 recording · 480 MB waiting to upload',
    );
  });
  test('empty folder', () => {
    expect(localDiskLine({ ...base, totalBytes: 0 })).toBe('On this Mac: no recordings');
  });
});

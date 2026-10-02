/**
 * Tray 0.3.22 `local_disk`: the recorder's footprint on this Mac, from every status snapshot
 * (ws) and the 5-minute heartbeat (stored verbatim in `recorder_devices.last_status`).
 * Built by `DiskUsage` in poc/mac-recorder/Sources/TrayLogic/DiskUsage.swift — see the 0.3.22
 * notes in poc/mac-recorder/README.md for the buckets. Older trays omit it.
 *
 * Pure (no React, no 'use client'): parsed by the companion client, rendered by the
 * Settings › Mac recorder card, and typed on the server row.
 */
export type CompanionLocalDisk = {
  /** The recordings folder, e.g. /Users/me/Movies/Darth Recorder. */
  dir: string;
  totalBytes: number;
  files: number;
  recordings: number;
  /** What "Upload … now" would send (local / uploading / upload_failed with files here). */
  pendingUploadBytes: number;
  pendingUploadRecordings: number;
  /** Subset of pending kept on this Mac by choice (`upload: false`). */
  keptBytes: number;
  /** Uploaded, files not purged yet (the tray drops them 1 h after upload). */
  uploadedBytes: number;
  recordingBytes: number;
  /** Files no registry row references; null until the tray has walked the folder. */
  orphanBytes: number | null;
  orphanFiles: number | null;
  computedAt: string | null;
};

/** The wire shape (snake_case), as the tray sends it. */
export type TrayLocalDisk = {
  dir: string;
  total_bytes: number;
  files: number;
  recordings?: number;
  pending_upload_bytes: number;
  pending_upload_recordings?: number;
  kept_bytes: number;
  uploaded_bytes: number;
  recording_bytes?: number;
  orphan_bytes: number | null;
  orphan_files: number | null;
  orphans_scanned_at?: string | null;
  computed_at: string | null;
};

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const nOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** null when the field is missing or not the 0.3.22 shape (older tray, junk). */
export function parseLocalDisk(v: unknown): CompanionLocalDisk | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.total_bytes !== 'number' || typeof o.dir !== 'string') return null;
  return {
    dir: o.dir,
    totalBytes: n(o.total_bytes),
    files: n(o.files),
    recordings: n(o.recordings),
    pendingUploadBytes: n(o.pending_upload_bytes),
    pendingUploadRecordings: n(o.pending_upload_recordings),
    keptBytes: n(o.kept_bytes),
    uploadedBytes: n(o.uploaded_bytes),
    recordingBytes: n(o.recording_bytes),
    orphanBytes: nOrNull(o.orphan_bytes),
    orphanFiles: nOrNull(o.orphan_files),
    computedAt: typeof o.computed_at === 'string' ? o.computed_at : null,
  };
}

/**
 * Sizes as the tray's menu prints them (1000-based like Finder, one decimal under 10):
 * "0 B", "999 B", "5.1 MB", "491 MB", "1.2 GB". Kept identical to `DiskUsage.bytesLabel`
 * so the menu and the page never disagree.
 */
export function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  if (v < 9.95) return `${(Math.round(v * 10) / 10).toFixed(1)} ${units[i]}`;
  return `${Math.round(v)} ${units[i]}`;
}

/**
 * The card's line: "On this Mac: 1.2 GB in 7 recordings · 480 MB waiting to upload".
 * The upload clause is left out at 0; nothing on disk → "On this Mac: no recordings".
 */
export function localDiskLine(d: CompanionLocalDisk): string {
  if (d.totalBytes <= 0) return 'On this Mac: no recordings';
  const count = d.recordings > 0 ? ` in ${d.recordings} recording${d.recordings === 1 ? '' : 's'}` : '';
  let s = `On this Mac: ${formatDiskBytes(d.totalBytes)}${count}`;
  if (d.pendingUploadBytes > 0) s += ` · ${formatDiskBytes(d.pendingUploadBytes)} waiting to upload`;
  return s;
}

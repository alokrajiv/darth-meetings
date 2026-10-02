import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { getStorageDir } from '@/lib/server/audio-storage';

/**
 * Where the cut renditions of clip windows live, and how a meeting's are
 * removed — split out of lib/server/clip-cut.ts so the clip WRITERS
 * (`setClipMirror` in db-ops/clips.ts, the permanent delete) can drop them
 * without importing the ffmpeg plumbing.
 *
 * `${MW_STORAGE_DIR}/clips/<meeting id>/` — one directory per meeting
 * (`transcripts.assemblyai_id`, the URL id); clip-cut.ts has the file names.
 */
export function clipCutRoot(): string {
  return path.join(getStorageDir(), 'clips');
}

/**
 * Remove every cut of one meeting. Best-effort and idempotent; an unsafe id is
 * ignored (nothing of ours can exist for it). A cut in flight that loses its
 * directory recreates it on rename — and its name still encodes the OLD
 * window, so it is never served for the new one.
 */
export async function dropClipCuts(meetingId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(meetingId)) return;
  await fsp.rm(path.join(clipCutRoot(), meetingId), { recursive: true, force: true }).catch(() => {});
}

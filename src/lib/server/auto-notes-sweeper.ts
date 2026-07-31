import 'server-only';
import { listNotesBacklog } from '@/db-ops/transcripts';
import { generateAutoNotes } from '@/lib/server/auto-notes';

/**
 * Watchdog for auto-notes: every SWEEP_MS, pick up completed transcripts
 * whose notes never ran (>10 min old — covers upload paths that skip the
 * post-transcription hook) or whose run died mid-flight (status stuck at
 * 'running' >30 min — pm2 restarts kill in-flight generations).
 *
 * Started once per server boot from instrumentation.ts. Serial, capped per
 * sweep, so a backlog drains gently instead of stampeding the model.
 */

const SWEEP_MS = 5 * 60 * 1000;
const GRACE_MINUTES = 10;
const STUCK_MINUTES = 30;
const MAX_PER_SWEEP = 2;

let started = false;

async function sweep(): Promise<void> {
  let backlog;
  try {
    backlog = await listNotesBacklog(GRACE_MINUTES, STUCK_MINUTES, MAX_PER_SWEEP);
  } catch (err) {
    console.warn('[notes-sweeper] backlog query failed:', err);
    return;
  }
  if (backlog.length === 0) return;
  console.log(
    `[notes-sweeper] picking up ${backlog.length} transcript(s):`,
    backlog.map((b) => `${b.assemblyai_id} (${b.auto_notes_status ?? 'never-ran'})`).join(', ')
  );
  for (const b of backlog) {
    try {
      // force so stuck-'running' rows regenerate; the in-flight guard inside
      // generateAutoNotes still prevents doubling up within this process.
      await generateAutoNotes(b.user_id, b.assemblyai_id, { force: true });
    } catch (err) {
      console.warn(`[notes-sweeper] ${b.assemblyai_id} failed:`, err);
    }
  }
}

export function startAutoNotesSweeper(): void {
  if (started) return;
  started = true;
  console.log(`[notes-sweeper] armed: every ${SWEEP_MS / 60000}m, grace ${GRACE_MINUTES}m`);
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  timer.unref?.();
  // First pass shortly after boot so a restart-orphaned run recovers fast.
  setTimeout(() => void sweep(), 60 * 1000).unref?.();
}

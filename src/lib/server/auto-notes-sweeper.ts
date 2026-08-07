import 'server-only';
import { listNotesBacklog, listSpeakerIdBacklog } from '@/db-ops/transcripts';
import { generateAutoNotes, identifySpeakers } from '@/lib/server/auto-notes';

/**
 * Watchdog for the AI passes. Every SWEEP_MS:
 *   - speaker-ID: pick up completed transcripts whose identification pass
 *     never ran (>10 min old — covers upload paths that skip the
 *     post-completion hook) or died mid-flight ('running' >30 min).
 *   - notes: ONLY recover runs stuck at 'running' (>30 min — pm2 restarts
 *     kill in-flight generations). Never-ran notes are NOT picked up:
 *     generation waits for a human to review speaker labels and click
 *     "confirm & generate" on the detail page, however long that takes.
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
  try {
    const idBacklog = await listSpeakerIdBacklog(GRACE_MINUTES, STUCK_MINUTES, MAX_PER_SWEEP);
    if (idBacklog.length > 0) {
      console.log(
        `[notes-sweeper] speaker-id pickup ${idBacklog.length} transcript(s):`,
        idBacklog.map((b) => `${b.assemblyai_id} (${b.speaker_id_status ?? 'never-ran'})`).join(', ')
      );
      for (const b of idBacklog) {
        try {
          // force so stuck-'running' rows re-run; the in-flight guard inside
          // identifySpeakers still prevents doubling up within this process.
          await identifySpeakers(b.user_id, b.assemblyai_id, { force: true });
        } catch (err) {
          console.warn(`[notes-sweeper] speaker-id ${b.assemblyai_id} failed:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] speaker-id backlog query failed:', err);
  }

  try {
    const backlog = await listNotesBacklog(STUCK_MINUTES, MAX_PER_SWEEP);
    if (backlog.length > 0) {
      console.log(
        `[notes-sweeper] recovering ${backlog.length} stuck notes run(s):`,
        backlog.map((b) => b.assemblyai_id).join(', ')
      );
      for (const b of backlog) {
        try {
          await generateAutoNotes(b.user_id, b.assemblyai_id, { force: true });
        } catch (err) {
          console.warn(`[notes-sweeper] ${b.assemblyai_id} failed:`, err);
        }
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] notes backlog query failed:', err);
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

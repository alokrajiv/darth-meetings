import 'server-only';
import {
  deleteForUser,
  getForUser,
  listExpiredScratch,
  listNotesBacklog,
  listSpeakerIdBacklog,
  listStaleUploads,
  softDeleteForUser,
} from '@/db-ops/transcripts';
import { deleteUploadSession, listExpiredUploadSessions } from '@/db-ops/upload-sessions';
import { uploadsStore } from '@/lib/server/darth-uploads-store';
import { deleteAudioFile, deleteAudioFilesByPrefix } from '@/lib/server/audio-storage';
import { generateAutoNotes, identifySpeakers } from '@/lib/server/auto-notes';
import { SCRATCH_TTL_DAYS } from '@/lib/format';

/**
 * Watchdog for the AI passes. Every SWEEP_MS:
 *   - speaker-ID: pick up completed transcripts whose identification pass
 *     never ran (>10 min old — covers upload paths that skip the
 *     post-completion hook) or died mid-flight ('running' >30 min).
 *   - notes: ONLY recover runs stuck at 'running' (>30 min — pm2 restarts
 *     kill in-flight generations). Never-ran notes are NOT picked up:
 *     generation waits for a human to review speaker labels and click
 *     "confirm & generate" on the detail page, however long that takes.
 *   - temporary transcripts (migration 042): soft-delete scratch rows
 *     created more than SCRATCH_TTL_DAYS ago — the same soft delete the
 *     DELETE route performs, so they land in the trash like any other row
 *     (there is no automatic purge of the trash; that stays a human click).
 *
 * Started once per server boot from instrumentation.ts. Serial, capped per
 * sweep, so a backlog drains gently instead of stampeding the model.
 */

const SWEEP_MS = 5 * 60 * 1000;
const GRACE_MINUTES = 10;
const STUCK_MINUTES = 30;
const MAX_PER_SWEEP = 2;
// Live uploads heartbeat upload_progress_at every ~2s (byte stream) or 60s
// (AAI re-upload leg); 15 quiet minutes means the handler is dead — closed
// tab, network drop, or pm2 restart. Nothing is resumable, so delete.
const UPLOAD_STALL_MINUTES = 15;
// Chunked-upload sessions are resumable: keep the partial file this long
// after the last acknowledged chunk before giving up on the user coming back.
const SESSION_IDLE_HOURS = 24;
// Temporary transcripts live SCRATCH_TTL_DAYS (lib/format — shared with the
// listing hint and the detail-page banner) from creation before they are
// moved to the trash.
const SCRATCH_PER_SWEEP = 50;

let started = false;

async function sweep(): Promise<void> {
  // Temporary transcripts past their 30 days → trash. One line per row so a
  // "where did my transcript go?" question has an answer in the pm2 log.
  try {
    const expired = await listExpiredScratch(SCRATCH_TTL_DAYS, SCRATCH_PER_SWEEP);
    for (const s of expired) {
      const trashed = await softDeleteForUser(s.user_id, s.assemblyai_id).catch((err) => {
        console.warn(`[notes-sweeper] scratch auto-trash failed ${s.assemblyai_id}:`, err);
        return false;
      });
      if (trashed) {
        console.log(
          `[notes-sweeper] auto-trashed temporary transcript ${s.assemblyai_id} (owner ${s.user_id}, created ${s.created_at})`
        );
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] scratch expiry query failed:', err);
  }

  try {
    const stale = await listStaleUploads(UPLOAD_STALL_MINUTES, 10);
    for (const s of stale) {
      console.log(`[notes-sweeper] reaping orphaned upload ${s.assemblyai_id}`);
      // Temp files share the placeholder's uuid: up-<uuid> ↔ upload-<uuid>.part
      // (plus .part2, .part3… for multi-file single-meeting groups).
      await deleteAudioFilesByPrefix(`upload-${s.assemblyai_id.slice(3)}.part`);
      await deleteForUser(s.user_id, s.assemblyai_id).catch((err) =>
        console.warn(`[notes-sweeper] stale upload delete failed ${s.assemblyai_id}:`, err)
      );
    }
  } catch (err) {
    console.warn('[notes-sweeper] stale-upload query failed:', err);
  }

  // Chunked-upload sessions: an OPEN one stays resumable for
  // SESSION_IDLE_HOURS after its last acknowledged chunk (re-drop the same
  // file → continues). Past that, or for a 'completing' one whose handler
  // died mid-ingest, reap file + session + placeholder. Done/failed audit
  // rows age out after a week (handled inside the query).
  try {
    const expired = await listExpiredUploadSessions(SESSION_IDLE_HOURS, 20);
    for (const s of expired) {
      if (s.status === 'open' || s.status === 'completing') {
        console.log(`[notes-sweeper] reaping expired upload session ${s.id} (${s.status}, ${s.via})`);
        await deleteAudioFile(s.temp_filename).catch(() => {});
        if (s.via === 'blob' && s.blob_name) {
          await uploadsStore()
            ?.delete(s.blob_name)
            .catch((err) => console.warn(`[notes-sweeper] blob delete failed ${s.id}:`, err));
        }
        const firstPart = !(s.spec?.multi && s.spec.multi.index > 1);
        if (firstPart) {
          // Only the still-uploading placeholder — never a promoted row
          // (a 'completing' session's ingest may have finished after all).
          const row = await getForUser(s.user_id, s.placeholder_id).catch(() => null);
          if (row && row.status === 'uploading') {
            await deleteAudioFilesByPrefix(`upload-${s.placeholder_id.slice(3)}.part`);
            await deleteForUser(s.user_id, s.placeholder_id).catch((err) =>
              console.warn(`[notes-sweeper] session placeholder delete failed ${s.placeholder_id}:`, err)
            );
          }
        }
      }
      await deleteUploadSession(s.id).catch(() => {});
    }
  } catch (err) {
    console.warn('[notes-sweeper] upload-session sweep failed:', err);
  }

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

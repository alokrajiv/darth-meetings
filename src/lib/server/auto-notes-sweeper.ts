import 'server-only';
import {
  deleteForUser,
  getForUser,
  listAaiDeletePending,
  listExpiredScratch,
  listNotesBacklog,
  listSpeakerIdBacklog,
  listStaleUploads,
  listStuckAtAai,
  mergeGmeetContextForUser,
  softDeleteForUser,
  listStrandedAtAai,
} from '@/db-ops/transcripts';
import { deleteAtAaiIfSafe, deleteOnCompleteEnabled } from '@/lib/server/aai-retention';
import {
  listRetranscribingMeetings,
  transcriptionVersionsEnabled,
} from '@/db-ops/transcriptions';
import { pollTargetFromRow, pollTranscriptionRun } from '@/lib/server/transcription-runs';
import { AAI_STUCK_HOURS, AAI_STUCK_REASON } from '@/lib/aai-job-state';
import { giveUpOnAaiJob } from '@/lib/server/aai-giveup';
import { refreshPendingAgainstAai } from '@/lib/server/aai-pending-refresh';
import { identityForUser } from '@/db-ops/transcript-activity';
import {
  deleteUploadSession,
  listExpiredUploadSessions,
  type UploadSessionRow,
} from '@/db-ops/upload-sessions';
import { abandonedBlobOf } from '@/lib/server/aai-from-blob';
import {
  claimedMediaBlobNames,
  mediaArchiveTablesExist,
  queueBlobDeletes,
  type ArchivedBlobRef,
} from '@/db-ops/recordings';
import type { BlobCopyIntent } from '@/lib/server/upload-pipeline';
import { uploadsStore } from '@/lib/server/darth-uploads-store';
import { deleteAudioFile, deleteAudioFilesByPrefix } from '@/lib/server/audio-storage';
import { generateAutoNotes, identifySpeakers } from '@/lib/server/auto-notes';
import { sendDarthDm } from '@/lib/server/darth-notify';
import { scratchTrashedDm } from '@/lib/server/dm-copy';
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
 *   - re-transcriptions in flight (Phase 2): a meeting can be COMPLETED and
 *     still have a NEW transcription of its own recording running. Nobody
 *     need have the page open, so this tick is the backstop — it lands the
 *     version, or gives up on it without touching the meeting.
 *   - stuck AssemblyAI jobs (DEC-4): a job AAI accepted and has been sitting
 *     on for more than AAI_STUCK_HOURS is never coming back — flip the row to
 *     'error' with a reason a human can act on. Trashed rows included (19 of
 *     the 20 stuck rows in prod on 2026-09-21 were in the trash). Rows still
 *     waiting in OUR pipeline ('uploading', 'waiting', `up-`/`defer-`/`ext-`
 *     ids) are never touched — the query only accepts real AAI job ids.
 *   - AssemblyAI retention (DEC-4): retry the delete-at-AAI for recently
 *     completed rows whose job is still there — the delete at completion is
 *     fire-and-forget and AAI can be down. Off unless
 *     MW_AAI_DELETE_ON_COMPLETE is set; the historical backlog is the job of
 *     scripts/aai-purge.ts, not of this tick.
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
// DEC-4 retry window: how far back a not-yet-deleted AAI job is still this
// sweeper's business. Anything older predates the feature (or predates the
// row being safe) and belongs to scripts/aai-purge.ts.
const AAI_DELETE_SINCE_HOURS = 72;
const AAI_DELETE_PER_SWEEP = 10;
// Give-up pass. Generous per sweep because it is a pure DB write with no
// outbound call — the prod backlog (19 rows) drains in one tick.
const AAI_STUCK_PER_SWEEP = 50;
/** Rows the resume pass finishes per 5-minute sweep. */
const AAI_RESUME_PER_SWEEP = 25;
/**
 * How long an in-flight row may go unobserved before the sweeper asks
 * AssemblyAI itself. Nothing in-process waits on a job (see
 * `listStrandedAtAai`); a short grace just lets the owner's own page do it
 * first when they are watching.
 */
const AAI_RESUME_AFTER_MS = 2 * 60_000;
// Phase 2 re-transcriptions in flight. Serial and small: each one is an
// outbound AssemblyAI call, and the listing poll + the detail sync already
// pick up anything whose page is open.
const RETRANSCRIBE_PER_SWEEP = 10;

let started = false;

/**
 * Tell the owner their temporary transcript went to the trash — once per
 * row, ever: the gmeet_context.scratchTrashDm marker is checked first and
 * stamped after, and the plagueis dedupe key backs it up. Restore clears
 * `scratch`, so a restored row can never be auto-trashed (or DM'd) twice.
 * The DM is house style (dm-copy.ts) and links to the listing's Trash tab.
 */
async function notifyScratchTrashed(ownerUserId: string, assemblyaiId: string): Promise<void> {
  if (!process.env.DARTH_APP_TOKEN) return; // notifications off — nothing to mark either
  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.gmeet_context?.scratchTrashDm) return;
  const owner = await identityForUser(ownerUserId);
  if (!owner) return; // never opened the app → no email on record
  await mergeGmeetContextForUser(
    ownerUserId,
    assemblyaiId,
    { scratchTrashDm: { at: new Date().toISOString(), to: owner.email } },
    { quiet: true }
  );
  await sendDarthDm({
    toEmail: owner.email,
    text: scratchTrashedDm({
      title: row.title?.trim() || row.original_filename?.trim() || 'Untitled meeting',
      when: row.recorded_at ?? row.created_at,
      duration: row.duration,
      speakerCount: row.speaker_count,
    }),
    dedupeKey: `mw-scratch-trash:${assemblyaiId}:${owner.email}`,
  });
}

/**
 * DEC-3 Stage C's one leak, closed (`docs/recordings-blob-spec.md`).
 *
 * An upload session that took the fast path stamps a `blobIntent` on itself
 * before Azure copies the transit blob into the PERMANENT media container, and
 * clears it once the row that names the blob exists. A session that dies in
 * between — a pm2 restart mid-ingest, which is what leaves one stuck at
 * `completing` — used to strand those bytes: nothing knew the name any more,
 * and finding them again meant listing the whole container.
 *
 * So, as these sessions are reaped: ask `recording_media` which of the
 * intended blobs a live row actually claims (a session that completed normally
 * has one, and those bytes are the recording — never touch them), and enqueue
 * the rest into `media_blob_deletes`, which the media sweeper drains with
 * retries. Intent-free sessions — every chunk session, every pull-path
 * session — cost one nothing: no intents, no query.
 */
async function queueAbandonedStageCBlobs(expired: UploadSessionRow[]): Promise<void> {
  const intents = expired
    .map((s) => s.spec?.blobIntent)
    .filter((i): i is BlobCopyIntent => !!i?.blobName);
  if (intents.length === 0) return;
  const claimed = await claimedMediaBlobNames(intents.map((i) => i.blobName));
  const leaked: ArchivedBlobRef[] = [];
  for (const s of expired) {
    const abandoned = abandonedBlobOf({ intent: s.spec?.blobIntent, claimed });
    if (!abandoned) continue;
    console.warn(
      `[notes-sweeper] upload session ${s.id} (${s.status}) died before anything named ` +
        `${abandoned.blobName} (copy intended ${abandoned.at}) — queueing that blob for deletion`
    );
    leaked.push({
      blob_name: abandoned.blobName,
      recording_id: abandoned.recordingId,
      media_id: abandoned.mediaId,
    });
  }
  if (leaked.length === 0) return;
  if (!(await mediaArchiveTablesExist().catch(() => false))) {
    console.warn(
      `[notes-sweeper] migrations/047 is not applied — ${leaked.length} abandoned Stage C blob(s) ` +
        'cannot be queued for deletion'
    );
    return;
  }
  const queued = await queueBlobDeletes(leaked).catch((err) => {
    console.warn('[notes-sweeper] queueing abandoned Stage C blobs failed:', err);
    return 0;
  });
  if (queued > 0) console.log(`[notes-sweeper] ${queued} abandoned Stage C blob(s) queued for deletion`);
}

/**
 * Chunked-upload sessions: an OPEN one stays resumable for
 * SESSION_IDLE_HOURS after its last acknowledged chunk (re-drop the same
 * file -> continues). Past that, or for a 'completing' one whose handler died
 * mid-ingest, reap file + session + placeholder. Done/failed audit rows age
 * out after a week (handled inside the query).
 *
 * Exported so the Stage C integration check can drive the real reaper rather
 * than a copy of it; the sweep tick is still the only caller in the server.
 */
export async function sweepExpiredUploadSessions(): Promise<void> {
  const expired = await listExpiredUploadSessions(SESSION_IDLE_HOURS, 20);
  await queueAbandonedStageCBlobs(expired);
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
}

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
        await notifyScratchTrashed(s.user_id, s.assemblyai_id).catch((err) =>
          console.warn(`[notes-sweeper] scratch auto-trash DM failed ${s.assemblyai_id}:`, err)
        );
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] scratch expiry query failed:', err);
  }

  // Nothing in-process waits on a job at AssemblyAI (see `listStrandedAtAai`):
  // a row completes when its owner's page polls it, or here. Finish every
  // unobserved in-flight row — same code path as the listing's refresh, so
  // completion stores the payload, mirrors the graph and fires the
  // post-completion hook (idempotent; it claims its own work). Bounded by
  // AAI_STUCK_HOURS like the listing.
  try {
    const stranded = await listStrandedAtAai(AAI_RESUME_AFTER_MS, AAI_RESUME_PER_SWEEP);
    if (stranded.length > 0) {
      const before = new Map(stranded.map((r) => [r.assemblyai_id, r.status]));
      await refreshPendingAgainstAai(stranded);
      for (const r of stranded) {
        const was = before.get(r.assemblyai_id);
        if (r.status !== was) {
          console.log(
            `[notes-sweeper] resumed AssemblyAI job ${r.aai_job_id} (meeting ${r.assemblyai_id}): ${was} → ${r.status}`
          );
        }
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] resume-at-AAI pass failed:', err);
  }

  // DEC-4: jobs AssemblyAI accepted and never finished. No outbound call —
  // asking AAI again is exactly what we are stopping. One log line per row so
  // "why did my transcript fail?" has an answer in the pm2 log.
  try {
    const stuck = await listStuckAtAai(AAI_STUCK_HOURS, AAI_STUCK_PER_SWEEP);
    for (const s of stuck) {
      const flipped = await giveUpOnAaiJob(s.user_id, s.assemblyai_id, AAI_STUCK_REASON, s);
      if (flipped) {
        console.log(
          `[notes-sweeper] gave up on AssemblyAI job ${s.aai_job_id} (meeting ${s.assemblyai_id}) ` +
            `(waiting since ${s.waiting_since}${s.deleted_at ? ', trashed' : ''}` +
            `${s.local_audio_path ? '' : ', no stored media'})`
        );
      }
    }
  } catch (err) {
    console.warn('[notes-sweeper] stuck-AAI query failed:', err);
  }

  // Phase 2: new transcriptions of a meeting's own recording. Nobody has to
  // have the page open for one to land — this is the backstop behind the
  // listing poll and the detail sync, and the only observer for a run whose
  // owner closed the tab. `pollTranscriptionRun` also owns the give-up: a run
  // AssemblyAI 404s or sits on past six hours is marked failed and the MEETING
  // is left exactly as it was.
  try {
    if (await transcriptionVersionsEnabled()) {
      const runs = await listRetranscribingMeetings(RETRANSCRIBE_PER_SWEEP);
      for (const r of runs) await pollTranscriptionRun(pollTargetFromRow(r));
    }
  } catch (err) {
    console.warn('[notes-sweeper] re-transcription poll failed:', err);
  }

  // DEC-4: jobs that should already be gone from AssemblyAI. deleteAtAaiIfSafe
  // re-verifies each row itself, so this query only has to narrow the field.
  if (deleteOnCompleteEnabled()) {
    try {
      // The query already dropped rows with no job (Phase 1b: the meeting id
      // no longer says whether there is one); `deleteAtAaiIfSafe` re-reads the
      // row and takes the job id off it again.
      const pending = await listAaiDeletePending(AAI_DELETE_SINCE_HOURS, AAI_DELETE_PER_SWEEP);
      for (const p of pending) {
        await deleteAtAaiIfSafe(p.user_id, p.assemblyai_id, p.utterances).catch((err) =>
          console.warn(`[notes-sweeper] AAI delete retry ${p.aai_job_id} failed:`, err)
        );
      }
    } catch (err) {
      console.warn('[notes-sweeper] AAI delete backlog query failed:', err);
    }
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

  try {
    await sweepExpiredUploadSessions();
  } catch (err) {
    console.warn('[notes-sweeper] upload-session sweep failed:', err);
  }

  // Design P7/P8: standalone recordings — temporary ones past their expiry,
  // stalled uploads, jobs still at AssemblyAI, kept hand-off failures, the
  // one ready DM. A no-op until migration 049 is applied; never throws.
  try {
    const { sweepBornBare } = await import('@/lib/server/born-bare');
    await sweepBornBare();
  } catch (err) {
    console.warn('[notes-sweeper] standalone-recording sweep failed:', err);
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

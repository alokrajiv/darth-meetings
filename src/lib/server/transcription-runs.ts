import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  applyActivatePlan,
  claimRetranscribeMarker,
  clearRetranscribeMarker,
  completeRunTranscription,
  failRunTranscription,
  insertRunTranscription,
  listTranscriptionVersions,
  loadActivateFacts,
  meetingCopyCount,
  meetingRecordingRef,
  setRetranscribeMarkerJob,
  setRunJobId,
  transcriptionVersionsEnabled,
  type MeetingRecordingRef,
  type RetranscribingRow,
} from '@/db-ops/transcriptions';
import { getForUser } from '@/db-ops/transcripts';
import { planActivate } from '@/lib/transcription-activate';
import {
  sameTranscriptionSettings,
  type RunningTranscription,
  type TranscriptionLanguageChoice,
  type TranscriptionVersion,
} from '@/lib/transcriptions';
import type { SpeechModel } from '@/lib/aai-language';
import { decideRunPoll, type RunPollObservation } from '@/lib/transcription-run-state';
import { getTranscript, isAaiNotFound, submitTranscription, uploadFile } from '@/lib/server/assemblyai';
import { vocabForSubmit } from '@/lib/server/ingest';
import { audioFileSize, resolveAudioPath } from '@/lib/server/audio-storage';
import { rematerialiseMeetingsOnRecording } from '@/lib/server/clip-materialise';
import {
  alignMeetingsToTranscription,
  listMeetingsOnRecording,
  type MeetingOnRecording,
} from '@/db-ops/clips';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { queueRecordingGraphSync } from '@/lib/server/recording-sync';
import type { StoredTranscript } from '@/lib/format';

/**
 * "Transcribe this meeting again" — the Phase 2 run lifecycle
 * (docs/recordings-phase2-spec.md "Flow").
 *
 * The promise this file keeps: **the meeting is never touched until a new
 * version is ready to replace the old one.** While a run is in flight the row
 * stays `completed`, `imported_content` is still the current version, and the
 * only sign of the run is `gmeet_context.retranscribing`. A run that fails,
 * that AssemblyAI 404s, or that never comes back leaves the meeting exactly as
 * it was and records the reason on the TRANSCRIPTION, where the Sources card
 * reads it.
 *
 * Three entry points:
 *   startTranscriptionRun  — POST …/retranscribe, version mode
 *   pollTranscriptionRun   — the listing poll, the detail sync, the sweeper
 *   activateTranscription  — POST …/transcriptions/:tid/activate, and the
 *                            poller when a run completes
 *
 * Everything here assumes the CALLER has already gated on the meeting
 * (`resolveAccess`, editors for the two writes) — none of these functions
 * applies an access rule of its own (feedback_privacy_caller_scoping_gate).
 */

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export interface StartRunInput {
  row: StoredTranscript;
  /** Always the meeting's OWNER: the satellite tables are owner-keyed. */
  ownerUserId: string;
  by: { userId: string; email: string | null; name: string | null };
  speechModel: SpeechModel;
  languageCode: TranscriptionLanguageChoice;
  reason: string | null;
  force: boolean;
}

export type StartRunResult =
  /** Phase 2 cannot serve this meeting — the caller runs the old new-row path. */
  | { kind: 'unavailable'; why: string }
  | { kind: 'started'; transcriptionId: string; running: RunningTranscription }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

function runningFrom(marker: NonNullable<StoredTranscript['gmeet_context']>['retranscribing']): RunningTranscription | null {
  if (!marker) return null;
  return {
    transcriptionId: marker.transcriptionId,
    startedAt: marker.startedAt,
    by: marker.by,
    speechModel: marker.speechModel,
    languageCode: marker.languageCode,
  };
}

/**
 * Submit the meeting's own recording to AssemblyAI again, as a NEW version of
 * the same meeting.
 *
 * Returns as soon as the run is claimed (the route answers 202): the
 * AssemblyAI upload leg of a multi-GB video runs in the background, exactly as
 * the first transcription's did.
 */
export async function startTranscriptionRun(input: StartRunInput): Promise<StartRunResult> {
  const { row, ownerUserId } = input;
  if (!(await transcriptionVersionsEnabled())) {
    return { kind: 'unavailable', why: 'flag or migrations off' };
  }

  // Preconditions, cheapest first.
  if (row.deleted_at) {
    return { kind: 'refused', status: 409, body: { error: 'This meeting is in the trash.' } };
  }
  const running = runningFrom(row.gmeet_context?.retranscribing);
  if (running) {
    return {
      kind: 'refused',
      status: 409,
      body: { error: 'A new transcription is already running for this meeting.', running },
    };
  }
  if (row.status !== 'completed' && row.status !== 'error') {
    return {
      kind: 'refused',
      status: 409,
      body: { error: 'This meeting is still being transcribed.' },
    };
  }
  if (!row.local_audio_path) {
    return {
      kind: 'refused',
      status: 422,
      body: { error: 'No stored recording for this meeting — nothing to re-run.' },
    };
  }
  const bytes = await audioFileSize(row.local_audio_path);
  if (bytes === null) {
    return {
      kind: 'refused',
      status: 422,
      body: { error: 'The stored recording is missing on disk.' },
    };
  }

  // Spec §7: the ONE legacy pair of meetings that share an AssemblyAI job.
  // Both rows are called by the job id, only one of them holds the bytes, and
  // a version switch rewrites `imported_content` on ONE of them — the other
  // would silently keep showing the old text under the same id. Refuse
  // outright rather than half-serve it.
  if ((await meetingCopyCount(row.assemblyai_id)) > 1) {
    return {
      kind: 'refused',
      status: 409,
      body: {
        error:
          'This meeting shares its transcription with another person’s copy of the same call, ' +
          'so it cannot be transcribed again. Upload the recording as a new meeting instead.',
      },
    };
  }

  // The recording, by its clip. No clip = the graph has never been written for
  // this meeting (backfill not run yet) and Phase 2 has nothing to hang a
  // version on — the caller falls back to today's new-row behaviour.
  const ref = await meetingRecordingRef(row.id);
  if (!ref) return { kind: 'unavailable', why: 'no clip' };
  if (ref.clips !== 1) return { kind: 'unavailable', why: `${ref.clips} clips` };

  // "Asking again would reproduce what you are reading" — legitimate on
  // purpose (a flaky job, a model that has changed under the same name), so it
  // is a confirm, not a refusal.
  if (!input.force) {
    const versions = await listTranscriptionVersions(ref.recordingId, ref.activeTranscriptionId);
    const active = versions.find((v) => v.active) ?? null;
    if (sameTranscriptionSettings(active, { speechModel: input.speechModel, languageCode: input.languageCode })) {
      return {
        kind: 'refused',
        status: 409,
        body: {
          error: 'That is the same model and language as the version you are reading.',
          sameSettings: true,
        },
      };
    }
  }

  const transcriptionId = randomUUID();
  const startedAt = new Date().toISOString();
  const marker = {
    transcriptionId,
    jobId: null,
    startedAt,
    by: { email: input.by.email, name: input.by.name },
    speechModel: input.speechModel,
    languageCode: input.languageCode,
  };
  // Atomic claim: two "Transcribe again" clicks, in two processes, cannot both
  // get past this (the UPDATE only fires when no marker is there).
  if (!(await claimRetranscribeMarker(ownerUserId, row.assemblyai_id, marker))) {
    const fresh = await getForUser(ownerUserId, row.assemblyai_id);
    return {
      kind: 'refused',
      status: 409,
      body: {
        error: 'A new transcription is already running for this meeting.',
        running: runningFrom(fresh?.gmeet_context?.retranscribing) ?? undefined,
      },
    };
  }

  try {
    await insertRunTranscription({
      id: transcriptionId,
      recordingId: ref.recordingId,
      providerJobId: null,
      speechModel: input.speechModel,
      languageCode: input.languageCode === 'auto' ? null : input.languageCode,
      // One recording = one job (DEC-1); the job hears the canonical file.
      coversMedia: [],
      requested: {
        by: input.by,
        at: startedAt,
        speechModel: input.speechModel,
        languageCode: input.languageCode,
        reason: input.reason,
      },
    });
  } catch (err) {
    await clearRetranscribeMarker(ownerUserId, row.assemblyai_id, transcriptionId).catch(() => {});
    console.error(`[transcription-run] ${row.assemblyai_id}: could not open the run:`, err);
    return { kind: 'refused', status: 500, body: { error: 'Could not start the re-transcription.' } };
  }

  void submitInBackground(input, transcriptionId, row.local_audio_path);

  return {
    kind: 'started',
    transcriptionId,
    running: {
      transcriptionId,
      startedAt,
      by: { email: input.by.email, name: input.by.name },
      speechModel: input.speechModel,
      languageCode: input.languageCode,
    },
  };
}

/**
 * The AssemblyAI hand-off, off the request's critical path. The bytes are
 * already on our disk and stay there: `uploadFile` streams the STORED file, so
 * unlike the pre-Phase-2 flow nothing is hard-linked, copied or renamed.
 */
async function submitInBackground(
  input: StartRunInput,
  transcriptionId: string,
  storedFilename: string
): Promise<void> {
  const { row, ownerUserId } = input;
  try {
    const languageCode = input.languageCode === 'auto' ? undefined : input.languageCode;
    const { keytermsPrompt, customSpelling } = await vocabForSubmit(ownerUserId);
    const audioUrl = await uploadFile(resolveAudioPath(storedFilename));
    // 'auto' = `language_detection: true` plus the documented model fallback
    // list (`speechModelsRequest`, inside submitTranscription). That IS the
    // code-switching configuration docs/eval-aai-code-switching-2026-09-21.md
    // arrives at: every explicit `language_detection_options.code_switching` /
    // `language_codes` probe was byte-identical to plain detection, and naming
    // the fallback is what makes a Universal-2 downgrade deliberate.
    const submitted = await submitTranscription(audioUrl, {
      languageCode,
      keytermsPrompt,
      customSpelling,
      model: input.speechModel,
    });
    await setRunJobId(transcriptionId, submitted.id, submitted.model);
    await setRetranscribeMarkerJob(ownerUserId, row.assemblyai_id, transcriptionId, submitted.id);
    console.log(
      `[transcription-run] ${row.assemblyai_id}: version ${transcriptionId} submitted as ${submitted.id} ` +
        `(${submitted.model}, ${input.languageCode})`
    );
  } catch (err) {
    console.error(`[transcription-run] ${row.assemblyai_id}: hand-off failed:`, err);
    // The MEETING is untouched — only the version says it failed.
    // The raw exception stays in the server log above. What is stored is
    // shown to every reader of the meeting, read-only collaborators included,
    // so it must not carry whatever the SDK or our config checks put in
    // `message` (URLs, request ids, env-var names).
    await failRunTranscription(
      transcriptionId,
      'The recording could not be sent to AssemblyAI. Nothing changed — try again in a few minutes.'
    ).catch(
      () => {}
    );
    await clearRetranscribeMarker(ownerUserId, row.assemblyai_id, transcriptionId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Observing a run
// ---------------------------------------------------------------------------

/** The columns a poller needs; both a full row and a thin listing row fit. */
export interface RunPollRow {
  id: number;
  user_id: string;
  assemblyai_id: string;
  transcriptionId: string;
  jobId: string;
  startedAt: string | null;
}

// globalThis, not module scope: Next bundles this module once per route graph,
// and the listing poll, the detail sync and the sweeper must not all ask
// AssemblyAI about the same job at once.
const g = globalThis as unknown as { __mwTranscriptionRunPolls?: Map<string, Promise<void>> };
const inflight = (g.__mwTranscriptionRunPolls ??= new Map<string, Promise<void>>());

/** A `listRetranscribing*` row as a poll target (the SQL already proved the
 * job id is there). */
export function pollTargetFromRow(r: RetranscribingRow): RunPollRow {
  return {
    id: r.id,
    user_id: r.user_id,
    assemblyai_id: r.assemblyai_id,
    transcriptionId: r.transcription_id,
    jobId: r.job_id,
    startedAt: r.started_at ?? null,
  };
}

/** `gmeet_context.retranscribing` as a poll target, or null. */
export function runPollTarget(row: {
  id: number;
  user_id: string;
  assemblyai_id: string;
  gmeet_context: StoredTranscript['gmeet_context'];
}): RunPollRow | null {
  const m = row.gmeet_context?.retranscribing;
  if (!m?.jobId || !m.transcriptionId) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    assemblyai_id: row.assemblyai_id,
    transcriptionId: m.transcriptionId,
    jobId: m.jobId,
    startedAt: m.startedAt ?? null,
  };
}

/**
 * Ask AssemblyAI how the run is going, and act once.
 *
 * Never throws. Four outcomes: still running (nothing happens), completed (the
 * payload is stored and the version is activated), failed/404 (the version is
 * marked, the meeting is untouched), stuck past six hours (same).
 */
export function pollTranscriptionRun(target: RunPollRow): Promise<void> {
  const key = target.transcriptionId;
  const previous = inflight.get(key);
  if (previous) return previous;
  const run = pollOnce(target)
    .catch((err) => console.warn(`[transcription-run] poll ${target.assemblyai_id} failed:`, err))
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

async function endRun(target: RunPollRow, reason: string): Promise<void> {
  await failRunTranscription(target.transcriptionId, reason);
  await clearRetranscribeMarker(target.user_id, target.assemblyai_id, target.transcriptionId);
  console.warn(
    `[transcription-run] ${target.assemblyai_id}: version ${target.transcriptionId} failed — ${reason}` +
      ' (the meeting is unchanged)'
  );
}

async function pollOnce(target: RunPollRow): Promise<void> {
  // One ask, then the decision table (lib/transcription-run-state, pure).
  let aai: Awaited<ReturnType<typeof getTranscript>> | null = null;
  let observed: RunPollObservation;
  try {
    aai = await getTranscript(target.jobId);
    observed = {
      outcome: aai.status,
      error: aai.error ?? null,
      startedAt: target.startedAt,
      now: Date.now(),
    };
  } catch (err) {
    if (!isAaiNotFound(err)) {
      console.warn(`[transcription-run] ${target.assemblyai_id}: poll error:`, err);
    }
    observed = {
      outcome: isAaiNotFound(err) ? 'not-found' : 'unreachable',
      startedAt: target.startedAt,
      now: Date.now(),
    };
  }

  const decision = decideRunPoll(observed);
  if (decision.kind === 'wait') return;
  if (decision.kind === 'fail') return endRun(target, decision.reason);
  if (!aai) return; // unreachable: 'activate' only ever follows a real answer

  // The payload is stored in the SAME write that says 'completed' (DEC-4: this
  // is the last time we ever see it), and only then does the meeting move.
  await completeRunTranscription(target.transcriptionId, aai);
  const outcome = await activateTranscription({
    ownerUserId: target.user_id,
    assemblyaiId: target.assemblyai_id,
    targetTranscriptionId: target.transcriptionId,
    observedUtterances: aai.utterances?.length ?? null,
  });
  if (!outcome.ok) {
    // The version is complete and readable; it just is not live. Leave it in
    // the list rather than pretending it failed.
    console.warn(
      `[transcription-run] ${target.assemblyai_id}: version ${target.transcriptionId} completed but ` +
        `could not be activated — ${outcome.error}`
    );
    await clearRetranscribeMarker(target.user_id, target.assemblyai_id, target.transcriptionId);
    return;
  }
  console.log(
    `[transcription-run] ${target.assemblyai_id}: version ${target.transcriptionId} is live ` +
      `(${outcome.setAside.edits} edit(s) and ${outcome.setAside.speakerNames} name(s) set aside)`
  );
}

// ---------------------------------------------------------------------------
// Switching versions
// ---------------------------------------------------------------------------


/**
 * Align every meeting on the recording to the version that has just gone
 * live, and hand back the ones that are NOT the meeting being activated (the
 * caller queues their graph syncs). Never throws: a version that is live must
 * not be rolled back because a sibling's bookkeeping failed.
 */
async function alignAndListMeetings(
  recordingId: string,
  transcriptionId: string,
  self: { id: number }
): Promise<MeetingOnRecording[]> {
  try {
    await alignMeetingsToTranscription(recordingId, transcriptionId);
    const all = await listMeetingsOnRecording(recordingId);
    return all.filter((m) => m.transcript_id !== self.id);
  } catch (err) {
    console.warn(`[transcription-run] sibling alignment on ${recordingId} failed:`, err);
    return [];
  }
}

export type ActivateOutcome =
  | {
      ok: true;
      activeId: string;
      setAside: { edits: number; speakerNames: number };
      restored: { edits: number; speakerNames: number };
    }
  | { ok: false; status: number; error: string };

/**
 * Make `targetTranscriptionId` the version the meeting shows.
 *
 * One mechanism for both "the re-run finished" and "switch back to the older
 * version" — the difference is entirely inside `planActivate`, which decides
 * what is archived, what comes back, and whether this version has ever been
 * read before (`brandNew`: only then do the speaker passes re-run and the
 * "ready" DM fire).
 */
export async function activateTranscription(input: {
  ownerUserId: string;
  assemblyaiId: string;
  targetTranscriptionId: string;
  /** What the completing poll counted, for the DEC-4 delete's safety check. */
  observedUtterances?: number | null;
}): Promise<ActivateOutcome> {
  const row = await getForUser(input.ownerUserId, input.assemblyaiId);
  if (!row) return { ok: false, status: 404, error: 'Not found' };

  const ref = await meetingRecordingRef(row.id);
  if (!ref) return { ok: false, status: 409, error: 'This meeting has no recording to switch versions on.' };

  const facts = await loadActivateFacts(
    row.id,
    row.assemblyai_id,
    ref.recordingId,
    ref.activeTranscriptionId,
    input.targetTranscriptionId
  );
  if (!facts.target) {
    return { ok: false, status: 404, error: 'That version does not belong to this meeting.' };
  }

  const decision = planActivate({
    transcriptId: row.id,
    current: facts.current,
    target: facts.target,
    live: facts.live,
    archived: facts.archived,
    hasNotes: facts.hasNotes,
    hasReport: facts.hasReport,
    notesStale: row.gmeet_context?.notesStale ?? null,
    now: new Date().toISOString(),
  });
  if (!decision.ok) {
    return { ok: false, status: decision.alreadyActive ? 409 : 409, error: decision.error };
  }

  await applyActivatePlan(decision, { assemblyaiId: row.assemblyai_id });

  // Phase 3a: a version swap re-materialises EVERY meeting with a clip on
  // this recording — their windows stay, their text updates
  // (docs/recordings-phase3-clips-spec.md "Model"). This meeting included:
  // the plan above copied the WHOLE payload onto the row, which is right for
  // an un-clipped meeting and wrong for a clipped one, and this is what puts
  // its window back. Un-clipped meetings are skipped inside, so the 1:1 case
  // — every row on prod — costs one cheap query and no write.
  await rematerialiseMeetingsOnRecording(ref.recordingId, 'activate').catch((err) =>
    console.warn(`[transcription-run] ${row.assemblyai_id}: re-materialise after activate failed:`, err)
  );

  // Phase 3a again, and the half that is easy to miss: a run can be started
  // from ANY meeting on the recording, including one that only holds a window
  // of it. The OTHER meetings now show the new text, so their rows must also
  // name the new job, model and language — otherwise the graph derived from
  // the meeting that OWNS the recording would describe a transcription that
  // is not the active one, and DEC-4 retention would still hold the old job.
  const siblings = await alignAndListMeetings(ref.recordingId, decision.activeTranscriptionId, row);

  // The dual-write re-derives the meeting's graph from the row it has just
  // been given — with the recording's new active pointer as an input, so it
  // targets the version that is now live instead of re-deriving the one the
  // meeting was born with (lib/recording-graph.ts `GraphTableFacts`).
  queueRecordingGraphSync(input.ownerUserId, row.assemblyai_id, 'transcription-activate');
  // …and the same for every other meeting on the recording. A borrower's sync
  // writes its clips and stops; the owner's re-derives the transcription row
  // (its `covers`, its job id) from the row that has just been aligned.
  for (const s of siblings) {
    queueRecordingGraphSync(s.user_id, s.assemblyai_id, 'transcription-activate/sibling');
  }

  if (decision.brandNew) {
    // A new diarization space: the speaker suggestions and the ID pass have to
    // run again, the review gate applies again (the plan cleared
    // `speaker_id_status`), and the DEC-4 delete takes the NEW job off
    // AssemblyAI. Summary and report are NOT regenerated — `notesStale` says
    // so on the page instead (spec Flow 4).
    onTranscriptCompleted(input.ownerUserId, row.assemblyai_id, {
      utterances: input.observedUtterances ?? null,
      transcriptionId: decision.activeTranscriptionId,
    });
  }

  return {
    ok: true,
    activeId: decision.activeTranscriptionId,
    setAside: decision.setAside,
    restored: decision.restored,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface MeetingVersions {
  ref: MeetingRecordingRef;
  versions: TranscriptionVersion[];
}

/**
 * INTERNAL (gate on the meeting first) — the versions of a meeting's
 * recording, or null when Phase 2 has nothing to show for it.
 */
export async function meetingTranscriptionVersions(
  transcriptId: number
): Promise<MeetingVersions | null> {
  const ref = await meetingRecordingRef(transcriptId);
  if (!ref) return null;
  const versions = await listTranscriptionVersions(ref.recordingId, ref.activeTranscriptionId);
  return { ref, versions };
}

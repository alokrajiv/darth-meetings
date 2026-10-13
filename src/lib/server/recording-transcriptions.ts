import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  completeRunTranscription,
  failRunTranscription,
  insertRecordingRun,
  listRecordingRunsInFlight,
  listTranscriptionVersions,
  recordingCanonicalMedia,
  recordingHasMeeting,
  recordingRunInFlight,
  setRecordingActiveTranscription,
  setRunJobId,
  transcriptionVersionsEnabled,
  type RecordingRunRow,
  type RunRequest,
} from '@/db-ops/transcriptions';
import {
  getStandalone,
  getStandaloneForOwner,
  meetingsHoldingRecording,
  standaloneColumnsExist,
  type StandaloneRecordingRow,
} from '@/db-ops/standalone-recordings';
import { submitLanguageFor, type SpeechModel } from '@/lib/aai-language';
import { decideRunPoll, type RunPollObservation } from '@/lib/transcription-run-state';
import {
  sameTranscriptionSettings,
  type RunningTranscription,
  type TranscriptionLanguageChoice,
  type TranscriptionRunMode,
  type TranscriptionsResponse,
} from '@/lib/transcriptions';
import type { MergeOptions } from '@/lib/transcript-merge';
import { getTranscript, isAaiNotFound, submitTranscription, uploadFile } from '@/lib/server/assemblyai';
import { vocabForSubmit } from '@/lib/server/ingest';
import { storedFileSource, withHeldStoredFiles } from '@/lib/server/stored-media';
import { deleteRunJobAtAai, mergeFromLandedRun } from '@/lib/server/transcription-runs';

/**
 * Versions of a recording that belongs to NO meeting
 * (docs/transcription-merge-spec.md §3c) — the bare recordings of design P7,
 * which live in their owner's Recordings and nowhere else.
 *
 * The same three run modes as a meeting's (replace / helper / merge), with
 * one structural difference: there is no meeting row, so
 *  - nothing carries a `retranscribing` marker — the run is found by its own
 *    `requested.scope = 'recording'` stamp, and the conditional insert in
 *    `insertRecordingRun` is the double-start guard;
 *  - "activate" is the recording's `active_transcription_id` and nothing
 *    else: no edits or speaker names exist without a meeting.
 *
 * Once a meeting holds the recording, writes belong to the MEETING's routes
 * (a switch there moves the meeting's annotations) — every write here
 * refuses, and a run already in flight when the meeting was made lands as a
 * version without being switched to.
 *
 * PRIVACY: every entry point takes a recording the caller has been proven to
 * OWN (`getStandaloneForOwner`) — owner-only, 404 for anyone else, never 403
 * (invariant I2). Nothing here applies a gate of its own.
 */

/** The first meeting holding the recording that the caller can open, or null. */
export async function meetingHoldingRecordingId(
  rec: Pick<StandaloneRecordingRow, 'id'>,
  caller: { userId: string; email: string }
): Promise<string | null> {
  const meetings = await meetingsHoldingRecording(rec.id, caller).catch(() => []);
  return meetings.find((m) => !m.trashed)?.assemblyai_id ?? meetings[0]?.assemblyai_id ?? null;
}

/** 409 body for a write on a recording a meeting holds. */
export function inMeetingRefusal(meetingId: string | null): { error: string; meetingId: string | null } {
  return {
    error:
      'This recording is part of a meeting — use the meeting’s routes: switching versions there moves ' +
      'the meeting’s edits and speaker names with it.',
    meetingId,
  };
}

function runningFromRow(row: RecordingRunRow | null): RunningTranscription | null {
  if (!row) return null;
  const r = row.requested;
  return {
    transcriptionId: row.transcription_id,
    startedAt: r?.at ?? row.created_at,
    by: { email: r?.by?.email ?? null, name: r?.by?.name ?? null },
    speechModel: r?.speechModel ?? '',
    languageCode: r?.languageCode ?? 'auto',
    ...(r?.mode ? { mode: r.mode } : {}),
  };
}

/** `GET /api/recordings/:id/transcriptions` — the meeting route's shape. */
export async function recordingTranscriptions(
  rec: StandaloneRecordingRow,
  inMeeting: boolean
): Promise<TranscriptionsResponse> {
  if (!(await transcriptionVersionsEnabled())) {
    return { versioned: false, canEdit: false, running: null, versions: [], notesStale: null };
  }
  // A run in flight is asked about once before answering — the sweeper is
  // the backstop, but `transcribe-again --wait` should not have to sit out
  // a five-minute tick to see it land.
  let inFlight = await recordingRunInFlight(rec.id);
  if (inFlight?.provider_job_id) {
    await pollRecordingRun(inFlight);
    inFlight = await recordingRunInFlight(rec.id);
  }
  // The pointer may have moved during the poll; re-read it from the versions.
  const versions = await listTranscriptionVersions(rec.id, await activeIdOf(rec));
  return {
    versioned: true,
    canEdit: !inMeeting,
    running: runningFromRow(inFlight),
    versions,
    notesStale: null,
  };
}

async function activeIdOf(rec: StandaloneRecordingRow): Promise<string | null> {
  return (await getStandalone(rec.id))?.active_transcription_id ?? rec.active_transcription_id;
}

// ---------------------------------------------------------------------------
// Starting a run
// ---------------------------------------------------------------------------

export interface StartRecordingRunInput {
  rec: StandaloneRecordingRow;
  by: { userId: string; email: string | null; name: string | null };
  speechModel: SpeechModel;
  languageCode: TranscriptionLanguageChoice;
  reason: string | null;
  force: boolean;
  mode: TranscriptionRunMode;
  mergeOptions: MergeOptions;
}

export type StartRecordingRunResult =
  | { kind: 'started'; transcriptionId: string; running: RunningTranscription }
  | { kind: 'refused'; status: number; body: Record<string, unknown> };

/**
 * `POST /api/recordings/:id/transcribe`. The caller has checked ownership and
 * that no meeting holds the recording. Returns as soon as the run row is
 * written; the AssemblyAI hand-off runs in the background, as for a meeting.
 */
export async function startRecordingRun(input: StartRecordingRunInput): Promise<StartRecordingRunResult> {
  const { rec } = input;
  const refuse = (status: number, body: Record<string, unknown>): StartRecordingRunResult => ({
    kind: 'refused',
    status,
    body,
  });

  const running = runningFromRow(await recordingRunInFlight(rec.id));
  if (running) return refuse(409, { error: 'A new transcription is already running for this recording.', running });

  const versions = await listTranscriptionVersions(rec.id, rec.active_transcription_id, { health: false });
  const active = versions.find((v) => v.active) ?? null;
  // The recording's own first transcription is born-bare's to finish.
  if (active?.status === 'processing' || (!active && rec.active_transcription_id)) {
    return refuse(409, { error: 'This recording is still being transcribed.' });
  }
  if (input.mode === 'merge' && active?.status !== 'completed') {
    return refuse(409, { error: 'This recording has no completed transcription to merge the new one with.' });
  }

  const canonical = await recordingCanonicalMedia(rec.id);
  const source = canonical?.filename ? await storedFileSource(canonical.filename) : null;
  if (!canonical?.filename || !source?.held) {
    return refuse(422, { error: 'The stored recording is missing — nothing to re-run.' });
  }

  const lang = submitLanguageFor(input.languageCode, input.speechModel);
  if (
    !input.force &&
    sameTranscriptionSettings(active, { speechModel: lang.model, languageCode: input.languageCode })
  ) {
    return refuse(409, {
      error: 'That is the same model and language as the version you are reading.',
      sameSettings: true,
    });
  }

  const transcriptionId = randomUUID();
  const at = new Date().toISOString();
  const requested: RunRequest = {
    by: input.by,
    at,
    speechModel: lang.model,
    languageCode: input.languageCode,
    reason: input.reason,
    mode: input.mode,
    ...(input.mode === 'merge'
      ? { mergeBase: rec.active_transcription_id, mergeOptions: input.mergeOptions }
      : {}),
    scope: 'recording',
  };
  const opened = await insertRecordingRun({
    id: transcriptionId,
    recordingId: rec.id,
    speechModel: lang.model,
    languageCode: lang.languageCode ?? null,
    requested,
  });
  if (!opened) {
    return refuse(409, {
      error: 'A new transcription is already running for this recording.',
      running: runningFromRow(await recordingRunInFlight(rec.id)) ?? undefined,
    });
  }

  void submitRecordingRun(rec, transcriptionId, canonical.filename, input.languageCode, lang.model);

  return {
    kind: 'started',
    transcriptionId,
    running: {
      transcriptionId,
      startedAt: at,
      by: { email: input.by.email, name: input.by.name },
      speechModel: lang.model,
      languageCode: input.languageCode,
      mode: input.mode,
    },
  };
}

/** The AssemblyAI hand-off, off the request's critical path (cf. `submitInBackground`). */
async function submitRecordingRun(
  rec: StandaloneRecordingRow,
  transcriptionId: string,
  canonicalFilename: string,
  languageChoice: TranscriptionLanguageChoice,
  model: SpeechModel
): Promise<void> {
  try {
    const lang = submitLanguageFor(languageChoice, model);
    const { keytermsPrompt, customSpelling } = await vocabForSubmit(rec.owner_user_id);
    // HELD for the whole upload so Stage D cannot evict it mid-stream; a
    // media-cache copy when the local one is gone.
    const source = await storedFileSource(canonicalFilename);
    const uploaded = await withHeldStoredFiles([source.media], 'canonical', 'recording re-run', ([local]) =>
      uploadFile(local!.path)
    );
    if (!uploaded.ok) throw new Error(`stored recording ${canonicalFilename} could not be read locally or from the archive`);
    const submitted = await submitTranscription(uploaded.value, {
      languageCode: lang.languageCode,
      expectedLanguages: lang.expectedLanguages,
      keytermsPrompt,
      customSpelling,
      model: lang.model,
    });
    await setRunJobId(transcriptionId, submitted.id, submitted.model);
    console.log(
      `[recording-run] ${rec.id}: version ${transcriptionId} submitted as ${submitted.id} ` +
        `(${submitted.model}, ${languageChoice})`
    );
  } catch (err) {
    console.error(`[recording-run] ${rec.id}: hand-off failed:`, err);
    // Shown to the owner only, but kept free of SDK detail all the same.
    await failRunTranscription(
      transcriptionId,
      'The recording could not be sent to AssemblyAI. Nothing changed — try again in a few minutes.'
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Observing a run
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __mwRecordingRunPolls?: Map<string, Promise<void>> };
const inflight = (g.__mwRecordingRunPolls ??= new Map<string, Promise<void>>());

/**
 * Ask AssemblyAI about a recording-scoped run once and act (never throws,
 * one poll per run at a time across the route and the sweeper). The decision
 * table is the meeting runs' (`decideRunPoll`); what "activate" means is the
 * run's mode.
 */
export function pollRecordingRun(row: RecordingRunRow): Promise<void> {
  const key = row.transcription_id;
  const previous = inflight.get(key);
  if (previous) return previous;
  const run = pollRecordingRunOnce(row)
    .catch((err) => console.warn(`[recording-run] poll ${row.recording_id} failed:`, err))
    .finally(() => {
      if (inflight.get(key) === run) inflight.delete(key);
    });
  inflight.set(key, run);
  return run;
}

async function pollRecordingRunOnce(row: RecordingRunRow): Promise<void> {
  if (!row.provider_job_id) return;
  const startedAt = row.requested?.at ?? row.created_at;
  let aai: Awaited<ReturnType<typeof getTranscript>> | null = null;
  let observed: RunPollObservation;
  try {
    aai = await getTranscript(row.provider_job_id);
    observed = { outcome: aai.status, error: aai.error ?? null, startedAt, now: Date.now() };
  } catch (err) {
    if (!isAaiNotFound(err)) console.warn(`[recording-run] ${row.recording_id}: poll error:`, err);
    observed = { outcome: isAaiNotFound(err) ? 'not-found' : 'unreachable', startedAt, now: Date.now() };
  }

  const decision = decideRunPoll(observed);
  if (decision.kind === 'wait') return;
  if (decision.kind === 'fail') {
    await failRunTranscription(row.transcription_id, decision.reason);
    console.warn(`[recording-run] ${row.recording_id}: version ${row.transcription_id} failed — ${decision.reason}`);
    return;
  }
  if (!aai) return;

  await completeRunTranscription(row.transcription_id, aai);
  // DEC-4: whatever the mode, the payload is ours now.
  await deleteRunJobAtAai(row.transcription_id, row.provider_job_id, aai.utterances?.length ?? 0);

  const mode: TranscriptionRunMode = row.requested?.mode ?? 'replace';
  // Made into a meeting while the job ran: the meeting's routes own the
  // switch now. The version (and, for a merge, the merged version) is still
  // written so the meeting's Versions list can offer it.
  const inMeeting = await recordingHasMeeting(row.recording_id);

  let target: string | null = null;
  if (mode === 'replace') {
    target = row.transcription_id;
  } else if (mode === 'merge') {
    const merged = await mergeFromLandedRun({
      recordingId: row.recording_id,
      runId: row.transcription_id,
      requested: row.requested,
    }).catch((err) => {
      console.warn(`[recording-run] ${row.recording_id}: merge failed:`, err);
      return { ok: false as const, why: 'the merge threw (see the error above)' };
    });
    if (merged.ok) target = merged.mergedId;
    else console.warn(`[recording-run] ${row.recording_id}: merge not done — ${merged.why}; kept as helper`);
  }

  if (!target || inMeeting) {
    console.log(
      `[recording-run] ${row.recording_id}: version ${row.transcription_id} completed — ` +
        (inMeeting && target ? 'a meeting holds the recording now, not switched' : 'kept as helper')
    );
    return;
  }
  const switched = await setRecordingActiveTranscription(row.recording_id, target);
  console.log(
    `[recording-run] ${row.recording_id}: ${target} ${switched ? 'is live' : 'could not be made live'} ` +
      `(run ${row.transcription_id}, mode ${mode})`
  );
}

/** The 5-minute backstop (called from the notes sweeper). Never throws. */
export async function sweepRecordingRuns(limit = 10): Promise<void> {
  try {
    if (!(await transcriptionVersionsEnabled())) return;
    for (const r of await listRecordingRunsInFlight(limit)) await pollRecordingRun(r);
  } catch (err) {
    console.warn('[recording-run] sweep failed:', err);
  }
}

// ---------------------------------------------------------------------------
// The routes' shared gate
// ---------------------------------------------------------------------------

/**
 * The recording, when the caller OWNS it — the same gate as
 * `/api/recordings/:id` (049 present, `getStandaloneForOwner`). null = the
 * route answers 404, whatever the reason (invariant I2: never 403, never an
 * existence oracle).
 */
export async function ownedRecording(
  userId: string,
  id: string | undefined
): Promise<StandaloneRecordingRow | null> {
  if (!(await standaloneColumnsExist().catch(() => false))) return null;
  return getStandaloneForOwner(userId, id ?? '');
}

/**
 * Write-route preconditions after the gate: versions available, no meeting
 * holding the recording. Returns the refusal to send, or null to proceed.
 */
export async function writeRefusal(
  rec: StandaloneRecordingRow,
  caller: { userId: string; email: string }
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (!(await transcriptionVersionsEnabled())) {
    return { status: 409, body: { error: 'Transcription versions are not available on this server.' } };
  }
  if (await recordingHasMeeting(rec.id)) {
    return { status: 409, body: inMeetingRefusal(await meetingHoldingRecordingId(rec, caller)) };
  }
  return null;
}

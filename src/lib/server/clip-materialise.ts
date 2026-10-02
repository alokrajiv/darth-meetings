import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import {
  compareClipsOnTimeline,
  isClipTextPolicy,
  resolveClips,
  type ClipTextPolicy,
  type ResolvableClip,
} from '@/lib/recording-clips';
import { meetingSpanFromDurations, type ClipWindow } from '@/lib/clips';
import {
  loadMeetingRecordingGraph,
  type MeetingRecordingGraph,
  type RecordingTranscriptionRow,
} from '@/db-ops/recordings';
import { setMaterialisedContentForUser } from '@/db-ops/transcripts';
import type { TranscriptResponse } from '@/lib/format';

/**
 * `materialiseMeeting` — ONE function that turns a meeting's clips into the
 * text on its row (docs/recordings-phase3-clips-spec.md "Model").
 *
 * The Phase 1 rule is that the meeting ROW is what every reader reads:
 * `/content`, the detail page, darth-cli, deep search, the AI prompts, an
 * offline replica. A meeting that uses only a window of a recording therefore has
 * to carry the resolved result of that window in `imported_content` like any
 * other meeting — which is what this does, and why it is called from exactly
 * three places:
 *
 *   - a SPLIT (both halves),
 *   - an UN-SPLIT (the source, which gets the window back),
 *   - `activate()` of a transcription version on the recording — a version
 *     swap re-materialises EVERY meeting with a clip on it: their windows
 *     stay, their text updates.
 *
 * It reads the RECORDING's transcription payload, never the row's own
 * `imported_content` — materialising from an already-materialised copy would
 * lose a little more of the recording on every pass. For the same reason
 * `deriveRecordingGraph` refuses to copy a clipped row's payload back onto the
 * transcription (`wholeRecording`).
 *
 * Deliberately flag-free: it reads `meeting_clips` directly rather than going
 * through `resolveMeetingContent`, because the row it writes has to be right
 * whether or not `MW_RECORDINGS` is serving from the tables.
 */

export interface MaterialiseResult {
  /** False = nothing to do (the meeting has no clips, or has the default
   * whole-recording clip and is already exactly its transcription). */
  written: boolean;
  utterances: number;
  durationSec: number | null;
  speakerCount: number | null;
  reason?: string;
}

/** The clip rows as the pure layer wants them. */
export function clipWindowsOf(
  clips: Array<{
    ord: number;
    recording_id: string;
    from_ms: number;
    to_ms: number | null;
    offset_ms: number;
    text_policy?: string;
  }>
): ClipWindow[] {
  return clips
    .map((c) => ({
      ord: c.ord,
      recordingId: c.recording_id,
      fromMs: c.from_ms,
      toMs: c.to_ms,
      offsetMs: c.offset_ms,
      textPolicy: policyOf(c.text_policy),
    }))
    .sort((a, b) => compareClipsOnTimeline(a, b));
}

/** A clip row's policy, defaulting to `include` (what every 3a clip is). */
export function policyOf(raw: string | null | undefined): ClipTextPolicy {
  return isClipTextPolicy(raw) ? raw : 'include';
}

/** The transcription a clip reads: its own, else the recording's active one. */
function transcriptionFor(
  graph: MeetingRecordingGraph,
  recordingId: string,
  explicitId: string | null
): RecordingTranscriptionRow | null {
  const mine = graph.transcriptions.filter((t) => t.recording_id === recordingId);
  if (explicitId) return mine.find((t) => t.id === explicitId) ?? null;
  const active = graph.recordings.find((r) => r.id === recordingId)?.active_transcription_id;
  if (active) {
    const hit = mine.find((t) => t.id === active);
    if (hit) return hit;
  }
  return mine.find((t) => t.status === 'completed') ?? mine[0] ?? null;
}

/** Distinct diarized speakers in a payload. */
function speakerCountOf(content: TranscriptResponse | null): number | null {
  const utterances = content?.utterances ?? [];
  if (utterances.length === 0) return null;
  return new Set(utterances.map((u) => u.speaker)).size;
}

/**
 * Compute what a meeting's row should say, without writing it. Exported so a
 * caller that is already inside its own sequence (the split) can write the
 * clips and the text in one go, and so it can be checked in isolation.
 */
export async function materialisedFacts(transcriptId: number): Promise<{
  content: TranscriptResponse | null;
  durationSec: number | null;
  speakerCount: number | null;
  spanMs: number;
  clips: ClipWindow[];
} | null> {
  const graph = await loadMeetingRecordingGraph(transcriptId);
  if (graph.clips.length === 0) return null;

  const row = await rowFacts(transcriptId);
  if (!row) return null;

  // Phase 3b: the clip's OWN policy, not a hardcoded `include`. A `gap_fill`
  // clip that materialised as `include` would double up every word both mics
  // caught — the exact failure the SI-BL merge was built to avoid.
  const resolvable: ResolvableClip[] = graph.clips.map((c) => ({
    ord: c.ord,
    recordingId: c.recording_id,
    fromMs: c.from_ms,
    toMs: c.to_ms,
    offsetMs: c.offset_ms,
    textPolicy: policyOf(c.text_policy),
    payload: transcriptionFor(graph, c.recording_id, c.transcription_id)?.payload ?? null,
  }));

  const resolved = resolveClips(resolvable, {
    id: row.assemblyaiId,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  });

  const windows = clipWindowsOf(graph.clips);
  // A clip that runs "to the end" needs the length of ITS OWN recording to say
  // how long the meeting is — Phase 3b: a 5-minute phone clip beside a 5-hour
  // Teams video must not inherit the video's length. The transcription's last
  // word is the fallback when the recording never recorded one.
  const durationOf = (recordingId: string): number | null => {
    const stated = graph.recordings.find((r) => r.id === recordingId)?.duration_ms ?? null;
    if (stated != null && stated > 0) return stated;
    const heard = Math.max(
      0,
      ...resolvable
        .filter((c) => c.recordingId === recordingId)
        .map((c) => Math.max(0, ...(c.payload?.utterances ?? []).map((u) => u.end)))
    );
    return heard > 0 ? heard : null;
  };
  const spanMs = meetingSpanFromDurations(windows, durationOf);

  return {
    content: resolved.content,
    // `transcripts.duration` is an INTEGER of seconds — the same unit every
    // reader and darth-cli have always seen. A fractional value is rejected
    // by Postgres outright, so the rounding happens here, once.
    durationSec: spanMs > 0 ? Math.round(spanMs / 1000) : null,
    speakerCount: speakerCountOf(resolved.content),
    spanMs,
    clips: windows,
  };
}

interface RowFacts {
  userId: string;
  assemblyaiId: string;
  createdAt: string;
  completedAt: string | null;
  /** True = the row carries clip windows, so materialising it is meaningful. */
  clipped: boolean;
}

async function rowFacts(transcriptId: number): Promise<RowFacts | null> {
  const rows = await sql<
    Array<{
      user_id: string;
      assemblyai_id: string;
      created_at: Date | string;
      completed_at: Date | string | null;
      clipped: boolean;
    }>
  >`
    SELECT user_id, assemblyai_id, created_at, completed_at,
           (gmeet_context ? 'clips') AS clipped
    FROM ${sql(SCHEMAS.MEETING_WHISPERER)}.transcripts
    WHERE id = ${transcriptId}
  `;
  const row = rows[0];
  if (!row) return null;
  const iso = (v: Date | string | null) =>
    v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return {
    userId: row.user_id,
    assemblyaiId: row.assemblyai_id,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    completedAt: iso(row.completed_at),
    clipped: row.clipped === true,
  };
}

/**
 * Write the materialised text onto the meeting's row.
 *
 * A meeting whose row declares NO clip windows is left alone: its
 * `imported_content` is already its recording's transcription verbatim, and
 * rewriting it through the resolver would be a no-op that costs a megabyte of
 * jsonb per call.
 *
 * `recordedAt` is the caller's business (the split moves the new meeting's
 * anchor to `recording.started_at + from`); this never guesses it.
 */
export async function materialiseMeeting(
  transcriptId: number,
  opts: { recordedAt?: Date | null; force?: boolean } = {}
): Promise<MaterialiseResult> {
  const row = await rowFacts(transcriptId);
  if (!row) return { written: false, utterances: 0, durationSec: null, speakerCount: null, reason: 'no row' };
  if (!row.clipped && !opts.force) {
    return {
      written: false,
      utterances: 0,
      durationSec: null,
      speakerCount: null,
      reason: 'not clipped',
    };
  }

  const facts = await materialisedFacts(transcriptId);
  if (!facts) {
    return { written: false, utterances: 0, durationSec: null, speakerCount: null, reason: 'no clips' };
  }

  await setMaterialisedContentForUser(row.userId, row.assemblyaiId, {
    content: facts.content,
    durationSec: facts.durationSec,
    speakerCount: facts.speakerCount,
    ...(opts.recordedAt !== undefined ? { recordedAt: opts.recordedAt } : {}),
  });

  return {
    written: true,
    utterances: facts.content?.utterances?.length ?? 0,
    durationSec: facts.durationSec,
    speakerCount: facts.speakerCount,
  };
}

/**
 * Every meeting with a clip on this recording gets its text rebuilt — what a
 * transcription VERSION SWAP has to do (spec "Model": their windows stay,
 * their text updates).
 *
 * Trashed meetings are included on purpose: a restore must not bring back text
 * from a version the recording no longer reads. Un-clipped meetings are
 * skipped by `materialiseMeeting` itself, so the 1:1 case — every row on prod
 * — costs one cheap query and no write.
 */
export async function rematerialiseMeetingsOnRecording(
  recordingId: string,
  tag: string
): Promise<number> {
  const rows = await sql<Array<{ transcript_id: number }>>`
    SELECT DISTINCT c.transcript_id
    FROM ${sql(SCHEMAS.MEETING_WHISPERER)}.meeting_clips c
    JOIN ${sql(SCHEMAS.MEETING_WHISPERER)}.transcripts t ON t.id = c.transcript_id
    WHERE c.recording_id = ${recordingId}::uuid
      AND t.gmeet_context ? 'clips'
  `;
  let written = 0;
  for (const r of rows) {
    try {
      const out = await materialiseMeeting(r.transcript_id);
      if (out.written) written += 1;
    } catch (err) {
      console.warn(`[clips] ${tag}: re-materialise of meeting ${r.transcript_id} failed:`, err);
    }
  }
  if (written > 0) {
    console.log(`[clips] ${tag}: re-materialised ${written} clipped meeting(s) on ${recordingId}`);
  }
  return written;
}

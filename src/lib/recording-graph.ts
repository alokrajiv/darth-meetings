/**
 * The derivation rules: what recording / media / transcription / clip rows a
 * `transcripts` row IS (docs/recordings-phase1-spec.md §2 + §5a).
 *
 * ONE set of rules, two callers: `scripts/recordings-backfill.ts` (the
 * one-off pass over prod) and `src/lib/server/recording-sync.ts` (the
 * dual-write every writer fires after it touches a row). They must agree
 * exactly or the backfill and the app would fight over the same rows, so the
 * arithmetic lives here and nowhere else — the same reasoning that put the
 * part offsets in `lib/part-offsets.ts`.
 *
 * Pure on purpose: no `server-only`, no db, no fs (`node:crypto` only, for
 * the uuidv5). File facts (bytes on disk, which derivatives exist) are
 * PASSED IN, so the backfill can stat the VM's storage dir, the sync can
 * stat its own, and a unit test or the read-only verifier can pass nothing
 * at all.
 *
 * Ids are uuidv5 of what the row IS, so every caller computes the same ids
 * and a re-run converges. Two meetings holding the same AssemblyAI job
 * (landmine #14) derive the SAME recording id and collapse onto one
 * recording with two clips.
 */

import { createHash } from 'node:crypto';
import type { GmeetContext } from '@/lib/format';
import { videoPartOffsets } from '@/lib/part-offsets';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** uuidv5(DNS, 'recordings.meetings.darth-internal.trames.io'). */
export const RECORDING_NAMESPACE = '914c7e92-21a5-5ff9-a8f3-6288554ba588';

/**
 * uuidv5 without a dependency: sha1(namespace bytes ‖ name), version 5,
 * RFC 4122 variant. Node's `crypto` is available in every caller (bun, the
 * Next server, the scripts) and `createHash` is the only import this module
 * needs.
 */
export function uuidv5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const recordingIdFor = (canonicalKey: string) =>
  uuidv5(RECORDING_NAMESPACE, `rec:${canonicalKey}`);
export const mediaIdFor = (recordingId: string, kind: string, ord: number) =>
  uuidv5(RECORDING_NAMESPACE, `media:${recordingId}:${kind}:${ord}`);
export const transcriptionIdFor = (recordingId: string) =>
  uuidv5(RECORDING_NAMESPACE, `txn:${recordingId}:0`);

// ---------------------------------------------------------------------------
// The row this module derives from
// ---------------------------------------------------------------------------

/**
 * The columns the rules read. `TranscriptRow` satisfies it structurally, and
 * so does the backfill's thin projection — neither needs `imported_content`
 * itself (the payload is copied inside Postgres, never through JS), only
 * whether there IS one.
 */
export interface GraphMeetingRow {
  /** `transcripts.id` — the int family. Clips key on this; it survives a
   * placeholder promotion, which `assemblyai_id` does not. */
  id: number;
  user_id: string;
  assemblyai_id: string;
  original_filename: string | null;
  status: string;
  created_at: string | Date;
  completed_at: string | Date | null;
  duration: number | null;
  language_code: string | null;
  speech_model: string | null;
  local_audio_path: string | null;
  deleted_at: string | Date | null;
  gmeet_context: GmeetContext | null;
  has_content: boolean;
  /** `recorder_recordings.id` found by the reverse link (`transcript_id`) or
   * by the `gmeet_context.recorder` marker. NULL = not a tray recording. */
  recorder_recording_id?: string | null;
  /** `recorder_recordings.started_at` — §5a's fallback anchor. */
  recorder_started_at?: string | Date | null;
}

/**
 * Every stored file a meeting's recording owns: the canonical plus the Meet
 * parts whose bytes we hold. The one list both the backfill and the sync
 * stat, so the file facts they hand back describe the same files.
 */
export function recordingFilenames(row: GraphMeetingRow): string[] {
  return [
    row.local_audio_path,
    ...videoPartOffsets(row.gmeet_context).map((p) => p.filename ?? null),
  ].filter((n): n is string => !!n);
}

/**
 * What is on disk, when the caller bothered to look. `undefined` (not
 * probed) and "probed, nothing there" are different answers: the first leaves
 * derivative rows alone, the second says there are none.
 */
export interface GraphFileFacts {
  /** stored basename → bytes (null = present, size unreadable). */
  audio: Map<string, number | null>;
  /** `audio-only/<stem>.m4a` stems present → bytes. */
  audioOnly: Map<string, number | null>;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const AAI_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC = /^(gmeet-|teams-|ext-|up-|defer-)/;

/** A real AssemblyAI job id, not one of our synthetic ones. */
export const isRealAaiId = (id: string) => AAI_ID.test(id) && !SYNTHETIC.test(id);

export type GraphSourceKind = 'recorder' | 'upload' | 'meet' | 'teams' | 'text' | 'aai-import';
export type GraphProvider = 'assemblyai' | 'meet-doc' | 'teams-vtt' | 'text';
export type GraphTranscriptionStatus = 'processing' | 'completed' | 'error';

/**
 * Where the bytes came from. Two additions to the spec's prefix-first rule,
 * both because the prefix alone under-reports on prod (§5a):
 *  - `recorder` is decided by the marker OR the reverse link
 *    (`recorder_recordings.transcript_id`). On prod 43 meetings came from the
 *    tray but only 4 carry `gmeet_context.recorder`.
 *  - a Meet/Teams VIDEO import carries a REAL AssemblyAI id (only the
 *    transcript-Doc / VTT imports get a `gmeet-`/`teams-` id), so without the
 *    `gmeet_context` checks 208 Meet meetings would be filed as uploads.
 */
export function sourceKindOf(row: GraphMeetingRow): GraphSourceKind {
  const g = row.gmeet_context;
  if (g?.recorder || row.recorder_recording_id) return 'recorder';
  const id = row.assemblyai_id;
  if (id.startsWith('gmeet-')) return 'meet';
  if (id.startsWith('teams-')) return 'teams';
  if (id.startsWith('ext-')) return 'text';
  if (g?.provider === 'teams' || g?.teams) return 'teams';
  if (g?.videoFileId || g?.meetingCode || g?.actuals) return 'meet';
  // Imported from AssemblyAI by id: a real job, no bytes of ours, no
  // conferencing context. (All 35 such rows on prod are source='imported'.)
  if (isRealAaiId(id) && !row.local_audio_path && !g) return 'aai-import';
  return 'upload';
}

export function providerOf(row: GraphMeetingRow): GraphProvider {
  const id = row.assemblyai_id;
  if (id.startsWith('gmeet-')) return 'meet-doc';
  if (id.startsWith('teams-')) return 'teams-vtt';
  if (id.startsWith('ext-')) return 'text';
  return 'assemblyai';
}

export function transcriptionStatusOf(row: GraphMeetingRow): GraphTranscriptionStatus {
  if (row.status === 'completed') return 'completed';
  if (row.status === 'error') return 'error';
  return 'processing';
}

/**
 * The key two meetings must share to collapse onto one recording.
 *
 * A real AssemblyAI job is the key, so the two-owner copies of one Meet call
 * land on one recording. Everything else keys on `transcripts.id` — the
 * DOCUMENT's identity, which (unlike `assemblyai_id` + user id, the shape
 * spec §2 sketched) survives both a placeholder promotion and an ownership
 * transfer. A promotion still moves the key from the `t…` form to the job id;
 * `applyRecordingGraph` migrates the clip and drops the placeholder's
 * recording rather than leaving two.
 */
export function canonicalKeyOf(row: GraphMeetingRow): string {
  return isRealAaiId(row.assemblyai_id) ? row.assemblyai_id : `t${row.id}`;
}

/** Placeholders with nothing behind them: no payload, no bytes, no job. */
export function skipReason(row: GraphMeetingRow): string | null {
  const placeholder = row.assemblyai_id.startsWith('up-') || row.assemblyai_id.startsWith('defer-');
  if (placeholder && !row.has_content && !row.local_audio_path) {
    return `placeholder (${row.assemblyai_id.split('-')[0]}-) with no payload and no media`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The desired graph
// ---------------------------------------------------------------------------

export type GraphMediaKind = 'canonical' | 'part' | 'audio_only' | 'faststart';

export interface DesiredMedia {
  id: string;
  kind: GraphMediaKind;
  ord: number;
  offsetMs: number | null;
  durationMs: number | null;
  filename: string | null;
  bytes: number | null;
  hasVideo: boolean | null;
  sourceRef: Record<string, unknown> | null;
  ofMediaId: string | null;
}

export interface DesiredRecording {
  id: string;
  ownerUserId: string;
  sourceKind: GraphSourceKind;
  startedAt: string | null;
  durationMs: number | null;
  recorderRecordingId: string | null;
}

export interface DesiredTranscription {
  id: string;
  provider: GraphProvider;
  providerJobId: string | null;
  speechModel: string | null;
  languageCode: string | null;
  status: GraphTranscriptionStatus;
  covers: { media: string[]; timeline: 'wall' | 'concat' };
}

/** The clip a Phase 1 meeting takes: the whole recording, in place. */
export interface DesiredClip {
  transcriptId: number;
  ord: number;
  transcriptionId: null;
  fromMs: number;
  toMs: null;
  offsetMs: number;
  textPolicy: 'include';
}

export interface DesiredGraph {
  canonicalKey: string;
  recording: DesiredRecording;
  media: DesiredMedia[];
  transcription: DesiredTranscription;
  /** `transcripts.id` whose `imported_content` is the transcription payload —
   * copied in SQL, never through JS (spec §2.3). */
  payloadFromTranscriptId: number;
  /** True = the caller passed file facts, so derivative rows are authoritative
   * and a stale `audio_only` row may be deleted. */
  filesProbed: boolean;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;

const stemOf = (filename: string) => filename.replace(/\.[^./]+$/, '');

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The clip every Phase 1 meeting gets: `(ord 0, from 0, to NULL, offset 0,
 * include)` — the 1:1 case the resolver serves in compat mode.
 */
export function desiredClipFor(transcriptId: number): DesiredClip {
  return {
    transcriptId,
    ord: 0,
    transcriptionId: null,
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    textPolicy: 'include',
  };
}

/**
 * Derive the recording, its files and its transcription from the meeting row
 * that OWNS them (the earliest `created_at` of a shared AssemblyAI job —
 * `ownerRowOf` below). A meeting that merely references the recording
 * contributes nothing but its clip.
 */
export function deriveRecordingGraph(
  ownerRow: GraphMeetingRow,
  files?: GraphFileFacts
): DesiredGraph {
  const g = ownerRow.gmeet_context;
  const canonicalKey = canonicalKeyOf(ownerRow);
  const recordingId = recordingIdFor(canonicalKey);
  const durationMs = ownerRow.duration != null ? Math.round(ownerRow.duration * 1000) : null;

  // A concat row's canonical file is a DERIVATIVE of its parts, not a capture
  // of its own — the listing's recording_count leans on this stamp.
  const uploadedParts = g?.uploadedParts ?? [];
  const combinedParts = typeof g?.combinedParts === 'number' ? g.combinedParts : 0;
  const isConcat = uploadedParts.length > 0 || combinedParts > 0;

  const media: DesiredMedia[] = [];
  const audioOnlyFor = (of: DesiredMedia, ord: number): DesiredMedia | null => {
    if (!files || !of.filename) return null;
    const stem = stemOf(of.filename);
    if (!files.audioOnly.has(stem)) return null;
    return {
      id: mediaIdFor(recordingId, 'audio_only', ord),
      kind: 'audio_only',
      ord,
      offsetMs: of.offsetMs,
      durationMs: of.durationMs,
      filename: `${stem}.m4a`,
      bytes: files.audioOnly.get(stem) ?? null,
      hasVideo: false,
      sourceRef: null,
      ofMediaId: of.id,
    };
  };

  let canonical: DesiredMedia | null = null;
  if (ownerRow.local_audio_path) {
    canonical = {
      id: mediaIdFor(recordingId, 'canonical', 0),
      kind: 'canonical',
      ord: 0,
      offsetMs: 0,
      durationMs,
      filename: ownerRow.local_audio_path,
      bytes: files?.audio.get(ownerRow.local_audio_path) ?? null,
      hasVideo: VIDEO_EXT.test(ownerRow.local_audio_path),
      sourceRef: {
        ...(g?.videoFileId ? { driveFileId: g.videoFileId } : {}),
        ...(g?.teams?.recordingId ? { teamsRecordingId: g.teams.recordingId } : {}),
        ...(ownerRow.original_filename ? { originalFilename: ownerRow.original_filename } : {}),
        ...(isConcat ? { derived: 'concat' } : {}),
      },
      ofMediaId: null,
    };
    media.push(canonical);
  }

  // The parts. Today's listing takes GREATEST of the three jsonb shapes, so
  // the longest list is the one that describes the capture; a row carrying
  // two of them at once does not exist in prod but would not be double
  // counted here either.
  const fromVideoParts = videoPartOffsets(g).map((p, i) => ({
    ord: i,
    offsetMs: p.offsetSec != null ? Math.round(p.offsetSec * 1000) : null,
    durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
    filename: p.filename ?? null,
    sourceRef: { driveFileId: (g?.videoParts ?? [])[i]?.fileId ?? null } as Record<string, unknown>,
  }));
  const fromUploaded = [...uploadedParts]
    .sort((a, b) => a.index - b.index)
    .map((p, i) => ({
      ord: i,
      offsetMs: p.offsetSec != null ? Math.round(p.offsetSec * 1000) : null,
      durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
      // The stitch consumed the source temp files; only their offsets survive.
      filename: null as string | null,
      sourceRef: {
        ...(p.originalFilename ? { originalFilename: p.originalFilename } : {}),
        ...(p.comment ? { comment: p.comment } : {}),
      } as Record<string, unknown>,
    }));
  const fromCombined = Array.from({ length: combinedParts }, (_, i) => ({
    ord: i,
    offsetMs: null as number | null,
    durationMs: null as number | null,
    filename: null as string | null,
    // combinedParts is only a COUNT in gmeet_context — no filenames, no
    // offsets survived the combine. The rows exist so the meeting still says
    // "N recordings"; Phase 3 fills the windows in.
    sourceRef: { combined: true } as Record<string, unknown>,
  }));
  const parts = [fromVideoParts, fromUploaded, fromCombined].sort((a, b) => b.length - a.length)[0]!;
  const partRows: DesiredMedia[] = parts.map((p) => ({
    id: mediaIdFor(recordingId, 'part', p.ord),
    kind: 'part' as const,
    ord: p.ord,
    offsetMs: p.offsetMs,
    durationMs: p.durationMs,
    filename: p.filename,
    bytes: p.filename ? (files?.audio.get(p.filename) ?? null) : null,
    hasVideo: p.filename ? VIDEO_EXT.test(p.filename) : null,
    sourceRef: p.sourceRef,
    ofMediaId: null,
  }));
  media.push(...partRows);

  // Rebuildable 64 kbps extracts, one per file that has one on disk. The
  // faststart remux has NO row: `ensureFaststart` rewrites the source in
  // place, so there is no second file to point at (see recording-sync.ts).
  if (canonical) {
    const ao = audioOnlyFor(canonical, 0);
    if (ao) media.push(ao);
  }
  for (const p of partRows) {
    const ao = audioOnlyFor(p, p.ord + 1);
    if (ao) media.push(ao);
  }

  const covers = {
    // A concat job heard its parts through the concat; a wall-time job heard
    // only the primary — which is why a Meet stop/restart part shows the
    // "not transcribed" warning today.
    media: isConcat
      ? [...(canonical ? [canonical.id] : []), ...partRows.map((m) => m.id)]
      : canonical
        ? [canonical.id]
        : [],
    timeline: (isConcat ? 'concat' : 'wall') as 'wall' | 'concat',
  };

  return {
    canonicalKey,
    recording: {
      id: recordingId,
      ownerUserId: ownerRow.user_id,
      sourceKind: sourceKindOf(ownerRow),
      // §5a: the Meet snapshot's anchor, else the tray's own start.
      startedAt: isoOrNull(g?.actuals?.anchorIso) ?? isoOrNull(ownerRow.recorder_started_at),
      durationMs,
      recorderRecordingId:
        g?.recorder?.recordingId ?? ownerRow.recorder_recording_id ?? null,
    },
    media,
    transcription: {
      id: transcriptionIdFor(recordingId),
      provider: providerOf(ownerRow),
      providerJobId: isRealAaiId(ownerRow.assemblyai_id) ? ownerRow.assemblyai_id : null,
      speechModel: ownerRow.speech_model,
      languageCode: ownerRow.language_code,
      status: transcriptionStatusOf(ownerRow),
      covers,
    },
    payloadFromTranscriptId: ownerRow.id,
    filesProbed: !!files,
  };
}

/**
 * Which of the meetings sharing one `assemblyai_id` owns the recording:
 * the earliest `created_at`, ties broken by the lowest row id (§5a). Meets
 * imported by two people (landmine #14) are the only real case.
 */
export function ownerRowOf<T extends GraphMeetingRow>(rows: T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    const a = new Date(row.created_at).getTime();
    const b = new Date(best.created_at).getTime();
    if (a < b || (a === b && row.id < best.id)) best = row;
  }
  return best;
}

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
import type { StoredClips } from '@/lib/clips';
import { aaiJobIdOf } from '@/lib/aai-job-state';
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
/**
 * The id of the transcription a meeting was BORN with — the one the Phase 1
 * backfill mints and the one a re-derivation targets while the meeting has
 * never been re-transcribed.
 *
 * A Phase 2 RE-RUN does not derive its id: it is minted before AssemblyAI has
 * a job to name it after (the upload leg of a multi-GB file is minutes long,
 * and both the double-run lock and the "this run failed" line need a handle
 * that exists throughout). Convergence is by LOOKUP instead —
 * `GraphTableFacts.activeTranscriptionId` below — which is stronger than a
 * derivation anyway: it cannot disagree with the table.
 */
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
  /** The AssemblyAI job (migration 045). Read it through `aaiJobIdOf`, which
   * falls back to a UUID-shaped `assemblyai_id` for rows that predate 1b. */
  aai_job_id?: string | null;
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

/**
 * UUID-shaped and not one of our synthetic prefixes. Before Phase 1b that
 * meant "a real AssemblyAI job id"; it does NOT any more — a meeting id we
 * mint looks exactly the same. It survives as the shape test only; the
 * question "does this row have a job" is `aaiJobIdOf`, and "is this row's
 * meeting id its job id" is `isJobIdMeeting`.
 */
export const isRealAaiId = (id: string) => AAI_ID.test(id) && !SYNTHETIC.test(id);

/**
 * A meeting whose own id IS its AssemblyAI job — i.e. every upload born
 * before Phase 1b, including the two-owner copies of one job. These are the
 * only rows that may key a recording on the job id (see `canonicalKeyOf`),
 * and the only ones two meetings can ever share.
 */
export function isJobIdMeeting(row: GraphMeetingRow): boolean {
  const job = aaiJobIdOf(row);
  return job !== null && job === row.assemblyai_id;
}

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
  // Imported from AssemblyAI by id: a job someone typed in, no bytes of ours,
  // no conferencing context. (All 35 such rows on prod are source='imported';
  // the feature itself was deleted with DEC-4.) `isJobIdMeeting`, not the id
  // shape — a minted upload id is UUID-shaped too, and an upload whose file
  // rename failed would otherwise be filed as an AssemblyAI import.
  if (isJobIdMeeting(row) && !row.local_audio_path && !g) return 'aai-import';
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
 * The AssemblyAI job is the key ONLY for a row whose meeting id IS that job
 * (`isJobIdMeeting`) — the pre-1b rows, where it is what makes the two-owner
 * copies of one Meet call land on one recording, and what keeps every id the
 * Phase 1 backfill minted. Everything else keys on `transcripts.id` — the
 * DOCUMENT's identity, which (unlike `assemblyai_id` + user id, the shape
 * spec §2 sketched) survives both a placeholder promotion and an ownership
 * transfer. A meeting minted by 1b therefore keeps the `t…` key it had as a
 * placeholder, so its promotion does not move the recording at all; a pre-1b
 * promotion still moves the key from `t…` to the job id and
 * `applyRecordingGraph` migrates the clip rather than leaving two recordings.
 */
export function canonicalKeyOf(row: GraphMeetingRow): string {
  return isJobIdMeeting(row) ? row.assemblyai_id : `t${row.id}`;
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

/**
 * A clip the meeting row says it takes.
 *
 * Phase 1: always exactly one, over the whole recording. Phase 3a: whatever
 * `gmeet_context.clips` says — see `desiredClipsFor`, and `recordingId`, which
 * is how a SPLIT-OFF meeting points at a recording it does not derive.
 */
export interface DesiredClip {
  transcriptId: number;
  ord: number;
  /** The recording the clip reads. Absent = the one this row derives. */
  recordingId?: string;
  transcriptionId: null;
  fromMs: number;
  toMs: number | null;
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
  /**
   * Do this row's own columns still describe the WHOLE recording?
   *
   * True for every meeting that has never been clipped — the Phase 1 world,
   * where `imported_content` IS the transcription and `duration` IS the
   * recording's length. FALSE once a meeting carries clip windows (Phase 3a):
   * its payload is the MATERIALISED window and its duration is the window's.
   * Two things follow, and both matter:
   *   - the payload must NOT be copied onto the transcription (it would
   *     destroy the text every meeting on the recording reads, this one
   *     included, a little more on every pass);
   *   - the row's duration must NOT be written onto the recording or its
   *     canonical file. `recordings-verify` skips the same two comparisons.
   */
  wholeRecording: boolean;
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
 * The clip every UN-CLIPPED meeting gets: `(ord 0, from 0, to NULL, offset 0,
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
 * `gmeet_context.clips`, validated. Exported because the RESOLVER needs it
 * too: with `MW_RECORDINGS` off it serves a meeting from its row alone, and a
 * split meeting's window has to come from somewhere (lib/server/recordings.ts
 * `mediaFromRow`).
 */
export function storedClipsInContext(g: GmeetContext | null | undefined): StoredClips | null {
  const raw = (g as { clips?: unknown } | null | undefined)?.clips;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: StoredClips = [];
  const ords = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const c = entry as Record<string, unknown>;
    const ord = c.ord;
    const recordingId = c.recordingId;
    const fromMs = c.fromMs;
    const toMs = c.toMs ?? null;
    const offsetMs = c.offsetMs;
    if (typeof ord !== 'number' || !Number.isInteger(ord) || ord < 0 || ords.has(ord)) return null;
    if (typeof recordingId !== 'string' || !AAI_ID.test(recordingId)) return null;
    if (typeof fromMs !== 'number' || !Number.isFinite(fromMs) || fromMs < 0) return null;
    if (toMs !== null && (typeof toMs !== 'number' || !Number.isFinite(toMs) || toMs <= fromMs)) {
      return null;
    }
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs) || offsetMs < 0) return null;
    ords.add(ord);
    out.push({ ord, recordingId, fromMs, toMs: toMs as number | null, offsetMs });
  }
  return out;
}

/**
 * The clip windows the ROW declares, or null when it declares none.
 *
 * `gmeet_context.clips` is the mirror that makes a split survive
 * (docs/recordings-phase3-clips-spec.md "Model"): the desired graph is derived
 * from the row, so without it the next dual-write would heal a split meeting
 * back to one full-recording clip. A malformed mirror reads as ABSENT rather
 * than as an error — a meeting must never become invisible to the resolver
 * because somebody wrote junk into its context.
 */
export function storedClipsOf(row: GraphMeetingRow): StoredClips | null {
  return storedClipsInContext(row.gmeet_context);
}

/**
 * Does this meeting only BORROW a recording — i.e. every clip it declares
 * points at a recording other than the one its own row derives?
 *
 * That is exactly a meeting split off another one: it has its own id (so
 * `canonicalKeyOf` would mint it a recording of its own) and its own
 * `local_audio_path` (so it plays), but the bytes, the media rows and the
 * transcription belong to the SOURCE's recording. A borrower contributes its
 * clips and nothing else — deriving a second recording for the same file is
 * precisely what must not happen.
 */
export function borrowsRecording(row: GraphMeetingRow): boolean {
  const stored = storedClipsOf(row);
  if (!stored) return false;
  const own = recordingIdFor(canonicalKeyOf(row));
  return stored.every((c) => c.recordingId !== own);
}

/**
 * The clips a meeting should have: its declared windows, or the single
 * whole-recording clip every un-clipped meeting gets.
 */
export function desiredClipsFor(row: GraphMeetingRow): DesiredClip[] {
  const stored = storedClipsOf(row);
  if (!stored) return [desiredClipFor(row.id)];
  return stored
    .map((c) => ({
      transcriptId: row.id,
      ord: c.ord,
      recordingId: c.recordingId,
      transcriptionId: null as null,
      fromMs: c.fromMs,
      toMs: c.toMs,
      offsetMs: c.offsetMs,
      textPolicy: 'include' as const,
    }))
    .sort((a, b) => a.ord - b.ord);
}

/**
 * Facts the caller looked up that the row cannot tell us. Same idea as
 * `GraphFileFacts`: the rules stay pure, the lookups belong to the caller.
 */
export interface GraphTableFacts {
  /**
   * The recording's CURRENT `active_transcription_id`, when it has one that
   * really exists (Phase 2). A meeting that has been re-transcribed reads a
   * transcription whose id is derived from the JOB, not from the recording,
   * so without this the dual-write would re-derive `txn:<rec>:0`, set the
   * recording's active pointer back to the version the user switched away
   * from AND overwrite that version's payload with the current one. Absent
   * (or null) = the derived id, which is what every un-re-run meeting has.
   */
  activeTranscriptionId?: string | null;
}

/**
 * Derive the recording, its files and its transcription from the meeting row
 * that OWNS them (the earliest `created_at` of a shared AssemblyAI job —
 * `ownerRowOf` below). A meeting that merely references the recording
 * contributes nothing but its clip.
 */
export function deriveRecordingGraph(
  ownerRow: GraphMeetingRow,
  files?: GraphFileFacts,
  tables?: GraphTableFacts
): DesiredGraph {
  const g = ownerRow.gmeet_context;
  const canonicalKey = canonicalKeyOf(ownerRow);
  const recordingId = recordingIdFor(canonicalKey);
  // A clipped row's duration is its WINDOW's, not the recording's — leaving it
  // null makes every upsert below a COALESCE no-op rather than a shrink.
  const wholeRecording = storedClipsOf(ownerRow) === null;
  const durationMs =
    wholeRecording && ownerRow.duration != null ? Math.round(ownerRow.duration * 1000) : null;

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
      // The version the meeting row currently describes — the recording's
      // active one when it has been re-transcribed (Phase 2), else the id
      // this recording's first transcription always had.
      id: tables?.activeTranscriptionId ?? transcriptionIdFor(recordingId),
      provider: providerOf(ownerRow),
      // The job itself, wherever it is recorded — `aai_job_id` for a minted
      // meeting, the meeting id for every row born before 1b.
      providerJobId: aaiJobIdOf(ownerRow),
      speechModel: ownerRow.speech_model,
      languageCode: ownerRow.language_code,
      status: transcriptionStatusOf(ownerRow),
      covers,
    },
    payloadFromTranscriptId: ownerRow.id,
    wholeRecording,
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

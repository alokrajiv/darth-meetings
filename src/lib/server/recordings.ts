import 'server-only';
import { createHash } from 'node:crypto';
import type { StoredTranscript, TranscriptResponse } from '@/lib/format';
import { storedVideoParts } from '@/lib/part-offsets';
import {
  compareClipsOnTimeline,
  resolveClips,
  type ResolvableClip,
  type ClipTextPolicy,
  isClipTextPolicy,
} from '@/lib/recording-clips';
import {
  loadMeetingRecordingGraph,
  loadMeetingRecordingGraphs,
  type MeetingRecordingGraph,
  type RecordingTranscriptionRow,
} from '@/db-ops/recordings';

/**
 * THE resolver (docs/recordings-phase1-spec.md §3).
 *
 * Every reader of a meeting's text or media comes through here instead of
 * touching `imported_content` / `local_audio_path` /
 * `gmeet_context.videoParts` itself: `content`, `audio`, `frames`,
 * `speakers` (the enrolment side), the offline plan, `auto-notes`,
 * `voiceprint`, `post-completion` and the v2 listing's `recording_count`.
 *
 * Three ways out, in order:
 *  1. MW_RECORDINGS unset/0  → the row's own columns, today's code path.
 *  2. Flag on, no clips yet  → the row's own columns + one log line. A writer
 *                              that has not been converted must never make a
 *                              meeting go blank.
 *  3. Flag on, clips present → the tables. With one default clip that is
 *                              COMPAT: the stored payload comes back by
 *                              reference, unmapped, so the JSON on the wire
 *                              is byte-identical to (1).
 *
 * PRIVACY: this function takes a row the caller has ALREADY been granted
 * (`resolveAccess`). It is reachability route (a) — through the meeting —
 * and applies no gate of its own (feedback_privacy_caller_scoping_gate).
 */

/** One playable file, in the numbering `/audio?part=N` already uses. */
export interface ResolvedMedia {
  /** 1 = the canonical file ("Video 1"); 2… = the parts, in capture order. */
  part: number;
  /** `recording_media.id`; '' in fallback mode (no row exists). */
  mediaId: string;
  /** `recordings.id`; '' in fallback mode. */
  recordingId: string;
  filename: string;
  isVideo: boolean | null;
  /** Where the file starts on the MEETING timeline, ms. */
  offsetMs: number;
  durationMs: number | null;
  /** Was this file's audio inside the transcription? A Meet stop-restart
   * part is false — that is today's amber "not transcribed" warning. It is
   * also the ONLY place "the job did not hear this file" shows up: it never
   * takes a one-clip meeting out of compat (spec §5a). */
  transcribed: boolean;
}

/**
 * The minimum a row needs for the resolver. `StoredTranscript` satisfies it;
 * so does a skinny listing/offline row that selects these six columns, which
 * is how the offline plan resolves 200 meetings without loading 200 payloads.
 */
export type ResolvableMeetingRow = Pick<
  StoredTranscript,
  | 'id'
  | 'assemblyai_id'
  | 'created_at'
  | 'completed_at'
  | 'duration'
  | 'local_audio_path'
  | 'gmeet_context'
  | 'imported_content'
>;

/** Just the media half — what the offline plan and the player need. */
export type MediaOnlyRow = Pick<
  ResolvableMeetingRow,
  'id' | 'duration' | 'local_audio_path' | 'gmeet_context'
>;

export interface ResolvedMeetingContent {
  /** What `/content` serves. null = nothing stored yet. */
  content: TranscriptResponse | null;
  media: ResolvedMedia[];
  /** True = `content` is a stored payload, verbatim, by reference. */
  compat: boolean;
  recordingIds: string[];
  /** Stable hash of the clips, the transcriptions they read and the media
   * ids — what an offline pin compares. In compat mode it is deliberately
   * derived from the SAME inputs as today's plan rev. */
  rev: string;
  /** Edit-map key per utterance, same order as `content.utterances`. */
  utteranceKeys: string[];
  /** True = served from the row's own columns, not from the tables. */
  fallback: boolean;
}

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;

/**
 * Read lazily, never at module scope: `bun run build` must succeed with no
 * env at all, and the flag is flipped by restarting the server, not by
 * rebuilding.
 */
export function recordingsEnabled(): boolean {
  const raw = process.env.MW_RECORDINGS;
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/** One `[recordings] fallback <id>` per id per process, not per request. */
const loggedFallbacks = new Set<string>();
function logFallbackOnce(id: string): void {
  if (loggedFallbacks.has(id)) return;
  loggedFallbacks.add(id);
  console.log(`[recordings] fallback ${id}`);
}

function md5(parts: unknown): string {
  return createHash('md5').update(JSON.stringify(parts)).digest('hex');
}

function isVideoName(filename: string | null): boolean | null {
  return filename ? VIDEO_EXT.test(filename) : null;
}

// ---------------------------------------------------------------------------
// Fallback — the row's own columns (today's behaviour, byte for byte)
// ---------------------------------------------------------------------------

function mediaFromRow(row: MediaOnlyRow): ResolvedMedia[] {
  const durationMs = row.duration != null ? Math.round(row.duration * 1000) : null;
  const media: ResolvedMedia[] = [];
  if (row.local_audio_path) {
    media.push({
      part: 1,
      mediaId: '',
      recordingId: '',
      filename: row.local_audio_path,
      isVideo: isVideoName(row.local_audio_path),
      offsetMs: 0,
      durationMs,
      transcribed: true,
    });
  }
  // The extra videos of a stop-restart Meet recording, placed by the SAME
  // wall-clock arithmetic the detail page uses (lib/part-offsets.ts). They
  // were never sent to AssemblyAI — hence `transcribed: false`.
  for (const p of storedVideoParts(row.gmeet_context)) {
    media.push({
      part: p.partNo,
      mediaId: '',
      recordingId: '',
      filename: p.filename,
      isVideo: isVideoName(p.filename),
      offsetMs: p.offsetSec != null ? Math.round(p.offsetSec * 1000) : 0,
      durationMs: p.durationSec != null ? Math.round(p.durationSec * 1000) : null,
      transcribed: false,
    });
  }
  return media;
}

function resolveFromRow(row: ResolvableMeetingRow): ResolvedMeetingContent {
  const media = mediaFromRow(row);
  const content = row.imported_content;
  return {
    content,
    media,
    compat: true,
    recordingIds: [],
    // Same media identity the offline plan's rev already hashes, so a row
    // that has not been converted keeps its rev stable.
    rev: md5(['row', row.local_audio_path, row.gmeet_context?.videoParts ?? null]),
    utteranceKeys: (content?.utterances ?? []).map((_, i) => String(i)),
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

function activeTranscriptionFor(
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
  // listRecordingTranscriptions orders newest first.
  return mine.find((t) => t.status === 'completed') ?? mine[0] ?? null;
}

/**
 * The playable files of the meeting's recordings, numbered exactly as today:
 * the canonical is part 1, the `part` rows follow in capture order. Numbering
 * happens BEFORE dropping files we don't hold, so a Meet segment that is
 * fetched later keeps the `?part=N` it always had (`audio/route.ts` indexes
 * `videoParts[N-2]`).
 */
function mediaForRecordings(
  orderedRecordingIds: string[],
  graph: MeetingRecordingGraph,
  clipOffsetMs: Map<string, number>
): ResolvedMedia[] {
  const out: ResolvedMedia[] = [];
  let part = 0;
  for (const recordingId of orderedRecordingIds) {
    const mine = graph.media.filter((m) => m.recording_id === recordingId);
    const transcription = activeTranscriptionFor(graph, recordingId, null);
    const covered = new Set(transcription?.covers?.media ?? []);
    const base = clipOffsetMs.get(recordingId) ?? 0;
    const playable = [
      ...mine.filter((m) => m.kind === 'canonical'),
      ...mine.filter((m) => m.kind === 'part').sort((a, b) => a.ord - b.ord),
    ];
    for (const m of playable) {
      part += 1;
      if (!m.filename) continue; // number reserved, bytes not on the VM
      out.push({
        part,
        mediaId: m.id,
        recordingId,
        filename: m.filename,
        isVideo: m.has_video ?? isVideoName(m.filename),
        offsetMs: base + (m.offset_ms ?? 0),
        durationMs: m.duration_ms ?? null,
        transcribed: covered.size === 0 ? m.kind === 'canonical' : covered.has(m.id),
      });
    }
  }
  return out;
}

function clipPolicy(raw: string): ClipTextPolicy {
  return isClipTextPolicy(raw) ? raw : 'include';
}

/**
 * Resolve one meeting's content and media.
 *
 * `graph` lets a caller that already loaded the rows (a listing, the diff
 * script) skip the four queries; without it we load them here. There is no
 * hidden process-wide cache on purpose — a stale one would serve a pinned
 * copy of a meeting whose clips just changed.
 */
export async function resolveMeetingContent(
  row: ResolvableMeetingRow,
  graph?: MeetingRecordingGraph
): Promise<ResolvedMeetingContent> {
  if (!recordingsEnabled()) return resolveFromRow(row);

  let loaded: MeetingRecordingGraph;
  try {
    loaded = graph ?? (await loadMeetingRecordingGraph(row.id));
  } catch (err) {
    // The tables may not exist yet (flag on before migration 044) — a
    // meeting must never 500 over that.
    console.error('[recordings] load failed, falling back:', err);
    return resolveFromRow(row);
  }

  if (loaded.clips.length === 0) {
    logFallbackOnce(row.assemblyai_id);
    return resolveFromRow(row);
  }

  // Meeting-timeline order: `offset_ms` first, `ord` only as the tie-break
  // (§5a). The media numbering below follows the same order, so "part 2" is
  // the second thing that happens in the meeting, not the second row added.
  const clips = [...loaded.clips].sort((a, b) =>
    compareClipsOnTimeline(
      { offsetMs: a.offset_ms, ord: a.ord },
      { offsetMs: b.offset_ms, ord: b.ord }
    )
  );
  const orderedRecordingIds: string[] = [];
  const clipOffsetMs = new Map<string, number>();
  for (const c of clips) {
    if (!orderedRecordingIds.includes(c.recording_id)) {
      orderedRecordingIds.push(c.recording_id);
      clipOffsetMs.set(c.recording_id, c.offset_ms - c.from_ms);
    }
  }

  const resolvable: ResolvableClip[] = clips.map((c) => {
    const transcription = activeTranscriptionFor(loaded, c.recording_id, c.transcription_id);
    return {
      ord: c.ord,
      recordingId: c.recording_id,
      fromMs: c.from_ms,
      toMs: c.to_ms,
      offsetMs: c.offset_ms,
      textPolicy: clipPolicy(c.text_policy),
      payload: transcription?.payload ?? null,
    };
  });

  // Compat is the clip's call alone (§5a). A job that did not hear the file
  // we play still hands its payload back verbatim; the only place that fact
  // surfaces is `media[].transcribed`.
  const resolved = resolveClips(resolvable, {
    id: row.assemblyai_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });

  const media = scopeMediaToRow(row, mediaForRecordings(orderedRecordingIds, loaded, clipOffsetMs));

  return {
    content: resolved.content,
    media,
    compat: resolved.compat,
    recordingIds: orderedRecordingIds,
    rev: md5([
      'clips',
      clips.map((c) => [
        c.ord,
        c.recording_id,
        activeTranscriptionFor(loaded, c.recording_id, c.transcription_id)?.id ?? null,
        c.from_ms,
        c.to_ms,
        c.offset_ms,
        c.text_policy,
      ]),
      media.map((m) => m.mediaId),
    ]),
    utteranceKeys: resolved.utteranceKeys,
    fallback: false,
  };
}

/**
 * Phase 1 privacy guard. Two meetings can sit on ONE recording (two users
 * holding the same AssemblyAI job), and only one of them may ever have held
 * the bytes. While the meeting row is still the source of truth, a meeting
 * that has no `local_audio_path` of its own gets NO media from the shared
 * recording — otherwise turning the flag on would hand user B a file user A
 * uploaded (the one mismatch the 2026-09-21 diff gate found, meeting id 4).
 * Sharing a recording's bytes across meetings becomes a deliberate act in
 * Phase 3 (clips), with its own access rule; it must never be a side effect
 * of a backfill.
 */
function scopeMediaToRow(row: MediaOnlyRow, media: ResolvedMedia[]): ResolvedMedia[] {
  return row.local_audio_path ? media : [];
}

// ---------------------------------------------------------------------------
// What the readers actually ask for
// ---------------------------------------------------------------------------

/**
 * The file a meeting's transcript times are measured against — "Video 1",
 * `?part=1`, today's `local_audio_path`.
 *
 * Frames, voiceprint snippets and the audio-only derivative all read THIS
 * file and no other: a meeting-ms → (part, local ms) mapping is landmine #15
 * and belongs to Phase 3, where clips gain a real window. Until then the
 * canonical starts at meeting ms 0 and the mapping is the identity.
 */
export function canonicalMedia(media: ResolvedMedia[]): ResolvedMedia | null {
  return media.find((m) => m.part === 1) ?? null;
}

/** `?part=N`. N < 2 is not a part — the primary is served by the plain route. */
export function mediaPart(media: ResolvedMedia[], partNo: number): ResolvedMedia | null {
  if (!Number.isInteger(partNo) || partNo < 2) return null;
  return media.find((m) => m.part === partNo) ?? null;
}

/** Recording ms for a position on the MEETING timeline, inside `m`. */
export function localMsIn(m: ResolvedMedia, meetingMs: number): number {
  return Math.max(0, Math.round(meetingMs - m.offsetMs));
}

/**
 * Media inventory for MANY meetings at once — the offline plan hands 200 ids
 * over and must not pay four queries each (spec §3: "no N+1 on the listing").
 * Flag off, this touches no database at all.
 *
 * PRIVACY: the caller has already decided these meetings are visible to it
 * (the offline plan's own owner-or-share CTE). Reachability route (a).
 */
export async function resolveMediaForMeetings(
  rows: MediaOnlyRow[]
): Promise<Map<number, ResolvedMedia[]>> {
  const out = new Map<number, ResolvedMedia[]>();
  if (!recordingsEnabled()) {
    for (const row of rows) out.set(row.id, mediaFromRow(row));
    return out;
  }

  let graphs: Map<number, MeetingRecordingGraph>;
  try {
    graphs = await loadMeetingRecordingGraphs(rows.map((r) => r.id));
  } catch (err) {
    console.error('[recordings] batch load failed, falling back:', err);
    for (const row of rows) out.set(row.id, mediaFromRow(row));
    return out;
  }

  for (const row of rows) {
    const graph = graphs.get(row.id);
    if (!graph || graph.clips.length === 0) {
      out.set(row.id, mediaFromRow(row));
      continue;
    }
    const clips = [...graph.clips].sort((a, b) =>
      compareClipsOnTimeline(
        { offsetMs: a.offset_ms, ord: a.ord },
        { offsetMs: b.offset_ms, ord: b.ord }
      )
    );
    const orderedRecordingIds: string[] = [];
    const clipOffsetMs = new Map<string, number>();
    for (const c of clips) {
      if (!orderedRecordingIds.includes(c.recording_id)) {
        orderedRecordingIds.push(c.recording_id);
        clipOffsetMs.set(c.recording_id, c.offset_ms - c.from_ms);
      }
    }
    out.set(row.id, scopeMediaToRow(row, mediaForRecordings(orderedRecordingIds, graph, clipOffsetMs)));
  }
  return out;
}

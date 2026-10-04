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
import { keptSegmentsFor, windowBoundsFor, type ClipWindow, type FileSegment } from '@/lib/clips';
import { storedClipsInContext as storedClipsFromContext } from '@/lib/recording-graph';
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

/**
 * A rebuildable extract of a playable file — today only the 64 kbps
 * `audio_only` m4a (`lib/server/audio-only.ts`). Carried on the parent so
 * `?variant=audio` can be answered (streamed locally, or redirected to its
 * own blob in Stage B) without a second query.
 */
export interface ResolvedMediaDerivative {
  /** `recording_media.id` of the DERIVATIVE row. */
  mediaId: string;
  /** Its stored name (`<stem>.m4a`, under `storage/audio-only/`). */
  filename: string;
  /** Its own `blob_name`; null until the archive has stamped it. */
  blobName: string | null;
  /** Its `recording_media.sha256` — what a pull from the archive is checked against. */
  sha256: string | null;
}

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
  /**
   * `recording_media.blob_name` — the permanent copy in the media container
   * (DEC-3 Stage A). null means "no blob to serve from": fallback mode (no
   * row exists at all) or a file the archive has not stamped yet. Stage B
   * reads this and nothing else to decide whether a redirect is possible.
   */
  blobName: string | null;
  /**
   * `recording_media.sha256` — the hash the archive stamped and Stage D read
   * back; a pull from the blob into the media cache is checked against it.
   * null in fallback mode.
   */
  sha256: string | null;
  /** The `audio_only` extract of THIS file, when one has been built. */
  audioOnly: ResolvedMediaDerivative | null;
  /**
   * The window of this FILE the meeting uses, in file ms (Phase 3a,
   * docs/recordings-phase3-clips-spec.md "Media and the window").
   *
   * `null`/`null` = the whole file, which is what every meeting that was never
   * split has — and also what a SOURCE meeting keeps after a shrink: it still
   * plays every second, it just has a hole in the middle (the clips say where;
   * `holesOf` in lib/clips.ts turns them into the gaps the player skips).
   *
   * A split-off meeting gets real bounds. Since 2026-10-02 `/audio` serves
   * the window CUT (lib/clip-cut.ts); server-side readers of the SOURCE file
   * (frame grabs, voiceprint snippets) still map meeting ms onto the file with
   * `localMsIn`.
   */
  windowFromMs: number | null;
  /** null = to the end of the file. */
  windowToMs: number | null;
  /**
   * The stretches of this file the meeting holds, in file order, when there
   * is MORE than one — a hole in the middle (`keptSegmentsFor`). null = the
   * bounds above say everything. `/audio` serves the concatenation of these
   * (lib/clip-cut.ts `cutPlanOf`), so the hole's bytes are never served.
   */
  keptMs: FileSegment[] | null;
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
   * ids — what an offline replica compares. In compat mode it is deliberately
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
    // The row's OWN mirror of its clips (`gmeet_context.clips`) is what makes
    // this path correct for a split meeting even with MW_RECORDINGS off: the
    // window and the offset are on the row, so the player still clamps and
    // `localMsIn` still maps meeting ms onto the file. Absent = the whole
    // file, byte for byte what Phase 1 returned.
    // Timeline order, exactly as `placeRecordings` uses below: the clip that
    // lands FIRST on the meeting's timeline is the one whose
    // `offset_ms − from_ms` places the file. `ord` is identity, not position
    // (§5a), so reading `clips[0]` off the stored array would be wrong the
    // moment a second split re-ordered it.
    const stored = storedClipsFromContext(row.gmeet_context);
    const first = stored ? [...stored].sort(compareClipsOnTimeline)[0]! : null;
    const window = first ? windowBoundsFor(stored!, first.recordingId) : null;
    const kept = first ? keptSegmentsFor(stored!, first.recordingId) : [];
    const base = first ? first.offsetMs - first.fromMs : 0;
    media.push({
      part: 1,
      mediaId: '',
      recordingId: '',
      filename: row.local_audio_path,
      isVideo: isVideoName(row.local_audio_path),
      offsetMs: base,
      durationMs,
      transcribed: true,
      // Fallback mode reads the `transcripts` row alone, which knows nothing
      // about the archive: there is no blob to serve and no derivative row.
      // `?variant=audio` still works — it goes through the local extract.
      blobName: null,
      sha256: null,
      audioOnly: null,
      windowFromMs: window?.fromMs ?? null,
      windowToMs: window?.toMs ?? null,
      keptMs: kept.length > 1 ? kept : null,
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
      blobName: null,
      sha256: null,
      audioOnly: null,
      // A stop/restart part is never windowed: a split only ever takes a
      // window of the canonical file (a multi-part meeting refuses to split).
      windowFromMs: null,
      windowToMs: null,
      keptMs: null,
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
  clipOffsetMs: Map<string, number>,
  windows: Map<string, RecordingWindow>
): ResolvedMedia[] {
  const out: ResolvedMedia[] = [];
  // Derivatives by the media they were built from. `graph.media` already
  // holds every row of these recordings — the `audio_only` extracts included
  // — so attaching them here costs NO extra query, which is what lets the
  // audio route answer `?variant=audio` from the blob without a second read.
  const derivatives = new Map<string, ResolvedMediaDerivative>();
  for (const d of graph.media) {
    if (d.kind !== 'audio_only' || !d.of_media_id || !d.filename) continue;
    derivatives.set(d.of_media_id, {
      mediaId: d.id,
      filename: d.filename,
      blobName: d.blob_name,
      sha256: d.sha256,
    });
  }
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
        blobName: m.blob_name,
        sha256: m.sha256,
        audioOnly: derivatives.get(m.id) ?? null,
        // Only the CANONICAL file carries the meeting's window: a clip always
        // windows the file the transcription was made from, and a meeting with
        // stop/restart parts cannot be split at all.
        windowFromMs: m.kind === 'canonical' ? (windows.get(recordingId)?.fromMs ?? null) : null,
        windowToMs: m.kind === 'canonical' ? (windows.get(recordingId)?.toMs ?? null) : null,
        keptMs: m.kind === 'canonical' ? (windows.get(recordingId)?.kept ?? null) : null,
      });
    }
  }
  return out;
}

function clipPolicy(raw: string): ClipTextPolicy {
  return isClipTextPolicy(raw) ? raw : 'include';
}

/**
 * The meeting's placement of each recording: where its first clip lands
 * (`offset_ms − from_ms`, the number `localMsIn` inverts) and the bounds the
 * player must clamp to. One pass over the clips, shared by both resolvers.
 */
function placeRecordings(
  clips: Array<{ ord: number; recording_id: string; from_ms: number; to_ms: number | null; offset_ms: number }>
): {
  orderedRecordingIds: string[];
  clipOffsetMs: Map<string, number>;
  windows: Map<string, RecordingWindow>;
} {
  const orderedRecordingIds: string[] = [];
  const clipOffsetMs = new Map<string, number>();
  for (const c of clips) {
    if (!orderedRecordingIds.includes(c.recording_id)) {
      orderedRecordingIds.push(c.recording_id);
      clipOffsetMs.set(c.recording_id, c.offset_ms - c.from_ms);
    }
  }
  const asWindows: ClipWindow[] = clips.map((c) => ({
    ord: c.ord,
    recordingId: c.recording_id,
    fromMs: c.from_ms,
    toMs: c.to_ms,
    offsetMs: c.offset_ms,
  }));
  const windows = new Map<string, RecordingWindow>();
  for (const id of orderedRecordingIds) {
    const kept = keptSegmentsFor(asWindows, id);
    windows.set(id, { ...windowBoundsFor(asWindows, id), kept: kept.length > 1 ? kept : null });
  }
  return { orderedRecordingIds, clipOffsetMs, windows };
}

/** What a meeting holds of one recording's file: its bounds, plus the kept
 * segments when there is a hole in the middle (`ResolvedMedia.keptMs`). */
interface RecordingWindow {
  fromMs: number | null;
  toMs: number | null;
  kept: FileSegment[] | null;
}

/**
 * The MEDIA half of `resolveMeetingContent`, for the readers that need the
 * `?part=N` numbering and nothing else — the clip list, which has to tell the
 * player which part plays each clip (`ClipEntry.mediaPart`).
 *
 * One function so the numbering has ONE definition: walk the recordings in
 * meeting-timeline order, number every playable FILE of each, then apply the
 * privacy scope. A caller that counted recordings instead would be right only
 * while every recording holds exactly one file.
 *
 * Pure — the graph is already loaded. An empty graph falls back to the row's
 * own columns, exactly as `resolveMeetingContent` does.
 */
export function mediaFromGraph(row: MediaOnlyRow, graph: MeetingRecordingGraph): ResolvedMedia[] {
  if (graph.clips.length === 0) return mediaFromRow(row);
  const clips = [...graph.clips].sort((a, b) =>
    compareClipsOnTimeline(
      { offsetMs: a.offset_ms, ord: a.ord },
      { offsetMs: b.offset_ms, ord: b.ord }
    )
  );
  const { orderedRecordingIds, clipOffsetMs, windows } = placeRecordings(clips);
  return scopeMediaToRow(
    row,
    mediaForRecordings(orderedRecordingIds, graph, clipOffsetMs, windows),
    orderedRecordingIds[0] ?? null
  );
}

/**
 * `mediaFromGraph`, loading the graph itself — the media list without paying
 * for `resolveClips` over every recording's payload.
 *
 * `GET /api/transcripts/:id/clips` uses this (through `combineView`) so the
 * clip list can carry each clip's part number. It is deliberately NOT folded
 * into `combineState`: the add/patch/delete paths ask for that state too and
 * have no use for media.
 */
export async function resolveMeetingMedia(
  row: MediaOnlyRow,
  graph?: MeetingRecordingGraph
): Promise<ResolvedMedia[]> {
  if (!recordingsEnabled()) return mediaFromRow(row);
  try {
    return mediaFromGraph(row, graph ?? (await loadMeetingRecordingGraph(row.id)));
  } catch (err) {
    // Same rule as the content resolver: the tables may not exist yet, and a
    // meeting must never 500 over that.
    console.error('[recordings] media load failed, falling back:', err);
    return mediaFromRow(row);
  }
}

/**
 * `recordingId` → its playable parts, canonical first — the shape a clip list
 * indexes to fill `ClipEntry.mediaPart` / `mediaParts`.
 *
 * Numbering is already done (`part`), so this only groups; a recording whose
 * bytes are not held, or which the scope withheld, is simply absent.
 */
export function mediaPartsByRecording(media: ResolvedMedia[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of [...media].sort((a, b) => a.part - b.part)) {
    if (!m.recordingId) continue;
    const parts = out.get(m.recordingId);
    if (parts) parts.push(m.part);
    else out.set(m.recordingId, [m.part]);
  }
  return out;
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
  // (§5a). `mediaFromGraph` sorts the same way, so "part 2" is the second
  // thing that happens in the meeting, not the second row added.
  const clips = [...loaded.clips].sort((a, b) =>
    compareClipsOnTimeline(
      { offsetMs: a.offset_ms, ord: a.ord },
      { offsetMs: b.offset_ms, ord: b.ord }
    )
  );
  const { orderedRecordingIds } = placeRecordings(clips);

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

  // One definition of the numbering, shared with the clip list's `mediaPart`.
  const media = mediaFromGraph(row, loaded);

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
export function scopeMediaToRow(
  row: MediaOnlyRow,
  media: ResolvedMedia[],
  /**
   * The recording the meeting's OWN row describes — the first one on its
   * timeline, which is the one `local_audio_path` names. Everything else in
   * `media` got here because somebody ADDED a clip on another recording, and
   * that add is the consent (see below). Omitted = Phase 1 behaviour.
   */
  primaryRecordingId?: string | null
): ResolvedMedia[] {
  if (row.local_audio_path) return media;
  // Phase 3b (spec §Privacy): "media of a clip's recording is served when the
  // CLIP exists on the meeting — the add is the consent". Only the OWNER of a
  // recording can add it (`validateAddClip`), so a clip on a second recording
  // is that owner deliberately handing its bytes to this meeting's readers.
  //
  // The meeting's OWN recording is still withheld, which is the Phase 1 guard
  // untouched: two meetings can sit on one recording because two people
  // imported the same AssemblyAI job (landmine #14), and only one of them ever
  // held the bytes. That case has exactly one recording, so nothing below
  // survives the filter and the answer is `[]`, byte for byte as before.
  if (!primaryRecordingId) return [];
  return media.filter((m) => m.recordingId && m.recordingId !== primaryRecordingId);
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
    out.set(row.id, mediaFromGraph(row, graph));
  }
  return out;
}

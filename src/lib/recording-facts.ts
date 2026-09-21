/**
 * "The recording is an object" (docs/transcript-page-redesign.md §3.6).
 *
 * One pure model behind the Recording block of the transcript page: where
 * the bytes came from, who recorded them, how many segments, how long, how
 * big, what media exists. It replaces the About card's SOURCE / AUDIO / VIDEO
 * rows and the Sources card's "Recorded in N segments" item. A filename is
 * never in a sentence — it rides in `filename` / `segments[].filename` for
 * tooltips only. No React, no server imports; the React card
 * (components/recording-card.tsx) renders this plus the recovery states.
 */

import type { GmeetContext, TranscriptAccess } from '@/lib/format';
import { formatBytes, formatDuration } from '@/lib/format';
import { macOwnerLabel } from '@/lib/recording-strip';

export type RecordingSourceKind = 'mac' | 'meet' | 'teams' | 'file' | 'text';
export type RecordingMedia = 'video' | 'audio' | 'none';

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|oga|opus|flac|wma|amr|aiff?)$/i;

export interface RecordingSegment {
  index: number;
  /** Seconds from the start of the combined recording; null when unknown. */
  offsetSec: number | null;
  durationSec: number | null;
  /** The uploader's per-file note (stitched uploads). */
  comment: string | null;
  /** Tooltip only. */
  filename: string | null;
}

/** The subset of a transcript row the model reads. */
export interface RecordingFactsRow {
  assemblyai_id: string;
  source: 'uploaded' | 'imported';
  original_filename: string | null;
  local_audio_path: string | null;
  drive_file_id?: string | null;
  duration: number | null;
  upload_bytes_total?: number | null;
  created_at: string;
  recorded_at: string | null;
  gmeet_context: GmeetContext | null;
  /** The caller's access + the owner — "Atira's Mac" on a shared row. */
  access?: TranscriptAccess;
  owner_email?: string | null;
  owner_name?: string | null;
}

export interface RecordingFacts {
  source: RecordingSourceKind;
  /** "Recorded on Atira’s Mac with Darth Recorder" — the strong part is `lead`, the rest `tail`. */
  lead: string;
  tail: string;
  segments: RecordingSegment[];
  /** > 1 when the recording is a join of several files; 1 otherwise. */
  segmentCount: number;
  /** Why there are segments, in one sentence — null when there is one segment. */
  segmentsNote: string | null;
  durationSec: number | null;
  bytes: number | null;
  media: RecordingMedia;
  /** The primary file's original name — tooltip only. */
  filename: string | null;
  /** ["8 segments", "56m 45s", "618 MB", "video"] — only what is known. */
  facts: string[];
  /** Extra Meet videos beyond the primary (stop/restart recordings). */
  extraVideos: number;
  /** "held 4 Aug, imported 11 Aug" when the meeting day and the day it landed here differ. */
  heldVsAdded: string | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function safeDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const shortDay = (d: Date, withYear: boolean) =>
  `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;

export function recordingSourceOf(row: RecordingFactsRow): RecordingSourceKind {
  const ctx = row.gmeet_context;
  if (ctx?.recorder?.recordingId) return 'mac';
  if (row.source === 'imported') {
    if (ctx?.provider === 'teams') return 'teams';
    if (
      ctx?.provider === 'gmeet' ||
      row.assemblyai_id.startsWith('gmeet-') ||
      !!row.drive_file_id ||
      !!ctx?.meetingCode ||
      !!ctx?.actuals ||
      !!ctx?.videoFileId
    ) {
      return 'meet';
    }
    return row.local_audio_path ? 'file' : 'text';
  }
  return 'file';
}

export function recordingMediaOf(row: RecordingFactsRow): RecordingMedia {
  const local = row.local_audio_path ?? '';
  const name = row.original_filename ?? '';
  if (VIDEO_EXT.test(local)) return 'video';
  if (local) return 'audio';
  if (VIDEO_EXT.test(name)) return 'video';
  if (AUDIO_EXT.test(name)) return 'audio';
  return row.source === 'uploaded' ? 'audio' : 'none';
}

export function recordingFacts(row: RecordingFactsRow): RecordingFacts {
  const ctx = row.gmeet_context;
  const source = recordingSourceOf(row);
  const media = recordingMediaOf(row);

  let lead = '';
  let tail = '';
  switch (source) {
    case 'mac':
      lead = `Recorded on ${macOwnerLabel(row)}`;
      tail = 'with Darth Recorder';
      break;
    case 'meet':
      lead = 'Recorded in Google Meet';
      break;
    case 'teams':
      lead = 'Recorded in Microsoft Teams';
      break;
    case 'file':
      lead = media === 'video' ? 'Uploaded video' : media === 'audio' ? 'Uploaded audio' : 'Uploaded recording';
      break;
    case 'text':
      lead = 'Imported transcript';
      tail = 'no recording';
      break;
  }

  const parts = [...(ctx?.uploadedParts ?? [])].sort((a, b) => a.index - b.index);
  const segments: RecordingSegment[] = parts.map((p) => ({
    index: p.index,
    offsetSec: typeof p.offsetSec === 'number' ? p.offsetSec : null,
    durationSec: typeof p.durationSec === 'number' ? p.durationSec : null,
    comment: p.comment?.trim() || null,
    filename: p.originalFilename?.trim() || null,
  }));
  const segmentCount = Math.max(1, segments.length, ctx?.combinedParts ?? 0);

  let segmentsNote: string | null = null;
  if (segmentCount > 1) {
    if (source === 'mac') {
      segmentsNote =
        'Darth Recorder starts a new segment on every screen-share change. They were joined in order into one recording before transcription, and the AI is told where the joins are.';
    } else if (segments.length > 1) {
      segmentsNote =
        'Joined in order into one recording before transcription; the AI is told where the joins are' +
        (segments.some((s) => s.comment) ? ' and gets the per-file notes.' : '.');
    } else {
      segmentsNote = `The ${segmentCount} videos were combined into one recording before transcription.`;
    }
  }

  const bytes = row.upload_bytes_total && row.upload_bytes_total > 0 ? row.upload_bytes_total : null;
  const durationSec = row.duration ?? null;

  const facts: string[] = [];
  if (segmentCount > 1) facts.push(`${segmentCount} segments`);
  if (durationSec != null) facts.push(formatDuration(durationSec));
  if (bytes != null) facts.push(formatBytes(bytes));
  if (media !== 'none') facts.push(media);

  const held = safeDate(row.recorded_at) ?? safeDate(ctx?.startTime);
  const created = safeDate(row.created_at);
  let heldVsAdded: string | null = null;
  if (held && created && dayKey(held) !== dayKey(created)) {
    const verb = row.source === 'imported' ? 'imported' : 'uploaded';
    heldVsAdded = `held ${shortDay(held, held.getFullYear() !== created.getFullYear())}, ${verb} ${shortDay(created, false)}`;
  }

  return {
    source,
    lead,
    tail,
    segments,
    segmentCount,
    segmentsNote,
    durationSec,
    bytes,
    media,
    filename: row.original_filename?.trim() || null,
    facts,
    extraVideos: ctx?.videoParts?.length ?? 0,
    heldVsAdded,
  };
}

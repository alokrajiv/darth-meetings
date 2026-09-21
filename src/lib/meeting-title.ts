/**
 * "A row is a meeting, never a file" (docs/listing-ui-redesign.md §2, §6).
 *
 * Pure helpers shared by the listing, the Recordings tab and their tests:
 * which rows are BARE recordings (uploaded, but attached to no meeting and
 * carrying no human title), and what to call a row whose stored title is a
 * filename. No React, no server imports.
 */

/** Media / document extensions the upload paths accept, plus the recorder's
 * own `YYYY-MM-DD HH.MM.SS <display|meet|…> partN` naming. */
const FILE_EXT_RE =
  /\.(mp4|m4a|m4v|mov|mp3|wav|webm|mkv|aac|ogg|oga|opus|flac|aiff?|wma|avi|mpe?g|3gp|txt|vtt|srt|docx?|rtf|md|json)$/i;
const RECORDER_NAME_RE = /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\b/;
/** "New Recording 3", "Voice 042", "Recording (2)" — phone/voice-memo defaults. */
const DEFAULT_MEMO_RE = /^(new recording|recording|voice memo|voice|audio|untitled)(\s*[\d(),-]*)?$/i;

/** Does this title read as a file, not as a meeting? */
export function looksLikeFilename(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (!t) return false;
  if (FILE_EXT_RE.test(t)) return true;
  if (RECORDER_NAME_RE.test(t)) return true;
  if (DEFAULT_MEMO_RE.test(t)) return true;
  return false;
}

/** The subset of a listing row the title logic needs. */
export interface TitleRowFields {
  title: string | null;
  original_filename: string | null;
  has_event?: boolean;
  scratch?: boolean;
  deleted_at?: string | null;
  recorded_at?: string | null;
  created_at: string;
  recorder_recording_id?: string | null;
  source?: 'uploaded' | 'imported';
  provider?: 'gmeet' | 'teams' | null;
}

/** True when the row has no human title — empty, the filename itself, or
 * something that reads as a filename. */
export function hasNoRealTitle(row: Pick<TitleRowFields, 'title' | 'original_filename'>): boolean {
  const t = (row.title ?? '').trim();
  if (!t) return true;
  const f = (row.original_filename ?? '').trim();
  if (f && t === f) return true;
  return looksLikeFilename(t);
}

/**
 * A BARE recording: uploaded (or being uploaded) but attached to no
 * calendar event and carrying no human title. These live in the Recordings
 * tab, not in the meetings timeline. Temporary and trashed rows are never
 * bare — a temporary transcript is a deliberate one-off, and the trash is
 * the trash. Under the first-class model this becomes "a recording with no
 * segment" (recordings-first-class-design.md D-B).
 */
export function isBareRecording(row: TitleRowFields): boolean {
  if (row.has_event) return false;
  if (row.scratch) return false;
  if (row.deleted_at) return false;
  return hasNoRealTitle(row);
}

export type MeetingTitleKind = 'title' | 'derived' | 'untitled';

/** "Sat 20 Sept 22:00" — the day + time a recording started, for derived titles. */
export function shortWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** What kind of recording a row is, for derived titles and tooltips. */
export function recordingSourceLabel(row: Pick<TitleRowFields, 'recorder_recording_id' | 'source' | 'provider'>): string {
  if (row.recorder_recording_id) return 'Recording from your Mac';
  if (row.provider === 'teams') return 'Teams recording';
  if (row.provider === 'gmeet') return 'Meet recording';
  if (row.source === 'uploaded') return 'Uploaded recording';
  return 'Pasted transcript';
}

/**
 * The title a listing row shows. A real title wins; a filename-shaped or
 * missing title becomes "Recording from your Mac · Sat 20 Sept 22:00" — the
 * filename never reaches the row (it rides in the tooltip instead).
 */
export function meetingTitleOf(
  row: TitleRowFields,
  now: Date = new Date()
): { primary: string; kind: MeetingTitleKind; filename: string | null } {
  const filename = row.original_filename?.trim() || null;
  if (!hasNoRealTitle(row)) return { primary: row.title!.trim(), kind: 'title', filename };
  const when = shortWhen(row.recorded_at ?? row.created_at, now);
  const src = recordingSourceLabel(row);
  if (when) return { primary: `${src} · ${when}`, kind: 'derived', filename };
  return { primary: src, kind: 'derived', filename };
}

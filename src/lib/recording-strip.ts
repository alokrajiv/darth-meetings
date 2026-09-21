/**
 * The recording strip — the one line under a meeting title that says what
 * its recording is and what (if anything) you can do about it
 * (docs/listing-ui-redesign.md §4). Pure model builders; the React strip in
 * components/recording-strip.tsx only renders what comes out of here.
 *
 * Three inputs, one shape:
 *  - stripForArchiveRow   — a listing v2 row (+ the tray's live upload state)
 *  - stripForRecorderRef  — a Darth Recorder recording matched to a calendar row
 *  - stripForCalendarRow  — a calendar occurrence's cloud state
 */
import type { RecorderRecordingRef } from '@/lib/recorder';
import { recorderMacLabel, recorderOwnerFirstName, RECORDING_STALE_MS } from '@/lib/recorder';
import { personDisplay } from '@/lib/person-display';

export type RecordingSource = 'mac' | 'meet' | 'teams' | 'file' | 'text' | 'none';

export type RecordingStripState =
  | 'recording'
  | 'on-mac'
  | 'uploading'
  | 'received'
  | 'transcribing'
  | 'waiting'
  | 'transcribed'
  | 'failed'
  | 'cloud-available'
  | 'cloud-preparing'
  | 'none';

export type StripTone = 'muted' | 'busy' | 'ok' | 'warn' | 'err';

export type StripActionKind = 'upload' | 'open-recorder' | 'nudge' | 'open' | 'retry' | 'import' | 'add';

export interface StripAction {
  kind: StripActionKind;
  label: string;
  /** Tooltip. */
  title?: string;
}

export interface StripProgress {
  /** 0..100, null when unknown. */
  pct: number | null;
  /** "298 MB of 696 MB" / "part 3 of 6 · 298 MB of 696 MB". */
  label: string;
  live: boolean;
}

export interface RecordingStripModel {
  source: RecordingSource;
  state: RecordingStripState;
  tone: StripTone;
  /** The sentence. Segments/duration are folded in already. */
  text: string;
  /** Tooltip — provenance, timestamps, the "why". */
  title: string | null;
  progress: StripProgress | null;
  action: StripAction | null;
  /** True while something is moving (renders a pulse). */
  busy: boolean;
}

// ---------------------------------------------------------------------------
// Shared formatting

const join = (parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ');

function segmentsWord(n: number | null | undefined, word = 'segment'): string | null {
  if (!n || n <= 1) return null;
  return `${n} ${word}s`;
}

// ---------------------------------------------------------------------------
// Archive rows

export interface ArchiveStripRow {
  assemblyai_id: string;
  status: string;
  source?: 'uploaded' | 'imported';
  provider?: 'gmeet' | 'teams' | null;
  recorder_recording_id?: string | null;
  recording_count?: number;
  duration?: number | null;
  upload_bytes_received?: number | null;
  upload_bytes_total?: number | null;
  upload_parts_done?: number | null;
  upload_parts_total?: number | null;
  deferred_mode?: 'video' | 'transcript' | 'both' | null;
  deferred_error?: string | null;
  deferred_background?: string | null;
  original_filename?: string | null;
  auto_state?: 'passed' | 'gated' | 'auto' | null;
  /** The caller's access + the owner: a Mac recording on a SHARED row was
   * recorded on the owner's Mac, not the caller's ("Recorded on Atira's
   * Mac" — Alok, 2026-09-21, an Editor on Atira's Hypercare upload). */
  access?: 'owner' | 'edit' | 'read';
  owner_email?: string | null;
  owner_name?: string | null;
}

/** "your Mac" for the owner, "Atira's Mac" for everyone the row is shared with. */
export function macOwnerLabel(row: Pick<ArchiveStripRow, 'access' | 'owner_email' | 'owner_name'>): string {
  if (!row.access || row.access === 'owner') return 'your Mac';
  const first = personDisplay(row.owner_email, row.owner_name).first;
  return first && first !== '—' ? `${first}’s Mac` : 'a colleague’s Mac';
}

export interface ArchiveStripOptions {
  /** The tray's live numbers for `recorder_recording_id`, only while uploading. */
  live?: { pct?: number | null; bytesSent?: number | null; bytesTotal?: number | null } | null;
  fmtBytes: (n: number) => string;
  fmtDuration: (s: number) => string;
}

export function sourceOfArchiveRow(row: Pick<ArchiveStripRow, 'assemblyai_id' | 'source' | 'provider' | 'recorder_recording_id'>): RecordingSource {
  if (row.recorder_recording_id) return 'mac';
  if (row.provider === 'teams') return 'teams';
  if (row.provider === 'gmeet' || row.assemblyai_id.startsWith('gmeet-')) return 'meet';
  if (row.source === 'uploaded') return 'file';
  return 'text';
}

export function sourceLabel(source: RecordingSource, opts: { mine?: boolean } = {}): string {
  switch (source) {
    case 'mac':
      return opts.mine === false ? 'a colleague’s Mac' : 'your Mac';
    case 'meet':
      return 'Google Meet';
    case 'teams':
      return 'Microsoft Teams';
    case 'file':
      return 'an uploaded file';
    case 'text':
      return 'a pasted transcript';
    default:
      return '';
  }
}

/** Provenance sentence for the source-glyph tooltip. */
export function provenanceTitle(row: ArchiveStripRow): string {
  const src = sourceOfArchiveRow(row);
  const base =
    src === 'mac'
      ? `Recorded with Darth Recorder on ${macOwnerLabel(row)}`
      : src === 'meet'
        ? 'Imported from Google Meet'
        : src === 'teams'
          ? 'Imported from Microsoft Teams'
          : src === 'file'
            ? 'Uploaded media file'
            : 'Imported transcript text';
  const auto =
    row.auto_state === 'passed'
      ? ' · auto-imported, speakers identified and summary generated without review'
      : row.auto_state === 'gated'
        ? ' · auto-imported, waiting on speaker review'
        : row.auto_state === 'auto'
          ? ' · auto-imported from a series'
          : '';
  const file = row.original_filename ? ` · ${row.original_filename}` : '';
  return `${base}${auto}${file}`;
}

/** Upload progress in one shape, whichever side knows more. */
function uploadProgress(row: ArchiveStripRow, opts: ArchiveStripOptions): StripProgress | null {
  const live = opts.live ?? null;
  const liveBytes = !!live && live.bytesSent != null && live.bytesTotal != null && live.bytesTotal > 0;
  const livePct = !!live && live.pct != null && Number.isFinite(live.pct);
  const isLive = liveBytes || livePct;
  const received = Number((liveBytes ? live!.bytesSent : row.upload_bytes_received) ?? 0);
  const total = Number((liveBytes ? live!.bytesTotal : row.upload_bytes_total) ?? 0);
  const partsTotal = Number(row.upload_parts_total ?? 0);
  const partsDone = Number(row.upload_parts_done ?? 0);
  const showParts = partsTotal > 1 && row.upload_parts_done != null;
  const partInFlight = Math.min(Math.max(partsDone, 0) + 1, partsTotal);
  const pct = livePct
    ? Math.max(0, Math.min(99, Math.round(live!.pct!)))
    : total > 0
      ? Math.min(99, Math.floor((received / total) * 100))
      : null;
  const clauses: string[] = [];
  if (showParts) clauses.push(`part ${partInFlight} of ${partsTotal}`);
  else if (pct != null) clauses.push(`${pct}%`);
  if (total > 0) clauses.push(`${opts.fmtBytes(received)} of ${opts.fmtBytes(total)}`);
  else if (received > 0) clauses.push(`${opts.fmtBytes(received)} so far`);
  if (clauses.length === 0 && pct == null) return null;
  return { pct, label: clauses.join(' · '), live: isLive };
}

/**
 * The strip for an archive row, or null when the row has nothing to say
 * (transcribed, one recording, not from a Mac — silence is the default).
 */
export function stripForArchiveRow(row: ArchiveStripRow, opts: ArchiveStripOptions): RecordingStripModel | null {
  const source = sourceOfArchiveRow(row);
  const mac = macOwnerLabel(row);
  const segs = segmentsWord(row.recording_count, source === 'mac' ? 'segment' : 'part');
  const dur = row.duration ? opts.fmtDuration(row.duration) : null;
  const isDefer = row.assemblyai_id.startsWith('defer-');
  const providerName = row.provider === 'teams' ? 'Microsoft' : 'Google';

  if (row.status === 'uploading') {
    const progress = uploadProgress(row, opts);
    const total = Number(row.upload_bytes_total ?? 0);
    const received = Number(row.upload_bytes_received ?? 0);
    if (!progress?.live && total > 0 && received >= total) {
      return {
        source,
        state: 'received',
        tone: 'busy',
        text: 'Upload received · handing off to transcription…',
        title: 'Every byte is on the server; AssemblyAI is being handed the file.',
        progress: null,
        action: null,
        busy: true,
      };
    }
    const lead = source === 'mac' ? `Uploading from ${mac}` : 'Uploading';
    return {
      source,
      state: 'uploading',
      tone: 'busy',
      text: progress ? `${lead} · ${progress.label}${progress.live ? ' · live' : ''}` : `${lead}…`,
      title:
        source === 'mac'
          ? 'Darth Recorder is pushing the recording up; the numbers are the whole recording, not one segment.'
          : 'Bytes are still arriving on the server.',
      progress,
      action: null,
      busy: true,
    };
  }

  if (row.status === 'waiting') {
    const what =
      row.deferred_mode === 'video'
        ? 'video file'
        : row.deferred_mode === 'both'
          ? 'video + transcript'
          : row.provider === 'teams'
            ? 'transcript'
            : 'transcript Doc';
    return {
      source,
      state: 'waiting',
      tone: 'warn',
      text: row.deferred_background
        ? 'Importing in the background · pulling the recording and submitting it'
        : `${providerName} is still preparing the ${what} · import runs itself`,
      title: 'Queued import — checked every minute; nothing to do.',
      progress: null,
      action: null,
      busy: true,
    };
  }

  if (row.status === 'processing' || row.status === 'queued') {
    return {
      source,
      state: 'transcribing',
      tone: 'busy',
      text: join(['Transcribing…', segs, dur]),
      title: 'AssemblyAI is working on it — open the row to share it or link the calendar event meanwhile.',
      progress: null,
      action: null,
      busy: true,
    };
  }

  if (row.status === 'error') {
    const reason = row.deferred_error?.trim() || null;
    const head = isDefer ? 'Import failed' : source === 'mac' || source === 'file' ? 'Upload failed' : 'Transcription failed';
    return {
      source,
      state: 'failed',
      tone: 'err',
      text: reason ? `${head} — ${reason}` : head,
      title: reason ?? 'The job did not finish.',
      progress: null,
      action: isDefer ? null : { kind: 'retry', label: 'Retry', title: 'Submit the stored file to transcription again' },
      busy: false,
    };
  }

  // Completed (or an unknown terminal status): only speak when there is
  // something a plain meeting would not have.
  if (source === 'mac') {
    return {
      source,
      state: 'transcribed',
      tone: 'muted',
      text: join([`Recorded on ${mac}`, segs, dur]),
      title: segs
        ? 'One recording — the recorder rolls a new segment on every screen-share change; they were stitched into one transcript.'
        : 'Recorded with Darth Recorder and transcribed as one file.',
      progress: null,
      action: null,
      busy: false,
    };
  }
  if ((row.recording_count ?? 1) > 1) {
    const head = source === 'meet' ? 'Meet recording' : source === 'teams' ? 'Teams recording' : 'Recording';
    return {
      source,
      state: 'transcribed',
      tone: 'muted',
      text: join([head, segs, dur]),
      title: 'Several source videos for one meeting (a stop/restart, a stitched upload or a combined re-transcription).',
      progress: null,
      action: null,
      busy: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Darth Recorder recordings on calendar rows (and in the Recordings tab)

export interface RecorderStripOptions {
  /** A tray is connected to THIS page. */
  trayConnected: boolean;
  fmtDuration: (s: number) => string;
  now?: number;
  /** When the caller last asked the owner (an ISO string) — shown instead of the button. */
  nudgedAt?: string | null;
}

export function stripForRecorderRef(rec: RecorderRecordingRef, opts: RecorderStripOptions): RecordingStripModel {
  const where = recorderMacLabel(rec);
  const dur = rec.durationS ? opts.fmtDuration(rec.durationS) : null;
  const started = rec.startedAt ? new Date(rec.startedAt).toLocaleString() : 'unknown time';
  const base = `Darth Recorder · started ${started}`;

  if (rec.status === 'uploaded' && rec.transcriptId) {
    return {
      source: 'mac',
      state: 'transcribed',
      tone: 'ok',
      text: join([`Recorded on ${where}`, dur, 'uploaded']),
      title: `${base} · uploaded and transcribed`,
      progress: null,
      action: { kind: 'open', label: 'Open transcript' },
      busy: false,
    };
  }
  if (rec.status === 'uploading') {
    return {
      source: 'mac',
      state: 'uploading',
      tone: 'busy',
      text: join([`Uploading from ${where}`, dur]),
      title: `${base} · the upload is running now`,
      progress: null,
      action: null,
      busy: true,
    };
  }
  if (rec.status === 'recording') {
    const startedMs = rec.startedAt ? Date.parse(rec.startedAt) : NaN;
    const stale = Number.isFinite(startedMs) && (opts.now ?? Date.now()) - startedMs > RECORDING_STALE_MS;
    if (stale) {
      return {
        source: 'mac',
        state: 'on-mac',
        tone: 'muted',
        text: join([`Recording on ${where} never finished`, dur]),
        title: `${base} · the recorder stopped reporting on it; if the file exists it shows under Recordings`,
        progress: null,
        action: null,
        busy: false,
      };
    }
    return {
      source: 'mac',
      state: 'recording',
      tone: 'busy',
      text: `Recording on ${where} now…`,
      title: `${base} · the call is still being recorded`,
      progress: null,
      action: null,
      busy: true,
    };
  }
  const failed = rec.status === 'upload_failed';
  if (rec.mine) {
    return {
      source: 'mac',
      state: failed ? 'failed' : 'on-mac',
      tone: failed ? 'err' : 'warn',
      text: join([`On your Mac`, dur, failed ? 'upload failed' : 'not uploaded yet']),
      title: `${base} · the file is still on this Mac — upload it to transcribe it`,
      progress: null,
      action: opts.trayConnected
        ? { kind: 'upload', label: failed ? 'Retry upload' : 'Upload', title: 'Upload it from this Mac now — it transcribes itself' }
        : { kind: 'open-recorder', label: 'Open Darth Recorder', title: 'Darth Recorder is not connected to this page; open the tray on the Mac that holds the file' },
      busy: false,
    };
  }
  const first = recorderOwnerFirstName(rec.ownerEmail);
  const askedAt = opts.nudgedAt ? new Date(opts.nudgedAt) : null;
  return {
    source: 'mac',
    state: failed ? 'failed' : 'on-mac',
    tone: failed ? 'err' : 'warn',
    text: join([`On ${where}`, dur, failed ? 'upload failed' : null]),
    title: `${base} · only ${first} can upload it — asking sends them a Darth DM (once per 6 h)`,
    progress: null,
    action: askedAt && !Number.isNaN(askedAt.getTime())
      ? null
      : { kind: 'nudge', label: `Ask ${first} to upload`, title: `Send ${first} a Darth DM asking for this recording` },
    busy: false,
  };
}

// ---------------------------------------------------------------------------
// Calendar rows — the cloud state

export interface CalendarStripRow {
  provider: 'gmeet' | 'teams';
  hasMeet: boolean;
  hasRecording: boolean;
  hasTranscript: boolean;
  recordingCount: number;
  recordingPreparing: boolean;
  transcriptPreparing: boolean;
  durationSecs: number | null;
  recordingState: string | null;
  transcriptState: string | null;
  evidenceCheckedAt: string | null;
  layer: 'unimported' | 'norec';
}

export function stripForCalendarRow(
  row: CalendarStripRow,
  opts: { fmtDuration: (s: number) => string; canImport: boolean }
): RecordingStripModel | null {
  const source: RecordingSource = row.provider === 'teams' ? 'teams' : row.hasMeet ? 'meet' : 'none';
  const providerName = row.provider === 'teams' ? 'Microsoft' : 'Google';
  const dur = row.durationSecs ? opts.fmtDuration(row.durationSecs) : null;

  if (row.hasRecording || row.hasTranscript) {
    const what = join([
      row.hasRecording ? `Recording${row.recordingCount > 1 ? ` ×${row.recordingCount}` : ''} at ${providerName}` : null,
      row.hasTranscript ? (row.hasRecording ? 'transcript' : `Transcript at ${providerName}`) : null,
      dur,
    ]);
    return {
      source,
      state: 'cloud-available',
      tone: 'ok',
      text: what,
      title: `${providerName} holds the artifacts — importing pulls them into Darth Meetings.`,
      progress: null,
      action: opts.canImport ? { kind: 'import', label: 'Import…' } : null,
      busy: false,
    };
  }
  if (row.recordingPreparing || row.transcriptPreparing) {
    return {
      source,
      state: 'cloud-preparing',
      tone: 'warn',
      text: `${providerName} is still preparing the ${row.recordingPreparing ? 'recording' : 'transcript'}`,
      title: 'Listed at the provider but the file is not generated yet — usually minutes.',
      progress: null,
      action: null,
      busy: true,
    };
  }
  if (row.layer === 'norec' && row.recordingState === 'none' && row.transcriptState === 'none') {
    const at = row.evidenceCheckedAt
      ? ` (checked ${new Date(row.evidenceCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
      : '';
    return {
      source,
      state: 'none',
      tone: 'muted',
      text: `Nothing at ${providerName}${at}`,
      title: `${providerName} was asked and listed neither a recording nor a transcript for this occurrence. Recap artifacts usually land minutes after the call — check again from the menu.`,
      progress: null,
      action: null,
      busy: false,
    };
  }
  return null;
}

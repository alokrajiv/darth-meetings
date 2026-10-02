/**
 * The owner's view of a STANDALONE recording on the wire (design P7) — the
 * client-side twin of `RecordingView` in lib/server/recording-actions.ts,
 * re-declared here so no server module reaches the client bundle — and the
 * one sentence its recording strip says. Pure.
 */
import type { SuggestedEvent } from '@/lib/format';
import type { RecordingStripModel } from '@/lib/recording-strip';

export type RecordingViewStatus = 'uploading' | 'transcribing' | 'ready' | 'failed';

export interface RecordingViewWire {
  id: string;
  pseudo_id: string;
  title: string | null;
  source_kind: string;
  status: RecordingViewStatus;
  status_note: string | null;
  started_at: string | null;
  created_at: string;
  duration_sec: number | null;
  speaker_count: number | null;
  language_code: string | null;
  original_filename: string | null;
  bytes: number | null;
  has_video: boolean | null;
  part_count: number;
  expires_at: string | null;
  temporary: boolean;
  upload: { bytes_received: number | null; bytes_total: number | null } | null;
  meetings: Array<{ id: string; title: string | null; trashed: boolean }>;
  in_meeting: boolean;
  suggested_event: SuggestedEvent | null;
  recorder_recording_id: string | null;
  /** The call app the Darth Recorder saw, when it came from one (2026-10-02; absent on older servers). */
  source_app?: string | null;
}

/** "Recording · Sat 20 Sept 22:00" when it has no title of its own — never the filename. */
export function recordingDisplayTitle(
  r: Pick<RecordingViewWire, 'title' | 'started_at' | 'created_at'>,
  when: (iso: string) => string
): string {
  const t = r.title?.trim();
  if (t) return t;
  const w = when(r.started_at ?? r.created_at);
  return w ? `Recording · ${w}` : 'Recording';
}

/** "expires in 12 days" / "expires today" for a recording with an expiry (P8). */
export function expiresCopy(expiresAt: string | null, now: number = Date.now()): string | null {
  if (!expiresAt) return null;
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days <= 0) return 'expires today';
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

/** The strip model for a standalone recording: uploading / transcribing / transcribed / failed. */
export function stripForRecordingView(
  r: RecordingViewWire,
  opts: {
    live?: { pct: number } | null;
    fmtBytes: (n: number) => string;
    fmtDuration: (s: number) => string;
  }
): RecordingStripModel {
  const source = r.source_kind === 'recorder' ? 'mac' : 'file';
  if (r.status === 'uploading') {
    const total = r.upload?.bytes_total ?? null;
    const got = r.upload?.bytes_received ?? null;
    const pct =
      opts.live?.pct ?? (total && got != null && total > 0 ? Math.min(100, (got / total) * 100) : null);
    const text = [
      `Uploading${pct != null ? ` · ${Math.round(pct)}%` : ''}`,
      got != null && total ? `${opts.fmtBytes(got)} of ${opts.fmtBytes(total)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      source,
      state: 'uploading',
      tone: 'busy',
      text,
      title: r.original_filename,
      progress: pct != null ? { pct, label: text, live: !!opts.live } : null,
      action: null,
      busy: true,
    };
  }
  if (r.status === 'transcribing') {
    return {
      source,
      state: 'transcribing',
      tone: 'busy',
      text: 'Uploaded · transcribing…',
      title: r.original_filename,
      progress: null,
      action: null,
      busy: true,
    };
  }
  if (r.status === 'failed') {
    return {
      source,
      state: 'failed',
      tone: 'err',
      text: r.status_note ?? 'Transcription failed',
      title: r.original_filename,
      progress: null,
      action: null,
      busy: false,
    };
  }
  return {
    source,
    state: 'transcribed',
    tone: 'muted',
    text: [
      'Transcribed',
      r.duration_sec ? opts.fmtDuration(r.duration_sec) : null,
      r.speaker_count ? `${r.speaker_count} speaker${r.speaker_count === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    title: r.original_filename,
    progress: null,
    action: null,
    busy: false,
  };
}

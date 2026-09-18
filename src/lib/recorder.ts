/**
 * Darth Recorder — shapes shared by the server (routes, db-ops, matcher) and
 * the client (listing rows, recorder card). No server imports: this module is
 * pulled into the browser bundle.
 *
 * See docs/recorder-beta-plan.md. The tray's own wire protocol lives in
 * src/lib/companion/companion-client.ts (Stream S2).
 */

/** One calendar occurrence a recording could belong to. */
export interface RecorderMatchCandidate {
  event_key: string;
  event_id: string | null;
  meeting_code: string | null;
  /** UTC ISO of the occurrence start — the instant every other surface keys on. */
  occ_start: string;
  title: string | null;
  /** 0..1 — how much of the shorter of (recording, event) they share. */
  overlap: number;
  /** 0..1 — token overlap between the call window title and the event title. */
  title_score: number;
  /** 0..1 — the blended score the best-match decision uses. */
  score: number;
}

/** What `matchRecording()` stores on `recorder_recordings.matched`. */
export interface RecorderMatch extends RecorderMatchCandidate {
  /** Up to 3 runners-up, best first — why this one won. */
  candidates: RecorderMatchCandidate[];
  matched_at: string;
}

/** Recording summary a calendar listing row carries (redacted for non-owners:
 * no local paths, no segment list, no window titles). */
export interface RecorderRecordingRef {
  id: string;
  /** The caller owns it → they can drive the tray directly. */
  mine: boolean;
  ownerEmail: string | null;
  /** Owner's Mac hostname when the device registered one. */
  hostname: string | null;
  status: string;
  startedAt: string | null;
  durationS: number | null;
  /** Set once the upload finalized — link straight to the transcript. */
  transcriptId: string | null;
  /** When the CALLER last nudged the owner about it (6 h rate-limit window). */
  nudgedAt: string | null;
}

/** "Ben" from ben.tan@trames.sg / "Ben Tan" — possessive-friendly first name. */
export function recorderOwnerFirstName(email: string | null | undefined): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const first = local.split(/[._-]+/).filter(Boolean)[0] ?? '';
  if (!first) return 'a colleague';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** "your Mac" / "Ben's Mac" / "Ben's Mac (ben-mbp)". */
export function recorderMacLabel(rec: RecorderRecordingRef): string {
  if (rec.mine) return 'your Mac';
  return `${recorderOwnerFirstName(rec.ownerEmail)}'s Mac`;
}

export type RecorderRowAction = 'upload' | 'nudge' | 'open' | null;

/** A `recording` row older than this is treated as one the tray lost, not a live call. */
export const RECORDING_STALE_MS = 12 * 3600_000;

/**
 * The line a calendar row shows when a Darth Recorder recording matched the
 * occurrence — it REPLACES the "recorded elsewhere — not importable here"
 * Teams-chat verdict (which moves into the tooltip). `originalNote` is that
 * verdict text.
 */
export function recorderRowCopy(
  rec: RecorderRecordingRef,
  opts: { durationText?: string | null; originalNote?: string | null; now?: number } = {}
): { text: string; action: RecorderRowAction; actionLabel: string | null; title: string } {
  const where = recorderMacLabel(rec);
  const dur = opts.durationText ? ` (${opts.durationText})` : '';
  const tail = opts.originalNote ? ` · ${opts.originalNote}` : '';
  const seen = rec.startedAt ? new Date(rec.startedAt).toLocaleString() : 'unknown time';
  const base = `Darth Recorder · started ${seen}${tail}`;

  if (rec.status === 'uploaded' && rec.transcriptId) {
    return {
      text: `Recorded on ${where}${dur} · uploaded`,
      action: 'open',
      actionLabel: 'Open transcript',
      title: `${base} · already uploaded and transcribed`,
    };
  }
  if (rec.status === 'uploading') {
    return {
      text: `Uploading from ${where}${dur}…`,
      action: null,
      actionLabel: null,
      title: `${base} · the upload is running now`,
    };
  }
  if (rec.status === 'recording') {
    // A row the tray never moved on (a process that died mid-recording; trays
    // before 0.3.7 also never told the server about a failed capture) is not
    // "now…" a day later — 80eddbe9 sat like that on its calendar row.
    const startedMs = rec.startedAt ? Date.parse(rec.startedAt) : NaN;
    const stale = Number.isFinite(startedMs) && (opts.now ?? Date.now()) - startedMs > RECORDING_STALE_MS;
    if (stale) {
      return {
        text: `Recording on ${where} never finished${dur}`,
        action: null,
        actionLabel: null,
        title: `${base} · the recorder stopped reporting on it; if the file exists it shows under Settings › Darth Recorder`,
      };
    }
    return {
      text: `Recording on ${where} now…`,
      action: null,
      actionLabel: null,
      title: `${base} · the call is still being recorded`,
    };
  }
  const failed = rec.status === 'upload_failed';
  if (rec.mine) {
    return {
      text: `Recorded on your Mac${dur}${failed ? ' · upload failed' : ''}`,
      action: 'upload',
      actionLabel: failed ? 'Retry upload' : 'Upload',
      title: `${base} · the file is still on this Mac — upload it to transcribe it`,
    };
  }
  return {
    text: `Recorded on ${where}${dur}${failed ? ' · upload failed' : ''}`,
    action: 'nudge',
    actionLabel: 'Ask to upload',
    title: `${base} · only ${recorderOwnerFirstName(rec.ownerEmail)} can upload it — asking sends them a Darth DM`,
  };
}

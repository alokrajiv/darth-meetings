import type { SuggestedEvent } from '@/lib/format';

/**
 * Darth Recorder — shapes shared by the server (routes, db-ops, matcher) and
 * the client (listing rows, recorder card). No server imports: this module is
 * pulled into the browser bundle.
 *
 * See docs/recorder-beta-plan.md. The tray's own wire protocol lives in
 * src/lib/companion/companion-client.ts (Stream S2).
 */

/**
 * The conferencing product behind a call or a calendar occurrence, as far as
 * we can tell. `null` = unknown, which never vetoes anything (D3).
 *
 * The call side comes from the tray's `call.kind` (CallDetector.CallKind);
 * the occurrence side is derived from the invite (Meet code, Teams/Zoom/Webex
 * join URL) — see `occurrenceProvider()` in lib/server/recorder-match.ts.
 */
export type ConferenceProvider =
  | 'meet'
  | 'teams'
  | 'zoom'
  | 'slack'
  | 'webex'
  | 'facetime'
  | 'whatsapp'
  | 'discord';

const CALL_KIND_PROVIDERS = new Set<string>([
  'meet', 'teams', 'zoom', 'slack', 'webex', 'facetime', 'whatsapp', 'discord',
]);

/**
 * The tray's `call.kind` as a provider, or null when it tells us nothing:
 * 'browser' (a browser window whose title named no product) and 'other' are
 * "unknown", NOT "something else" — they must never veto a match.
 */
export function callProvider(
  call: { kind?: unknown } | null | undefined
): ConferenceProvider | null {
  const kind = typeof call?.kind === 'string' ? call.kind.trim().toLowerCase() : '';
  return CALL_KIND_PROVIDERS.has(kind) ? (kind as ConferenceProvider) : null;
}

/** Product names the tray appends to a window title, longest first. */
const APP_SUFFIXES = [
  'microsoft teams',
  'google chrome',
  'google meet',
  'slack',
  'zoom workplace',
  'zoom',
  'webex',
  'discord',
  'whatsapp',
  'facetime',
  'safari',
  'arc',
  'firefox',
  'microsoft edge',
];

/**
 * The call's OWN title, cleaned of the app suffix — the name an unlinked
 * recording is born with (D1): `"Swaralee (DM) - Slack"` → `"Swaralee (DM)"`,
 * `"MSC Contract review | Microsoft Teams"` → `"MSC Contract review"`.
 * Returns null when nothing usable is left (an empty title, or a title that
 * was only the app name) so the caller falls back to the filename.
 */
export function recorderCallTitle(
  call: { title?: unknown; app?: unknown } | null | undefined
): string | null {
  const raw = typeof call?.title === 'string' ? call.title.trim() : '';
  if (!raw) return null;
  // Window titles are " - " / " | " / " — " joined segments; the call's own
  // name is the FIRST one and everything after it is chrome: the product
  // ("Slack", "Microsoft Teams"), the workspace/company ("Trames Pte Ltd"),
  // notification counts ("2 new items"), a window tag ("[Main]") and emoji.
  // Drop trailing segments while they look like chrome; keep the rest.
  const segs = raw.split(/\s+(?:[|\u2013\u2014-])\s+/);
  while (segs.length > 1 && isTitleChrome(segs[segs.length - 1]!)) segs.pop();
  let out = segs.join(' - ').trim();
  // A lone tag/emoji tail glued without a separator ("Slack [Main] 🏠").
  out = out.replace(/\s*\[[^\]]{0,40}\]\s*[\p{Extended_Pictographic}\s]*$/u, '').trim();
  const app = typeof call?.app === 'string' ? call.app.trim().toLowerCase() : '';
  if (!out || out.toLowerCase() === app || isTitleChrome(out)) return null;
  return out.slice(0, 300);
}

/** Is this title segment window chrome rather than the call's name? */
function isTitleChrome(segRaw: string): boolean {
  const seg = segRaw
    .replace(/\[[^\]]{0,40}\]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .trim()
    .toLowerCase();
  if (!seg) return true;
  if (APP_SUFFIXES.includes(seg)) return true;
  if (/^\d+\s+new\s+items?$/.test(seg)) return true; // Slack's unread counter
  if (/\b(pte\.?\s*ltd\.?|ltd\.?|inc\.?|llc|gmbh|plc|corp\.?|limited)$/.test(seg)) return true; // a company
  return false;
}

/** One calendar occurrence a recording could belong to. */
export interface RecorderMatchCandidate {
  event_key: string;
  event_id: string | null;
  meeting_code: string | null;
  /** UTC ISO of the occurrence start — the instant every other surface keys on. */
  occ_start: string;
  /** UTC ISO of the occurrence end, when the invite has one. Absent on rows
   * matched before 2026-09-22. */
  occ_end?: string | null;
  title: string | null;
  /** 0..1 — how much of the shorter of (recording, event) they share. */
  overlap: number;
  /** 0..1 — token overlap between the call window title and the event title. */
  title_score: number;
  /** 0..1 — the blended score the best-match decision uses. */
  score: number;
  /** The occurrence's own conferencing product, when the invite says
   * (D3). Absent on rows matched before 2026-09-22. */
  provider?: ConferenceProvider | null;
  /** The call and the occurrence are known to be DIFFERENT products (a Slack
   * huddle against a Google Meet invite) — `score` is capped for it and it
   * can never be confident. */
  provider_mismatch?: boolean;
}

/** What `matchRecording()` stores on `recorder_recordings.matched`. */
export interface RecorderMatch extends RecorderMatchCandidate {
  /** Up to 3 runners-up, best first — why this one won. */
  candidates: RecorderMatchCandidate[];
  matched_at: string;
  /** What the TRAY said this call was (`call.kind` → provider), when it is
   * one we know. The other half of the D3 veto. */
  call_provider?: ConferenceProvider | null;
  /** `recorderMatchIsConfident(this)` at match time — the ONE bit the tray
   * reads before it asks "Link to …?" (rows matched before 2026-09-22 17:00
   * SGT have no bit and are treated as not confident). */
  confident?: boolean;
}

/**
 * Is a registry row's match one a surface may SHOW as a suggestion? The
 * server's own bit when the row carries one (`matched_confident`, computed
 * by lib/server/recorder-view from the function below), the shared
 * definition otherwise — never the raw score.
 *
 * F3: until P3 the Recordings surface rendered EVERY match, however weak,
 * with a one-click "Link to it". That is how a Slack DM was offered the
 * Hypercare Teams invite at 0.3 on 2026-09-22 17:03, hours after the tray
 * and the calendar strip had both been taught to ask only on confidence. A
 * weak match stays on the row for the record; it is not a suggestion, and
 * it is never one click from a link.
 */
export function recorderRowIsConfident(
  row: { matched: RecorderMatch | null; matched_confident?: boolean } | null | undefined
): boolean {
  if (!row?.matched) return false;
  if (typeof row.matched_confident === 'boolean') return row.matched_confident;
  return recorderMatchIsConfident(row.matched);
}

/** The confidence floor: below either number the match is weak. */
export const RECORDER_AUTOLINK_MIN_SCORE = 0.6;
export const RECORDER_AUTOLINK_MIN_OVERLAP = 0.5;

/**
 * Is a Darth Recorder match a CONFIDENT one — "this recording really is that
 * meeting"? The ONE definition: the tray, darth-cli and every older client
 * inherit it because it is computed server-side.
 *
 * Since docs/recorder-link-confirm-spec.md D1 nothing links on the strength
 * of it any more — linking is a user action on either surface. It still
 * decides how the suggestion is worded and ordered, and the tray reads the
 * match it is computed from.
 *
 * D3 raised the bar after the 2026-09-22 incident, where a Slack huddle
 * scored exactly 0.7 on a Google Meet invite purely because the clocks
 * overlapped (overlap 1 × 0.7 + title 0 × 0.3):
 *   - time overlap ALONE is never confidence — the title must agree at all,
 *     or the two must at least be the same product;
 *   - a known product mismatch is never confidence, whatever the numbers
 *     (the matcher also caps such a candidate at PROVIDER_MISMATCH_CAP).
 */
export function recorderMatchIsConfident(
  matched:
    | Partial<
        Pick<
          RecorderMatch,
          'event_key' | 'score' | 'overlap' | 'title_score' | 'provider' | 'call_provider'
        >
      >
    | null
    | undefined
): boolean {
  if (!matched) return false;
  const key = typeof matched.event_key === 'string' ? matched.event_key.trim() : '';
  if (!key) return false;
  const { score, overlap, title_score: titleScore, provider, call_provider: callProv } = matched;
  const numbersClear =
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score >= RECORDER_AUTOLINK_MIN_SCORE &&
    typeof overlap === 'number' &&
    Number.isFinite(overlap) &&
    overlap >= RECORDER_AUTOLINK_MIN_OVERLAP;
  if (!numbersClear) return false;
  // Known-and-different products: never.
  if (provider && callProv && provider !== callProv) return false;
  const titleAgrees = typeof titleScore === 'number' && Number.isFinite(titleScore) && titleScore > 0;
  const sameProvider = !!provider && !!callProv && provider === callProv;
  return titleAgrees || sameProvider;
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
  /** The meeting this recording is LINKED to, and only when the caller can
   * already open it (P1). Unlinked is null: there is no meeting to open
   * from here, and for somebody ELSE's recording there never is. */
  transcriptId: string | null;
  /** `mine` rows only: the meeting the caller's own upload produced, linked
   * to this occurrence or not. The owner may always reach their own
   * recording, so this is what "Open recording" opens. */
  ownTranscriptId: string | null;
  /** `mine` rows only: the live suggestion on that meeting when it names
   * this occurrence — the SuggestedEventStrip's input, so the Link and
   * "Not this" buttons run the paths that already exist. */
  suggestedEvent: SuggestedEvent | null;
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

export type RecorderRowAction = 'upload' | 'open' | null;

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
  // Somebody else's recording. It reaches this caller only through a meeting
  // they can open (P1/P2), so there is nothing for them to do with it here —
  // and nothing to ask: "Ask X to upload" was an action on a private
  // recording, handed out on a machine match.
  return {
    text: `Recorded on ${where}${dur}${failed ? ' · upload failed' : ''}`,
    action: null,
    actionLabel: null,
    title: `${base} · only ${recorderOwnerFirstName(rec.ownerEmail)} can upload it`,
  };
}

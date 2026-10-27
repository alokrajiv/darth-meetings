import type { StoredTranscript } from '@/lib/format';
import { autoMarkerOf } from '@/lib/auto-marker';
import { storedReportPref } from '@/lib/report-pref';

/**
 * Grace-window auto-proceed for MANUAL rows (2026-10-27): a tray upload with
 * every voice identified confidently (voice 0.87 / 0.90, id 0.93) still had
 * no summary 40 minutes later, because nobody clicked "Review speakers &
 * generate" and only automation-marked rows jump the gate. Alok: "if the AI
 * is fairly sure, just make the summary anyway if there's no update in 10
 * min".
 *
 * So: a completed row without an automation marker whose speaker-ID pass
 * finished AUTO_PROCEED_GRACE_MIN ago, with nobody having acted since, is
 * evaluated ONCE by the sweeper with the same thresholds as the series path
 * (lib/auto-review-eval.ts). The person can Hold it on the detail page.
 *
 * This module is the ONE eligibility rule, pure, read by: the detail page's
 * `autoProceedAt` API field, the listing row's `auto_proceed_at`, and the
 * server's re-check before it acts. `listAutoProceedBacklog` in
 * db-ops/transcripts.ts is its SQL twin for the sweeper's pick; a test pins
 * both to the same predicate list.
 */

function envInt(name: string, fallback: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Minutes after the speaker pass finished before the summary is written. */
export const AUTO_PROCEED_GRACE_MIN = envInt('MW_AUTO_PROCEED_GRACE_MIN', 10);
/** Rows whose pass finished longer ago than this are never backfilled. */
export const AUTO_PROCEED_WINDOW_HOURS = 48;

/** The row facts the rule reads — fed from a full row or the listing's columns. */
export interface AutoProceedFacts {
  status: string;
  deleted_at?: string | null;
  speaker_id_status: string | null;
  speaker_id_at: string | null;
  /** Notes text exists (`auto_notes` non-empty). */
  hasNotes: boolean;
  auto_notes_status: string | null;
  auto_report_status: string | null;
  /** `gmeet_context.autoReview` is set (evaluated, or held) — once, ever. */
  autoReviewed: boolean;
  /** `gmeet_context.uploadPrefs.report` as stored (read via storedReportPref). */
  reportPref: string | null | undefined;
  /** The row carries an automation marker (series / account auto-import):
   * those rows are evaluated at completion by the existing path instead. */
  autoMarked: boolean;
}

export function autoProceedFactsOf(row: StoredTranscript): AutoProceedFacts {
  const ctx = row.gmeet_context;
  return {
    status: row.status,
    deleted_at: row.deleted_at ?? null,
    speaker_id_status: row.speaker_id_status,
    speaker_id_at: row.speaker_id_at,
    hasNotes: !!row.auto_notes && row.auto_notes !== '',
    auto_notes_status: row.auto_notes_status,
    auto_report_status: row.auto_report_status,
    autoReviewed: !!ctx?.autoReview,
    reportPref: ctx?.uploadPrefs?.report ?? null,
    autoMarked: !!autoMarkerOf(ctx),
  };
}

/**
 * When the summary will be written automatically (ISO), or null when the row
 * is not eligible: not a completed live row, the speaker pass has not
 * finished, notes or a run already exist, it was evaluated or held, the
 * upload asked for 'later', automation already owns it, or the pass finished
 * more than AUTO_PROCEED_WINDOW_HOURS ago. The moment may be in the past
 * (the sweeper runs every few minutes) — the UI words it as "at HH:MM".
 */
export function autoProceedAt(
  f: AutoProceedFacts,
  now: Date = new Date(),
  opts: { graceMin?: number; windowHours?: number } = {}
): string | null {
  const graceMin = opts.graceMin ?? AUTO_PROCEED_GRACE_MIN;
  const windowHours = opts.windowHours ?? AUTO_PROCEED_WINDOW_HOURS;
  if (f.status !== 'completed' || f.deleted_at) return null;
  if (f.speaker_id_status !== 'completed' || !f.speaker_id_at) return null;
  const at = new Date(f.speaker_id_at).getTime();
  if (!Number.isFinite(at)) return null;
  if (f.hasNotes || f.auto_notes_status !== null || f.auto_report_status !== null) return null;
  if (f.autoReviewed || f.autoMarked) return null;
  if (storedReportPref(f.reportPref) === 'later') return null;
  if (at <= now.getTime() - windowHours * 3_600_000) return null;
  return new Date(at + graceMin * 60_000).toISOString();
}

/** True when the sweeper should act on it now: eligible and the grace is over. */
export function autoProceedDue(f: AutoProceedFacts, now: Date = new Date()): boolean {
  const at = autoProceedAt(f, now);
  return at !== null && new Date(at).getTime() <= now.getTime();
}

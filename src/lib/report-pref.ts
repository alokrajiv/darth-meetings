/**
 * ONE definition of "what does a generation run produce for this row".
 *
 * As built 2026-09-21 (Alok): a generation ALWAYS writes both tiers — the
 * quick summary AND the detailed report. Firing the report is what produces
 * both: `generateAutoReport` distils the summary from its own session when it
 * lands (lib/server/auto-notes.ts), so "summary" is never a run of its own.
 * The only choice left is the detailed report's flavour — with video frames
 * or text-only — plus `later`, which generates nothing for now.
 *
 * `summary` was the old summary-only value. It is GONE from the type but is
 * still accepted wherever a value arrives from outside this build — an old
 * darth-cli, an old browser tab, and prefs stored before today in
 * `gmeet_context.uploadPrefs.report`, `series.auto_import.report` and
 * `user_prefs.auto_sync_report`. Every entry point funnels through
 * `normalizeReportPref` / `storedReportPref`, which read it as the detailed
 * default, so nothing 400s and no migration is needed.
 *
 * Client-safe (no server-only import): the upload stepper, the settings card
 * and the series dialog all render from it.
 */

export const REPORT_PREFS = ['detailed-video', 'detailed-text', 'later'] as const;
export type ReportPref = (typeof REPORT_PREFS)[number];

/** The retired summary-only value — accepted on the wire, never stored again. */
export const LEGACY_SUMMARY_PREF = 'summary';

/**
 * The default generation for a row: the detailed report with video frames
 * when there is (or will be) video, text-only otherwise. Callers that cannot
 * know yet pass `true` — `generateAutoReport` degrades to a text-only run on
 * its own when the file turns out to have no video stream.
 */
export function defaultReportPref(hasVideo: boolean): ReportPref {
  return hasVideo ? 'detailed-video' : 'detailed-text';
}

function isReportPref(raw: string): raw is ReportPref {
  return (REPORT_PREFS as readonly string[]).includes(raw);
}

/**
 * Parse a value that arrived from outside: a query param, a JSON body, a
 * stored pref. Returns null for "nothing recognisable was asked for" — the
 * caller decides whether that means "leave unset" or "use the default".
 * Legacy 'summary' is read as the detailed default.
 */
export function normalizeReportPref(
  raw: string | null | undefined,
  hasVideo = true
): ReportPref | null {
  if (!raw) return null;
  if (raw === LEGACY_SUMMARY_PREF) {
    const mapped = defaultReportPref(hasVideo);
    console.log(
      `[report-pref] legacy 'summary' read as '${mapped}' — summary-only generation was removed 2026-09-21; every run writes both tiers`
    );
    return mapped;
  }
  return isReportPref(raw) ? raw : null;
}

/** Wire/param parser — `null` when nothing valid was asked for. */
export function parseReportPref(raw: string | null | undefined): ReportPref | null {
  return normalizeReportPref(raw);
}

/** A stored pref read back, never null: unset / unrecognised → the default. */
export function storedReportPref(
  raw: string | null | undefined,
  hasVideo = true
): ReportPref {
  return normalizeReportPref(raw, hasVideo) ?? defaultReportPref(hasVideo);
}

/** Strength order — the resolver never lowers what someone asked for. */
const REPORT_RANK: Record<ReportPref, number> = {
  later: 0,
  'detailed-text': 1,
  'detailed-video': 2,
};

/** The strongest of several report preferences (undefined/null ignored). */
export function strongestReport(prefs: Array<string | null | undefined>): ReportPref {
  let best: ReportPref = 'later';
  for (const raw of prefs) {
    const p = normalizeReportPref(raw);
    if (p && REPORT_RANK[p] > REPORT_RANK[best]) best = p;
  }
  return best;
}

/** How a pref reads in DM copy, the provenance strip and settings cards.
 * Both tiers are always named, because both are always written. */
export function reportLabel(pref: string | null | undefined): string {
  switch (normalizeReportPref(pref)) {
    case 'detailed-video':
      return 'summary + detailed report with video frames';
    case 'detailed-text':
      return 'summary + detailed report';
    case 'later':
      return 'nothing (decide on the page)';
    default:
      return 'summary + detailed report';
  }
}

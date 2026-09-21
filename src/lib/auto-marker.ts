/**
 * ONE shape for "this row was imported by automation" — whichever sweep did
 * it. Storage keeps two keys on gmeet_context (`autoImport` = the per-series
 * sweep, `autoSync` = the account sweep) because rows from before 2026-09-08
 * carry them; every reader goes through autoMarkerOf() so there is exactly
 * one notion of importer / watchers / report from here on.
 *
 * Client-safe (no server-only import) — the transcript page renders the
 * provenance strip from it.
 */

import type { GmeetContext } from '@/lib/format';

/**
 * Report prefs live in lib/report-pref (client + server, one definition).
 * Re-exported here because every automation reader already imports them
 * from the marker module.
 */
export { strongestReport, reportLabel, type ReportPref } from '@/lib/report-pref';

export interface AutoMarker {
  source: 'series' | 'account';
  seriesId: number | null;
  seriesTitle: string | null;
  occKey: string;
  /** The elected importer — their connection ran the import, they own the row. */
  byUserId: string;
  byEmail: string;
  /** Everyone else automation acted for: shared onto the row, DM'd at every stage. */
  watchers: string[];
  at: string;
}

export function autoMarkerOf(ctx: GmeetContext | null | undefined): AutoMarker | null {
  const ai = ctx?.autoImport;
  if (ai) {
    return {
      source: 'series',
      seriesId: ai.seriesId,
      seriesTitle: ai.seriesTitle ?? null,
      occKey: ai.occKey,
      byUserId: ai.byUserId,
      byEmail: ai.byEmail,
      watchers: ai.watchers ?? [],
      at: ai.at,
    };
  }
  const as = ctx?.autoSync;
  if (as) {
    return {
      source: 'account',
      seriesId: null,
      seriesTitle: null,
      occKey: as.occKey,
      byUserId: as.byUserId,
      byEmail: as.byEmail,
      watchers: as.watchers ?? [],
      at: as.at,
    };
  }
  return null;
}

/** Importer + watchers, lower-cased and de-duplicated — the DM audience. */
export function autoRecipients(m: AutoMarker | null): string[] {
  if (!m) return [];
  return [...new Set([m.byEmail, ...m.watchers].map((e) => e.toLowerCase()))];
}

/** How to name the source in DMs / the provenance strip. */
export function autoSourceLabel(m: AutoMarker): string {
  return m.source === 'series' ? `series *${m.seriesTitle ?? m.seriesId}*` : 'account auto-sync';
}

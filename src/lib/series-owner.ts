/**
 * Who may DELETE or MERGE a series (tech-debt D4, 2026-09-18).
 *
 * Series rows are org-global and every read surface is scoped through
 * visibleSeriesIds — but visibility (you attend the call, or hold one shared
 * member) was also the only gate on destructive edits, so any attendee could
 * delete a series or fold it into another. The minimal ownership rule:
 *   (a) the caller is the organiser of at least one attached occurrence —
 *       a live member transcript whose calendar context names them as
 *       organizer (gmeet_context.organizerEmail, Meet and Teams alike), or
 *   (b) the caller created the series (series.created_by — the importer whose
 *       auto-attach spawned it, or the user who clicked "new series").
 * Nobody is special-cased. Renames/notes/auto-import config stay at
 * visibility (collaborative curation); only delete + merge are ownership.
 *
 * Pure + client-safe: db-ops/series fetches the facts, this decides.
 */

export interface SeriesManagementFacts {
  /** series.created_by (UUID); null only for rows older than the column. */
  createdBy: string | null;
  /** Lower-cased organizer emails over the series' LIVE member transcripts. */
  memberOrganizerEmails: readonly string[];
}

export interface SeriesCaller {
  userId: string;
  email: string;
}

export type SeriesManageVerdict =
  | { ok: true; via: 'organizer' | 'creator' }
  | { ok: false; reason: string };

export const SERIES_NOT_MANAGER_MESSAGE =
  'Only the organiser of one of its meetings or the user who created the series can delete or merge it';

export function seriesManageVerdict(
  facts: SeriesManagementFacts,
  caller: SeriesCaller
): SeriesManageVerdict {
  const email = caller.email.trim().toLowerCase();
  if (email && facts.memberOrganizerEmails.some((e) => e.trim().toLowerCase() === email)) {
    return { ok: true, via: 'organizer' };
  }
  if (facts.createdBy && facts.createdBy === caller.userId) {
    return { ok: true, via: 'creator' };
  }
  return { ok: false, reason: SERIES_NOT_MANAGER_MESSAGE };
}

export function canManageSeries(facts: SeriesManagementFacts, caller: SeriesCaller): boolean {
  return seriesManageVerdict(facts, caller).ok;
}

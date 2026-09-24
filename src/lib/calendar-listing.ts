/**
 * Pure rules for "may a calendar sweep prune the per-user cache?"
 * (calendar_event_cache has no delete path of its own: a moved / cancelled
 * occurrence left its old `<eventId>|<startIso>` row behind forever — the
 * 2026-09-24 "AI AM stuck at 13:30" bug). No DB, no fetch — unit-tested.
 *
 * A prune deletes every cached row in the window the listing did NOT
 * return, so it is only safe when the listing is the WHOLE truth for that
 * window: every page fetched, no page failed, the caller's own primary
 * calendar, and no filter that narrows the result set.
 */

export interface CalendarListingOutcome {
  /** Google still had a nextPageToken when the page cap stopped the loop. */
  truncated: boolean;
  /** A page after the first came back non-OK / threw — partial result. */
  pageFailed: boolean;
  /** Listing was narrowed by free-text search. */
  q?: string | null;
  /** Listing was narrowed to one iCalUID. */
  iCalUID?: string | null;
  /** A non-primary calendar (display-only, never persisted). */
  calendarId?: string | null;
}

/** True when the listing covered the whole window, unfiltered, on the
 * primary calendar — the only case a prune-by-absence is allowed. */
export function listingCoversWindow(o: CalendarListingOutcome): boolean {
  if (o.truncated || o.pageFailed) return false;
  if (o.q || o.iCalUID) return false;
  if (o.calendarId && o.calendarId !== 'primary') return false;
  return true;
}

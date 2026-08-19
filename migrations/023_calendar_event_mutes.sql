-- Per-user calendar-event mutes (listing: hide personal calendar blocks).
-- "my lunch" / focus-time events show up in the No-recording layer but
-- aren't real meetings — a mute HIDES them from the calendar-backed listing
-- layers (both norec and unimported). Distinct from gmeet_sync_skips'
-- 'muted' flag, which merely de-emphasizes a row.
--
-- kind='occurrence': value = the row's event_key ('<eventId>|<startIso>' for
--   calendar_event_cache rows, '<code>|<startIso>' for gmeet_meeting_cache
--   rows) — hides exactly one occurrence.
-- kind='series': value = the event's recurring_event_id, falling back to
--   event_id for non-recurring events — a stable id that also matches any
--   FUTURE occurrence the poller writes, so new rows are excluded
--   automatically with no poller change.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS calendar_event_mutes (
  user_id    uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('occurrence', 'series')),
  value      text        NOT NULL,
  title      text,                 -- display-only snapshot for the undo list
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, value)
);

-- Support the per-row seriesCount subqueries ("hide all N occurrences")
-- that the listing now computes for recurring events.
CREATE INDEX IF NOT EXISTS calendar_event_cache_user_recurring_idx
  ON calendar_event_cache (user_id, recurring_event_id)
  WHERE recurring_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gmeet_meeting_cache_recurring_idx
  ON gmeet_meeting_cache (recurring_event_id)
  WHERE recurring_event_id IS NOT NULL;

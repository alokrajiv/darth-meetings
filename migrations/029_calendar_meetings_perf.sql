-- /api/calendar-meetings perf (2026-08-24): the unimported/norec views'
-- correlated subqueries need two covering indexes.
--
--  - calendar_event_cache: every "the caller's own calendar row for this
--    occurrence" lookup (eventId resolution, mute exclusion, the enrichment
--    lateral, hasCalendarOccurrence) probes by (user_id, meeting_code) and a
--    sargable event_start range — without this it is a per-probe seq scan,
--    and the eventId resolution runs once per (candidate x transcript) pair
--    (43k seq scans of 858 rows = ~2s per query before this).
--
--  - transcripts (gmeet_context->>'eventId'): the imported-occurrence
--    anti-join's eventId arm (uploads / pasted transcripts link by eventId,
--    not meeting code — D9). meetingCode / joinWebUrl / callId already have
--    their expression indexes (migration 016); eventId was the missing one.
--
-- Additive + idempotent; safe to re-run.

SET search_path = meeting_whisperer_prod, public;

CREATE INDEX IF NOT EXISTS calendar_event_cache_user_code_start_idx
  ON calendar_event_cache (user_id, meeting_code, event_start)
  WHERE meeting_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS transcripts_gmeet_event_id_idx
  ON transcripts ((gmeet_context->>'eventId'))
  WHERE gmeet_context IS NOT NULL;

-- Unimported-view visibility scoping (2026-08-24, privacy fix): the view no
-- longer serves the whole global artifact cache — a caller must be involved
-- in the occurrence (own calendar row, organizer, or listed invitee on any
-- user's cached calendar row). The invitee arm probes calendar_event_cache
-- by (meeting_code, event_start range) WITHOUT a user_id, which the
-- migration-029 user-scoped index can't serve — this unscoped twin keeps it
-- off the per-candidate seq-scan path.
--
-- Additive + idempotent; safe to re-run.

SET search_path = meeting_whisperer_prod, public;

CREATE INDEX IF NOT EXISTS calendar_event_cache_code_start_idx
  ON calendar_event_cache (meeting_code, event_start)
  WHERE meeting_code IS NOT NULL;

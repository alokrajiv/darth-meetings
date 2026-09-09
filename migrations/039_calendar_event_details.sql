-- Invite details on the per-user calendar cache (Alok 2026-09-09): the
-- full-calendar CLI view (`meetings calendar --view all`) needs "what is
-- this meeting about / where" before it happens. The Calendar API field
-- mask already fetched description/location/htmlLink — they were dropped
-- on write. Overwritten on every sweep (they change legitimately);
-- description is capped at 4000 chars by the writer.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE calendar_event_cache
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS location    text,
  ADD COLUMN IF NOT EXISTS html_link   text;

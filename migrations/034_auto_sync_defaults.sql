-- T2 follow-up (Alok 2026-08-30): the recommended auto-sync configuration is
-- Recording (re-transcribe, frames) + detailed report with video frames —
-- make that the default for anyone who turns the switch on, and track the
-- one-time "auto-sync is here" announcement dismissal server-side so it is
-- one-time per USER, not per browser.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE user_prefs ALTER COLUMN auto_sync_mode SET DEFAULT 'video';
ALTER TABLE user_prefs ALTER COLUMN auto_sync_report SET DEFAULT 'detailed-video';
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS auto_sync_announce_dismissed_at timestamptz;

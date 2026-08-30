-- Setup-review dialog (Alok 2026-08-30): one modal on any page load while
-- something is missing (Google link, Microsoft link) or the one-time review
-- of auto-sync + Slack notification settings hasn't happened. Reviewed is a
-- per-USER server flag; the 24h snooze is per browser (localStorage).
SET search_path = meeting_whisperer_prod, public;
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS setup_reviewed_at timestamptz;

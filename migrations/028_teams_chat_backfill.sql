-- Teams chat evidence: one-time per-user backfill stamp.
--
-- When the poller first sees a user's Darth Tasks Microsoft link as active,
-- it back-reads the last 60 days of their Teams calendar events and records
-- each occurrence's chat verdict (held / recorded — raw.teamsChat on
-- gmeet_meeting_cache; see lib/teams-chat-evidence.ts). The stamp lands only
-- once the backfill fully completed within the sweep's lookup budget, so a
-- partially-done backfill resumes on the next sweep.
--
-- Additive + idempotent; safe to re-run. Same convention as 024/027.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE google_accounts
  ADD COLUMN IF NOT EXISTS teams_chat_backfilled_at timestamptz;

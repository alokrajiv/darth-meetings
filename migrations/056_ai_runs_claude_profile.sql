-- 056: which shared Claude login a headless run used.
--
-- Meetings follows Darth Chat's Claude allocation (src/lib/server/claude-profile.ts):
-- every run injects `~/.creds/<profile>.token` as CLAUDE_CODE_OAUTH_TOKEN. The
-- profile is recorded per run so usage on a login can be attributed next to
-- chat's figures (the claude-usage-poller sees the sum). NULL = the host's own
-- login (runs before 2026-10-08, laptop dev).
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE ai_runs ADD COLUMN IF NOT EXISTS claude_profile text;

CREATE INDEX IF NOT EXISTS ai_runs_claude_profile_created_idx
  ON ai_runs (claude_profile, created_at DESC)
  WHERE claude_profile IS NOT NULL;

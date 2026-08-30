-- T2: account-level auto-sync with cross-user dedupe.
--
-- user_prefs.auto_sync: per-user "import everything I'm in" switch.
--   off  = nothing automatic (default — privacy first; per-series auto-import
--          stays the only automatic path)
--   mine = past meetings the user ORGANISED
--   all  = every past meeting the user attended
-- The sweep (lib/server/account-auto-sync.ts) never lists anyone's calendar
-- itself: it reads the OPEN 'unimported' reminders the per-user poller sweeps
-- already produce (each user's own token, own calendar), groups them by
-- occurrence across every auto-sync user, elects ONE importer per occurrence
-- and shares the result with the rest — so five people with the switch on
-- still cost exactly one import.
--
-- auto_sync_log: the one-import-per-occurrence ledger. PK on the occurrence
-- key ('<meetingCode>|<eventStartIso>' — same key as gmeet_reminders) is what
-- makes a second sweep (or a second process) unable to fire twice.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS user_prefs (
  user_id            uuid        PRIMARY KEY,
  email              text        NOT NULL,
  auto_sync          text        NOT NULL DEFAULT 'off'
                                 CHECK (auto_sync IN ('off', 'mine', 'all')),
  auto_sync_mode     text        NOT NULL DEFAULT 'transcript'
                                 CHECK (auto_sync_mode IN ('transcript', 'video', 'both')),
  auto_sync_report   text        NOT NULL DEFAULT 'summary'
                                 CHECK (auto_sync_report IN ('summary', 'detailed-video', 'detailed-text', 'later')),
  -- Only occurrences that START after this are touched; stamped when the
  -- switch is turned on so enabling never backfills weeks of history.
  auto_sync_since    timestamptz,
  auto_sync_providers jsonb      NOT NULL DEFAULT '{"gmeet": true, "teams": true}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auto_sync_log (
  occ_key           text        PRIMARY KEY,   -- '<meetingCode>|<eventStartIso>'
  meeting_code      text,
  occ_start         timestamptz,
  title             text,
  -- imported | deferred | already | failed | no_access | nudged
  outcome           text        NOT NULL,
  importer_user_id  uuid,
  importer_email    text,
  assemblyai_id     text,
  -- Every other auto-sync user who wanted this occurrence (shared in +
  -- DM'd when notes land).
  watchers          text[]      NOT NULL DEFAULT '{}',
  detail            text,
  attempts          integer     NOT NULL DEFAULT 1,
  fired_at          timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_sync_log_outcome_idx ON auto_sync_log (outcome, updated_at);

-- gmeet_reminders.kind gains 'sync_requested': the organiser (the one account
-- that can reach the artifacts) is asked to import / enable auto-sync because
-- colleagues' auto-sync wanted this occurrence and none of their tokens could
-- read it. kind is free text (no constraint) — documented here only.
COMMENT ON COLUMN gmeet_reminders.kind IS 'unimported | autorec_off | sync_requested';

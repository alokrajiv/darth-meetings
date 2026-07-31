-- Per-user Google Meet sync tracking.
--
-- gmeet_sync_state: one row per user — when they last ran a "sync everything"
-- pass over their calendar. Powers the "last synced X days ago" nudge so
-- people don't forget to pull their meetings in.
--
-- gmeet_sync_skips: per-user "never sync this event" mutes, keyed by meeting
-- code (or calendar event id when no code exists). A muted event stops being
-- offered/reminded for THAT user; if a colleague imports the same meeting
-- anyway, the sync list still shows a "synced by <colleague>" marker —
-- nothing to be done about that, that's how the world works.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS gmeet_sync_state (
  user_id        uuid        PRIMARY KEY,
  last_synced_at timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gmeet_sync_skips (
  id          serial      PRIMARY KEY,
  user_id     uuid        NOT NULL,
  event_key   text        NOT NULL,  -- meeting code, else calendar event id
  title       text,
  event_start timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS gmeet_sync_skips_user_idx
  ON gmeet_sync_skips (user_id);

-- Cross-user "did anyone already import this meeting?" lookups key on the
-- meeting code buried in gmeet_context.
CREATE INDEX IF NOT EXISTS transcripts_gmeet_meeting_code_idx
  ON transcripts ((gmeet_context->>'meetingCode'))
  WHERE gmeet_context IS NOT NULL;

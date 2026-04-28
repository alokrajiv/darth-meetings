-- Per-transcript activity log: who did what, when. Powers the Notion-style
-- "Edited by X · 2m ago" pill and the viewer-avatar stack at the top of the
-- detail page, plus the click-through timeline dialog.
--
-- We cache the actor's display name on each row so reads don't have to
-- re-resolve against the directory every time. Views are throttled at the
-- application layer to once per user per 10 minutes — we still want a
-- reasonable density of events without exploding row count.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS transcript_activity (
  id            serial      PRIMARY KEY,
  transcript_id integer     NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  user_email    text        NOT NULL,
  user_name     text,
  action        text        NOT NULL,
  details       jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_activity_tid_at_idx
  ON transcript_activity (transcript_id, at DESC);

CREATE INDEX IF NOT EXISTS transcript_activity_user_at_idx
  ON transcript_activity (user_id, at DESC);

-- Per-user calendar event cache (listing revamp: "No recording" view).
-- The 30-min poller already lists each connected user's primary calendar
-- (now-7d → now+24h) before filtering down to Meet events; this table
-- persists ALL timed events from that sweep — including ones with no Meet
-- conference at all — so the listing can show "calendar meetings that left
-- no artifacts". History accumulates from sweeps going forward only.
--
-- PRIVACY (deliberate, unlike the global gmeet_meeting_cache): rows are
-- PER-USER — each user only ever sees rows their own poller sweep wrote.
-- Display-only as always: nothing here grants content access; imports go
-- through the acting user's own Google token.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS calendar_event_cache (
  user_id          uuid        NOT NULL,
  event_key        text        NOT NULL,  -- '<eventId>|<startIso>'
  event_id         text        NOT NULL,
  recurring_event_id text,
  ical_uid         text,
  title            text,
  event_start      timestamptz NOT NULL,
  event_end        timestamptz,
  meeting_code     text,                  -- null = no Meet conference on the event
  organizer_email  text,
  organizer_self   boolean,
  attendee_count   int,
  attendees        jsonb,                 -- [{email, displayName?, responseStatus?}] cap 50
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS calendar_event_cache_user_start_idx
  ON calendar_event_cache (user_id, event_start DESC);

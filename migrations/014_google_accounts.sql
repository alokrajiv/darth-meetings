-- Backend Google OAuth + polling (workstream: sync & remind).
--
-- google_accounts: one row per user who connected their Google account via
-- the auth-code flow. Holds the ENCRYPTED refresh token (AES-256-GCM with
-- GOOGLE_TOKEN_ENC_KEY — never plaintext at rest) so the server can mint
-- access tokens and poll Calendar/Meet on the user's behalf. Deliberately
-- per-user consent — no service-account domain-wide delegation.
--
-- gmeet_reminders: findings from the background poller. Two kinds:
--   'unimported'  — a past Meet meeting with a recording/transcript that
--                   nobody has imported yet (import stays a human choice;
--                   the poller only nags).
--   'autorec_off' — an upcoming meeting the user ORGANIZES whose
--                   auto-recording/transcription/notes are all off
--                   (artifactConfig is organizer-only readable).
-- Keyed per occurrence (meeting code + event start) because recurring
-- meetings reuse one code forever.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS google_accounts (
  user_id           uuid        PRIMARY KEY,
  user_email        text        NOT NULL,  -- SSO email at connect time
  google_email      text,                  -- from the id_token; usually same as user_email
  refresh_token_enc text        NOT NULL,  -- iv.ciphertext.tag, base64url
  scopes            text        NOT NULL,
  status            text        NOT NULL DEFAULT 'ok',  -- ok | revoked | error
  last_error        text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  last_refresh_at   timestamptz,
  last_poll_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gmeet_reminders (
  id              serial      PRIMARY KEY,
  user_id         uuid        NOT NULL,
  kind            text        NOT NULL,  -- unimported | autorec_off
  event_key       text        NOT NULL,  -- "<meetingCode>|<eventStartIso>" (or event id when no code)
  meeting_code    text,
  title           text,
  event_start     timestamptz,
  organizer_self  boolean     NOT NULL DEFAULT false,
  has_recording   boolean     NOT NULL DEFAULT false,
  has_transcript  boolean     NOT NULL DEFAULT false,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_reason text,                  -- imported | muted | dismissed | expired | config_on
  UNIQUE (user_id, kind, event_key)
);

CREATE INDEX IF NOT EXISTS gmeet_reminders_user_open_idx
  ON gmeet_reminders (user_id)
  WHERE resolved_at IS NULL;

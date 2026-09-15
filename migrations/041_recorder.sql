-- Darth Recorder beta (docs/recorder-beta-plan.md, Stream S1): the server
-- side of the macOS tray — device registry, telemetry firehose and the
-- recordings registry that links a local .mp4 to a calendar occurrence and
-- (after upload) to a transcript.
--
-- Everything here is keyed by the darth user id of the signed-in tray
-- (`Bearer dth_…` → withAuth). Rows are owner-scoped: a caller only ever
-- writes their own, and only ever READS someone else's recording through
-- the occurrence-involvement gate (feedback_privacy_caller_scoping_gate).

SET search_path = meeting_whisperer_prod, public;

-- One row per installed tray. device_id is minted by the tray and stored
-- next to its auth.json; re-claiming a device under another user simply
-- overwrites user_id/email.
CREATE TABLE IF NOT EXISTS recorder_devices (
  device_id    uuid PRIMARY KEY,
  user_id      text NOT NULL,
  email        text,
  hostname     text,
  os           text,
  app_version  text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  last_ip      text,
  last_status  jsonb
);
CREATE INDEX IF NOT EXISTS recorder_devices_user_idx ON recorder_devices (user_id, last_seen DESC);

-- Telemetry. The tray ships its events.jsonl in batches of <= 500; this is
-- an append-only firehose for later analysis, never served to the UI.
CREATE TABLE IF NOT EXISTS recorder_events (
  id          bigserial PRIMARY KEY,
  device_id   uuid,
  user_id     text NOT NULL,
  ts          timestamptz NOT NULL,
  kind        text NOT NULL,
  payload     jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recorder_events_device_ts_idx ON recorder_events (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS recorder_events_kind_ts_idx   ON recorder_events (kind, ts DESC);

-- The registry. id is a UUID minted by the tray at recording start, so the
-- first POST and every later PATCH (segments, stop, upload) address the
-- same row. `matched` is recomputed by matchRecording() on every write.
CREATE TABLE IF NOT EXISTS recorder_recordings (
  id            uuid PRIMARY KEY,
  device_id     uuid,
  user_id       text NOT NULL,
  email         text,
  -- recording | local | uploading | uploaded | upload_failed | deleted
  status        text NOT NULL DEFAULT 'recording',
  started_at    timestamptz,
  ended_at      timestamptz,
  duration_s    int,
  bytes         bigint,
  segments      jsonb,
  call          jsonb,
  shares        jsonb,
  matched       jsonb,
  transcript_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recorder_recordings_user_started_idx
  ON recorder_recordings (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS recorder_recordings_transcript_idx
  ON recorder_recordings (transcript_id);
-- Listing lookup: "is there a recording for this occurrence?" rides the
-- matched meeting code (privacy-gate rule 4 — the involvement predicates
-- and their joins must be indexed).
CREATE INDEX IF NOT EXISTS recorder_recordings_matched_code_idx
  ON recorder_recordings ((matched->>'meeting_code'))
  WHERE matched IS NOT NULL;

-- "Ask to upload" rate limit: one DM per (recording, requester) per 6 h.
-- A dedupe_key on the notify endpoint would suppress forever, and the ask
-- is legitimately repeatable the next day.
CREATE TABLE IF NOT EXISTS recorder_nudges (
  recording_id       uuid NOT NULL,
  requester_user_id  text NOT NULL,
  requester_email    text,
  sent_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, requester_user_id)
);

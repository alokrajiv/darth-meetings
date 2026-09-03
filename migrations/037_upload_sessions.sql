-- Chunked, parallel, resumable media uploads (Alok 2026-09-03). One session
-- per file, keyed on (user, fingerprint) while open; chunks land at byte
-- offsets inside the placeholder's temp file and each acknowledged chunk is
-- a row in upload_chunks. A dropped connection, a closed tab or a reload
-- resumes from the acknowledged set instead of starting the file over —
-- re-dropping the same file (same user, same fingerprint) reopens the
-- session. The placeholder row / temp file naming (up-<uuid> ↔
-- upload-<uuid>.part) is unchanged; the session id IS that uuid for
-- single-file uploads.
SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS upload_sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL,
  fingerprint     text NOT NULL,
  size            bigint NOT NULL,
  chunk_size      integer NOT NULL,
  chunk_count     integer NOT NULL,
  temp_filename   text NOT NULL,
  placeholder_id  text NOT NULL,
  -- Frozen upload spec (filename, language, linked event, report pref,
  -- source_id, multi-file group) — everything finalize needs.
  spec            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- open → completing → done | failed
  status          text NOT NULL DEFAULT 'open',
  error           text,
  -- assemblyai_id of the finished transcript (status 'done') — lets a client
  -- that lost the complete response recover the row by polling.
  result_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- One OPEN session per (user, file). Done/failed rows stay for a while as
-- an audit trail and never block a fresh attempt.
CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_open_key
  ON upload_sessions (user_id, fingerprint) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS upload_sessions_placeholder_idx
  ON upload_sessions (placeholder_id);
CREATE INDEX IF NOT EXISTS upload_sessions_status_updated_idx
  ON upload_sessions (status, updated_at);

CREATE TABLE IF NOT EXISTS upload_chunks (
  session_id   uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  idx          integer NOT NULL,
  bytes        integer NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, idx)
);

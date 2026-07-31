-- Per-run stats for headless Claude invocations (auto-notes generation and
-- import normalization). One row per `claude -p` run: who triggered it, what
-- it cost, how many tokens, how long, and the Claude Code session id (which
-- makes future `claude -p --resume <id>` incremental updates possible).
--
-- transcript_id is SET NULL on delete so usage accounting survives transcript
-- deletion; assemblyai_id is kept as a loose textual reference.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS ai_runs (
  id                    serial      PRIMARY KEY,
  transcript_id         integer     REFERENCES transcripts(id) ON DELETE SET NULL,
  assemblyai_id         text,
  kind                  text        NOT NULL,  -- 'auto_notes' | 'import_normalize'
  triggered_by_user_id  uuid,
  triggered_by_email    text,
  model                 text,
  session_id            text,
  status                text        NOT NULL DEFAULT 'completed',  -- 'completed' | 'error'
  error                 text,
  cost_usd              numeric(12, 6),
  duration_ms           integer,
  api_duration_ms       integer,
  num_turns             integer,
  input_tokens          bigint,
  output_tokens         bigint,
  cache_read_tokens     bigint,
  cache_creation_tokens bigint,
  prompt_chars          integer,
  result_chars          integer,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_runs_tid_at_idx
  ON ai_runs (transcript_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_runs_user_at_idx
  ON ai_runs (triggered_by_user_id, created_at DESC);

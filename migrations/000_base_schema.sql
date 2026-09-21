-- THE PRE-MIGRATION BASE — reconstructed 2026-09-22.
--
-- Everything that existed in the prod schema BEFORE `001_transcript_shares.sql`
-- ran: the six tables the app was born with, their sequences, constraints and
-- indexes. The numbered migrations 001…N apply ON TOP of this file, so
--
--     000_base_schema.sql + 001…047  ==  the prod schema
--
-- exactly (verified 2026-09-22 by applying 000 + 001…043 to an empty scratch
-- schema and diffing a normalised `pg_dump --schema-only` against the same
-- dump of prod — 044…047 are not applied on prod yet; the diff was empty).
--
-- WHY IT EXISTS: every scratch-Postgres integration check under `tmp/*/`
-- used to rebuild its schema from a `pg_dump` of the PRODUCTION database,
-- which made a prod read a precondition for running the test suite. With this
-- file the repo alone is enough — see `scripts/scratch-db.sh`.
--
-- ⚠️ NEVER APPLY THIS ON PROD. Prod already has these objects; this file is
-- for empty schemas only. Every statement is `IF NOT EXISTS`-guarded so a
-- mistake is a no-op rather than damage, but the guard is not the point —
-- do not run it there.
--
-- NOT HERE ON PURPOSE:
--   * `pg_trgm` — migration `012_search_trgm.sql` installs the extension into
--     the schema (that is where it lives on prod: `CREATE EXTENSION` runs
--     under this file's `search_path`).
--   * `word_boost` is spelled `word_boost` below, NOT `keyterms_prompt`:
--     migration `002_keyterms.sql` is the rename, and it must have something
--     to rename.

-- CONVENTION (same as 001–047): the PROD schema is hard-coded on the line
-- below. Applying this to any other schema — a local scratch cluster, an
-- integration check — means sed-ing that one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_scratch/' 000_base_schema.sql | psql …
SET search_path = meeting_whisperer_prod, public;

-- One row per uploaded or imported recording. THE document of this app: a
-- meeting is a `transcripts` row. `assemblyai_id` is the transcription id
-- (and, for a while, the public id of the meeting too).
CREATE TABLE IF NOT EXISTS transcripts (
  id                serial       PRIMARY KEY,
  user_id           uuid         NOT NULL,
  assemblyai_id     text         NOT NULL,
  original_filename text,
  status            text         NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  duration          integer,
  speaker_count     integer,
  language_code     text,
  title             text,
  description       text,
  last_accessed     timestamptz  NOT NULL DEFAULT now(),
  source            text         NOT NULL DEFAULT 'uploaded'
                                 CHECK (source IN ('uploaded','imported')),
  imported_content  jsonb,
  audio_url         text,
  local_audio_path  text,
  UNIQUE (user_id, assemblyai_id)
);

-- Per-user free-text edits to a transcription's utterances, keyed by the AAI id.
CREATE TABLE IF NOT EXISTS transcript_edits (
  id            serial PRIMARY KEY,
  user_id       uuid        NOT NULL,
  assemblyai_id text        NOT NULL,
  edits         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, assemblyai_id)
);

-- "Speaker A is Kawen" — per user, per transcription.
CREATE TABLE IF NOT EXISTS speaker_mappings (
  id             serial PRIMARY KEY,
  user_id        uuid        NOT NULL,
  assemblyai_id  text        NOT NULL,
  speaker_labels jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, assemblyai_id)
);

-- Per-user AssemblyAI vocabulary. `word_boost` is renamed to
-- `keyterms_prompt` by migration 002 — leave the old name here.
CREATE TABLE IF NOT EXISTS user_vocab (
  user_id         uuid        PRIMARY KEY,
  word_boost      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  custom_spelling jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The org-wide vocabulary: exactly one row, id = 1.
CREATE TABLE IF NOT EXISTS org_vocab (
  id              integer     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version         integer     NOT NULL DEFAULT 1,
  word_boost      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  custom_spelling jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

-- Every version the org vocabulary has ever had.
CREATE TABLE IF NOT EXISTS org_vocab_history (
  id              serial PRIMARY KEY,
  version         integer     NOT NULL,
  word_boost      jsonb       NOT NULL,
  custom_spelling jsonb       NOT NULL,
  edited_at       timestamptz NOT NULL DEFAULT now(),
  edited_by       uuid,
  note            text
);

CREATE INDEX IF NOT EXISTS org_vocab_history_version_idx
  ON org_vocab_history (version DESC);

CREATE INDEX IF NOT EXISTS transcripts_user_created_idx
  ON transcripts (user_id, created_at DESC);

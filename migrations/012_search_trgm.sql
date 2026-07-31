-- Trigram GIN indexes so the deep-search ILIKEs stop seq-scanning full
-- transcript texts. The search WHERE is an OR across five fields — Postgres
-- only uses indexes for that via BitmapOr when EVERY arm is indexable, so
-- all five get one. pg_trgm is a trusted extension (PG 13+), creatable by
-- the database owner. Note: trgm ILIKE needs >=3-char patterns to use the
-- index; the client only fires deep search at 3+ chars anyway.

SET search_path = meeting_whisperer_prod, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS transcripts_trgm_content_idx
  ON transcripts USING gin ((imported_content->>'text') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcripts_trgm_notes_idx
  ON transcripts USING gin (auto_notes gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcripts_trgm_title_idx
  ON transcripts USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcripts_trgm_filename_idx
  ON transcripts USING gin (original_filename gin_trgm_ops);

CREATE INDEX IF NOT EXISTS transcripts_trgm_description_idx
  ON transcripts USING gin (description gin_trgm_ops);

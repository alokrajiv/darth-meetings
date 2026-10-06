-- Curated series v2 (docs/curated-series-spec.md §11.2, §11.8): a meeting can
-- be in SEVERAL series — each series is its owner's view of the meetings they
-- can open, so there is no cross-series competition any more.
--
-- APPLY AFTER THE v2 DEPLOY, never before: the v1 code writes memberships
-- with `ON CONFLICT (transcript_id)`, which needs exactly the UNIQUE this
-- drops. The v2 code writes `ON CONFLICT DO NOTHING` (no target), so it runs
-- correctly with or without this migration — until it is applied a meeting
-- simply stays in its first series.
--
-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first.
SET search_path = meeting_whisperer_prod, public;

-- 020 declared `transcript_id INTEGER NOT NULL UNIQUE`, so Postgres named
-- the constraint series_members_transcript_id_key.
ALTER TABLE series_members DROP CONSTRAINT IF EXISTS series_members_transcript_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS series_members_series_transcript_uniq
  ON series_members (series_id, transcript_id);
CREATE INDEX IF NOT EXISTS series_members_transcript_idx
  ON series_members (transcript_id);

-- Curated series (docs/curated-series-spec.md §1, owner 2026-10-06): the
-- key-based series ("evidence bag", series_keys) are replaced by a small set
-- of HAND-CURATED series — name, description, patterns (title regexes /
-- invite rules), one or more default labels, and followers who get a read
-- share of every meeting in the series.
--
-- Additive only. The destructive reset of the old series data is a separate
-- one-off (scripts/curated-series-reset.sql), run after this and the deploy.
--
--  - series.patterns: the matcher's input (src/lib/series-patterns.ts,
--    evaluated in JS only — never Postgres ~*, a different regex dialect).
--    '[]' = matches nothing (manual members only).
--  - series.priority: several series match → the lowest priority wins, then
--    the lowest id. A meeting is in at most one series
--    (series_members.transcript_id stays UNIQUE).
--  - series_followers: people who get a read share (origin 'series-follow')
--    of every member, past and future. Adding/removing them is an auditor
--    act (src/lib/auditor-policy.ts AUDITORS) — following grants access.
--  - default labels: one label_rules row (kind='series', value=<series id>)
--    PER label, so the one-rule-per-series index of 030 goes and a
--    (value, label_id) one takes its place.
--  - auditor_share_removals (052) now ledgers removed follow shares too; the
--    origin column says which automation the removed share came from. The
--    auto-add guard reads ANY row for (transcript, email): whoever removed
--    someone from a meeting, no automation adds them back.
--
-- series_keys stays in the schema; nothing reads or writes it any more.
--
-- The code probes for these objects once per process
-- (src/db-ops/curated-series-schema.ts) and leaves every curated-series
-- write off until they exist, so a deploy that lands before this migration
-- does not crash.
--
-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE series ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE series ADD COLUMN IF NOT EXISTS patterns jsonb NOT NULL DEFAULT '[]';
ALTER TABLE series ADD COLUMN IF NOT EXISTS priority int NOT NULL DEFAULT 100;

CREATE TABLE IF NOT EXISTS series_followers (
  series_id        int  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  email            text NOT NULL,           -- lower-cased
  name             text,
  added_by_user_id uuid NOT NULL,
  added_by_email   text NOT NULL,
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, email)
);

-- Default labels: one label_rules row (kind='series', value=series id) PER label.
DROP INDEX IF EXISTS label_rules_series_value_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS label_rules_series_label_uniq
  ON label_rules (value, label_id) WHERE kind = 'series' AND label_id IS NOT NULL;

-- The share-removal ledger (052) now records follow removals too.
ALTER TABLE auditor_share_removals ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'auditor-external';

-- Label rules v2, first kind: 'series' (docs/labels-design.md §5).
--
-- A rule binds a label to a matching condition; the engine (v1: only
-- src/lib/server/series-labels.ts) assigns that label with how='rule' and
-- rule_id set. transcript_labels.rule_id existed since 027 without an FK —
-- this adds it as ON DELETE SET NULL, so deleting a rule keeps the
-- assignments (they just stop being rule-owned) while deleting a LABEL
-- still cascades the assignments (027 FK).
--
-- Opt-out is a TOMBSTONE, not an absence: label_rules.label_id is nullable
-- with ON DELETE SET NULL, so deleting a series label leaves its rule row
-- behind with label_id NULL. The engine treats label_id IS NULL (or
-- enabled=false) as "opted out" and a missing row as "never created" — that
-- distinction lets the member-add hook create the label at ANY count >= 2
-- (healing races/transient failures at the 1->2 transition) without ever
-- resurrecting a deliberate opt-out.
--
-- One rule per series: partial unique index on (kind, value) — without it
-- two racing creates could bind one series to two labels, or (worse) leave
-- an orphan rule that resurrects automation after the user opts out.
--
-- Additive + idempotent (IF NOT EXISTS / catch duplicate_object / guarded
-- DO blocks); safe to re-run, including on a DB that ran the earlier
-- NOT NULL + CASCADE draft of this migration.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS label_rules (
  id          serial PRIMARY KEY,
  label_id    integer REFERENCES labels(id) ON DELETE SET NULL, -- NULL = opt-out tombstone
  kind        text NOT NULL CHECK (kind IN ('series','participant_domain','participant_email','organizer_email','title_regex','provider')),
  value       text NOT NULL,                   -- series id / 'lpglobal.com' / regex / 'teams'
  apply_existing boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL,
  created_by_email text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label_id, kind, value)
);

-- Upgrade a DB that ran the earlier draft (label_id NOT NULL + CASCADE).
ALTER TABLE label_rules ALTER COLUMN label_id DROP NOT NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'meeting_whisperer_prod' AND t.relname = 'label_rules'
      AND c.conname = 'label_rules_label_id_fkey' AND c.confdeltype = 'c'
  ) THEN
    ALTER TABLE label_rules DROP CONSTRAINT label_rules_label_id_fkey;
    ALTER TABLE label_rules
      ADD CONSTRAINT label_rules_label_id_fkey
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE SET NULL;
  END IF;
END $$;

-- The engine's lookup: "which rule targets series 42?" / "...domain x?".
CREATE INDEX IF NOT EXISTS label_rules_kind_value_idx ON label_rules (kind, value);

-- Exactly one rule (live or tombstone) per series.
CREATE UNIQUE INDEX IF NOT EXISTS label_rules_series_value_uniq
  ON label_rules (kind, value) WHERE kind = 'series';

DO $$ BEGIN
  ALTER TABLE transcript_labels
    ADD CONSTRAINT transcript_labels_rule_id_fkey
    FOREIGN KEY (rule_id) REFERENCES label_rules(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

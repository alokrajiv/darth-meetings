-- Labels (docs/labels-design.md §2): org-wide hierarchical labels,
-- many-to-many with transcripts. Path storage = parent_id + materialized
-- path/path_key (no ltree); rename/move recompute the subtree in one txn in
-- src/db-ops/labels.ts — no triggers. Additive + idempotent (IF NOT EXISTS
-- everywhere); safe to re-run.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS labels (
  id            serial PRIMARY KEY,
  parent_id     integer REFERENCES labels(id) ON DELETE CASCADE,
  name          text NOT NULL,                 -- display segment, no '/'
  name_key      text NOT NULL,                 -- lower(btrim(name)), app-written
  path          text NOT NULL,                 -- 'Customers/LP Global/Weekly catch-up'
  path_key      text NOT NULL,                 -- lower(path)
  depth         smallint NOT NULL,             -- 1 = top level
  color         text,                          -- '#rrggbb' or null (inherits parent in UI)
  description   text,
  created_by    uuid NOT NULL,
  created_by_email text NOT NULL,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (position('/' IN name) = 0),
  CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CHECK (depth BETWEEN 1 AND 6),
  CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$')
);
-- case-insensitive unique per parent (NULL parent folded to 0)
CREATE UNIQUE INDEX IF NOT EXISTS labels_parent_name_key
  ON labels (COALESCE(parent_id, 0), name_key);
CREATE UNIQUE INDEX IF NOT EXISTS labels_path_key ON labels (path_key);
CREATE INDEX IF NOT EXISTS labels_path_prefix_idx ON labels (path_key text_pattern_ops);

CREATE TABLE IF NOT EXISTS transcript_labels (
  transcript_id integer NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  label_id      integer NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  how           text NOT NULL DEFAULT 'manual' CHECK (how IN ('manual','cli','bulk','rule')),
  rule_id       integer,                       -- v2: label_rules(id), no FK yet
  added_by      uuid NOT NULL,
  added_by_email text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, label_id)
);
CREATE INDEX IF NOT EXISTS transcript_labels_label_idx ON transcript_labels (label_id);

-- Taxonomy audit (org-wide renames/moves/deletes are what people argue about).
-- Assignment audit goes through transcript_activity (label_add / label_remove).
CREATE TABLE IF NOT EXISTS label_history (
  id        serial PRIMARY KEY,
  label_id  integer,                           -- no FK: survives delete
  action    text NOT NULL CHECK (action IN ('create','rename','move','recolor','delete','merge')),
  before    jsonb,
  after     jsonb,
  by_user   uuid NOT NULL,
  by_email  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);

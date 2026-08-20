-- Series auto-import + Slack DM notification preferences.
--
-- series.auto_import (jsonb): per-series auto-import config — shape owned by
-- src/db-ops/series.ts (SeriesAutoImportCfg): { enabled, byUserId, byEmail,
-- mode, report, since, lastSweepAt?, lastError? }. The sweep runs as the
-- enabler (their Google token), only touches occurrences that START after
-- `since`, and stamps imported rows with gmeet_context.autoImport.
ALTER TABLE series ADD COLUMN IF NOT EXISTS auto_import jsonb;

-- Fire-once ledger for the sweep: one row per (series, occurrence) the
-- auto-importer has acted on, so a 30-min sweep never re-fires an occurrence
-- (the deferred-import machinery owns the waiting, not this table). Failed
-- fires may be retried after a cool-off — the sweep updates the row in place.
CREATE TABLE IF NOT EXISTS series_auto_import_log (
  id            serial      PRIMARY KEY,
  series_id     integer     NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  occ_key       text        NOT NULL,  -- SeriesOccurrence.key (calendar instance id / teams callId)
  occ_start     timestamptz,
  title         text,
  outcome       text        NOT NULL,  -- imported | deferred | already | failed
  assemblyai_id text,
  detail        text,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, occ_key)
);

-- Per-user Slack DM notification preferences, keyed by EMAIL (recipients of
-- share notifications may never have signed in, and every DM targets an
-- email anyway). Absent row / absent key = kind enabled (opt-out model).
-- Kinds live in src/db-ops/notify-prefs.ts.
CREATE TABLE IF NOT EXISTS notify_prefs (
  email      text        PRIMARY KEY,
  prefs      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

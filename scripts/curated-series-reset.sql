-- One-off (2026-10-06, docs/curated-series-spec.md §8 step 3): throw away the
-- key-based series ("evidence bag") so the curated seed starts from nothing.
--
-- Order of the rollout: migration 053 → deploy → THIS → the seed
-- (scripts/curated-series-seed.ts --apply). Run it as ONE transaction:
--
--   ssh azureuser@172.17.0.6 "set -a; . /home/azureuser/apps/meeting-whisperer/.env.local; set +a; \
--     psql -X -v ON_ERROR_STOP=1 --single-transaction -f -" < scripts/curated-series-reset.sql
--
-- What goes:
--   - every label rule of kind 'series' (the old one-rule-per-series rows,
--     tombstones included). transcript_labels.rule_id is ON DELETE SET NULL,
--     so assignments those rules made would survive as plain labels — the
--     next step removes the ones that matter;
--   - the auto-created `Series/<title>` labels AND the reserved `Series` root
--     (lib/series-label-name SERIES_LABEL_ROOT — nothing creates it any more).
--     Their assignments cascade (027 FK). Hand-made labels elsewhere in the
--     tree are untouched;
--   - every series row; series_keys, series_members, series_exclusions and
--     series_auto_import_log cascade (020/024 FKs), as do series_followers
--     (053) — there are none yet.
--
-- What stays: the meetings themselves, every share (no follow share exists
-- before the seed), the auditor ledger, every hand-made label.
--
-- Backups taken before this (spec header): .6:~/backups/series-backup-2026-10-06.{dump,sql}.
-- The counts printed before and after are the record of what went.
SET search_path = meeting_whisperer_prod, public;

SELECT 'before' AS at,
       (SELECT count(*) FROM series)                                         AS series,
       (SELECT count(*) FROM series_keys)                                    AS series_keys,
       (SELECT count(*) FROM series_members)                                 AS series_members,
       (SELECT count(*) FROM series_exclusions)                              AS series_exclusions,
       (SELECT count(*) FROM series_auto_import_log)                         AS auto_import_log,
       (SELECT count(*) FROM label_rules WHERE kind = 'series')              AS series_label_rules,
       (SELECT count(*) FROM labels
         WHERE path_key = 'series' OR path_key LIKE 'series/%')              AS series_labels,
       (SELECT count(*) FROM transcript_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE l.path_key = 'series' OR l.path_key LIKE 'series/%')          AS series_label_assignments;

DELETE FROM label_rules WHERE kind = 'series';

-- Children first is not needed (parent FK cascades), but deleting the whole
-- subtree by path keeps the statement independent of the tree's shape.
DELETE FROM labels WHERE path_key = 'series' OR path_key LIKE 'series/%';

DELETE FROM series;

SELECT 'after' AS at,
       (SELECT count(*) FROM series)                                         AS series,
       (SELECT count(*) FROM series_keys)                                    AS series_keys,
       (SELECT count(*) FROM series_members)                                 AS series_members,
       (SELECT count(*) FROM series_exclusions)                              AS series_exclusions,
       (SELECT count(*) FROM series_auto_import_log)                         AS auto_import_log,
       (SELECT count(*) FROM label_rules WHERE kind = 'series')              AS series_label_rules,
       (SELECT count(*) FROM labels
         WHERE path_key = 'series' OR path_key LIKE 'series/%')              AS series_labels;

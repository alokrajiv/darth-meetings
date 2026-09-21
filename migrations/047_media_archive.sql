-- Recordings live in Azure Blob — Stage A, the archive
-- (docs/recordings-blob-spec.md, on top of docs/recordings-first-class-design.md
-- §7 DEC-3). Two tiny bookkeeping tables; the archive itself needs NO schema
-- change because migration 044 already gave `recording_media` its `blob_name`,
-- `sha256` and `bytes` columns and `recordings` its `sha256`.
--
-- Additive only. Nothing reads these tables unless both MW_MEDIA_ARCHIVE and
-- DARTH_MEDIA_ACCOUNT are set; with the account unset the archive makes zero
-- queries, so this migration is safe to apply ahead of the code and rolling
-- back is "leave them empty".

-- CONVENTION (spec §5a): every migration here hard-codes the PROD schema on
-- the line below. Applying this to any other schema — the stage clone, a
-- local scratch cluster, the archive's integration check — means sed-ing that
-- one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_scratch/' 047_media_archive.sql | psql …
SET search_path = meeting_whisperer_prod, public;

-- Blobs whose media row is already gone.
--
-- Why a TABLE and not a jsonb stash on some surviving row: permanent delete
-- destroys the `transcripts` row AND (when no clip is left) the `recordings`,
-- `recording_media` and `recording_transcriptions` rows in one transaction, so
-- after it there is no row left that owns those blob names — a jsonb queue
-- would have to squat on an unrelated row. The alternative the spec rules out
-- is "list the container and delete every blob whose recording id no longer
-- exists", which is a full container scan per sweep.
--
-- The delete is enqueued by the same call that removes the rows and retried by
-- the media sweeper until the blob is gone (a missing blob counts as done —
-- Blob's delete is idempotent).
CREATE TABLE IF NOT EXISTS media_blob_deletes (
  -- `<recording_id>/<media_id><.ext>` in the media container.
  blob_name       text PRIMARY KEY,
  -- Kept for the log line and for forensics; both rows are already gone, so
  -- these are NOT foreign keys and must never be joined back.
  recording_id    uuid,
  media_id        uuid,
  queued_at       timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error      text
);
CREATE INDEX IF NOT EXISTS media_blob_deletes_queued_idx
  ON media_blob_deletes (queued_at);

-- The lifecycle canary (spec Stage A.4).
--
-- The transit account deletes every blob a day after its last write, with no
-- prefix filter. The media account must NOT — but a rule can be added to any
-- account later by anyone with management-plane access, and the first symptom
-- would be recordings quietly disappearing. So the archive writes a blob it
-- never touches again, `_canary/<YYYY-MM-DD>`, and refuses to archive anything
-- once a canary older than 36 h has vanished.
CREATE TABLE IF NOT EXISTS media_archive_canaries (
  -- The blob name, `_canary/<YYYY-MM-DD>`.
  name       text PRIMARY KEY,
  written_at timestamptz NOT NULL DEFAULT now(),
  -- Last time the blob was confirmed to still exist.
  last_ok_at timestamptz,
  -- Set the moment it is found missing; while ANY row has this set the
  -- archive refuses to write. Clearing it is a deliberate human act
  -- (scripts/media-archive-status.ts prints the statement).
  missing_at timestamptz
);

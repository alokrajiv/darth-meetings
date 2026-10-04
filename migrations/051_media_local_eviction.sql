-- Recordings live in Azure Blob — Stage D, the VM becomes a cache
-- (docs/recordings-stage-d-spec.md, which calls this file "048"; 048–050 were
-- already taken by the time it landed, so it is 051 — same DDL).
--
-- Two things are recorded here and nowhere else:
--  1. a READ-BACK verification per archived file: the blob was streamed back
--     from Azure, hashed, and matched `recording_media.sha256` + `bytes`, at
--     `blob_verified_at`. The Stage A stamp only proves "the hash computed while
--     uploading equals the metadata we set"; it never re-read the bytes.
--  2. every local copy Stage D removed, in an append-only ledger written in the
--     same transaction that sets `local_evicted_at` and BEFORE the unlink.
--
-- Additive only. Nothing reads these columns unless the media archive is
-- configured (DARTH_MEDIA_ACCOUNT + MW_MEDIA_ARCHIVE), and nothing deletes a
-- local file unless MW_MEDIA_EVICT=1 or a human runs
-- `scripts/media-evict.ts --apply`. The code probes for the columns once per
-- process, so a deploy ahead of this migration is inert, and rolling back is
-- "leave them NULL".

-- CONVENTION (spec §5a): every migration here hard-codes the PROD schema on
-- the line below. Applying this to any other schema — the stage clone, a
-- local scratch cluster, the eviction's integration check — means sed-ing that
-- one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_scratch/' 051_media_local_eviction.sql | psql …
SET search_path = meeting_whisperer_prod, public;

-- A verification is only ever valid for the hash it was computed against:
-- `stampMediaArchived` (a re-archive after a faststart remux, under the same
-- blob name) resets all six columns in the same UPDATE, and the eviction query
-- additionally requires `blob_verified_sha256 = sha256`.
ALTER TABLE recording_media
  ADD COLUMN IF NOT EXISTS blob_verified_at      timestamptz,  -- read-back matched sha256 + bytes
  ADD COLUMN IF NOT EXISTS blob_verified_sha256  text,         -- the hash the read-back produced
  ADD COLUMN IF NOT EXISTS blob_verified_bytes   bigint,
  ADD COLUMN IF NOT EXISTS blob_verify_failed_at timestamptz,  -- last read-back that did NOT match
  ADD COLUMN IF NOT EXISTS blob_verify_error     text,
  ADD COLUMN IF NOT EXISTS local_evicted_at      timestamptz;  -- local copy removed by Stage D

CREATE INDEX IF NOT EXISTS recording_media_verify_pending_idx
  ON recording_media (created_at) WHERE blob_name IS NOT NULL AND blob_verified_at IS NULL;
CREATE INDEX IF NOT EXISTS recording_media_evict_pending_idx
  ON recording_media (blob_verified_at) WHERE blob_verified_at IS NOT NULL AND local_evicted_at IS NULL;

-- Append-only. One row per local file Stage D removed. Never joined back (the
-- media row may be gone later), which is why nothing here is a foreign key.
-- A row whose file was ALREADY missing when the eviction came for it is
-- recorded too (`local_sha256 = ''`, `note = 'already gone …'`), so the media
-- row stops being a candidate and the ledger still says what happened.
CREATE TABLE IF NOT EXISTS media_local_evictions (
  id                bigserial PRIMARY KEY,
  media_id          uuid NOT NULL,
  recording_id      uuid NOT NULL,
  kind              text NOT NULL,
  filename          text NOT NULL,
  local_path        text NOT NULL,
  bytes             bigint NOT NULL,
  local_sha256      text NOT NULL,        -- hashed right before the unlink ('' = file already gone)
  blob_name         text NOT NULL,
  blob_sha256       text NOT NULL,        -- recording_media.sha256 at that moment (= blob_verified_sha256)
  blob_verified_at  timestamptz NOT NULL,
  evicted_at        timestamptz NOT NULL DEFAULT now(),
  evicted_by        text NOT NULL,        -- 'sweeper' | 'script:<user>@<host>'
  note              text
);
CREATE INDEX IF NOT EXISTS media_local_evictions_media_idx ON media_local_evictions (media_id);
CREATE INDEX IF NOT EXISTS media_local_evictions_evicted_idx ON media_local_evictions (evicted_at);

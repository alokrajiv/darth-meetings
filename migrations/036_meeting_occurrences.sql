-- Pre-import meeting identity: a calendar occurrence gets its /m/<uuid>
-- BEFORE anybody imports it (listing rows become clickable permalinks, and
-- auto-sync's "locked in" claim has a stable page to point at).
--
-- meetings rows may now exist with transcript_id NULL: provider_key carries
-- the occurrence's meeting code (Meet code / teams-<hash>) and occ_start the
-- UTC instant. When an import for the same (code, instant) later creates a
-- transcript identity, ensureMeeting ADOPTS the occurrence row — the uuid
-- handed out pre-import becomes the transcript's permanent /m/<uuid>, and
-- the existing former_ids/repoint machinery takes over from there.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE meetings ALTER COLUMN transcript_id DROP NOT NULL;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS occ_start timestamptz;

-- One unattached row per occurrence (attached rows keep their own
-- transcript_id UNIQUE; multiple NULL transcript_ids are fine).
CREATE UNIQUE INDEX IF NOT EXISTS meetings_occurrence_unattached_idx
  ON meetings (provider_key, occ_start)
  WHERE transcript_id IS NULL;

-- Adoption lookup: unattached rows by code.
CREATE INDEX IF NOT EXISTS meetings_unattached_key_idx
  ON meetings (provider_key)
  WHERE transcript_id IS NULL;

-- Uploads are born RECORDINGS, not meetings (design P7), and temporary means
-- a recording with an expiry (design P8) —
-- docs/recordings-meetings-series-design.md §1.2, §1.3, §5 P7/P8, §6.2 Q3/Q6/Q9.
--
-- Owner decision (Alok, 2026-09-23): recordings are personal and never shared;
-- only meetings are shared. An upload that names no meeting (no linked event,
-- no attach target) creates a `recordings` row + its media + its transcription
-- and NO `transcripts` row. It becomes part of a meeting only by its owner's
-- action (Link to meeting / Make a meeting). All of that is behind the flag
-- MW_RECORDINGS_BORN_BARE; this migration only adds the columns it needs.
--
-- Additive only, and safe to apply before the code ships: every new column is
-- nullable or has a default, nothing existing is rewritten, and the code
-- probes for `recordings.standalone` once per process and keeps the flag OFF
-- when this migration is missing (src/db-ops/standalone-recordings.ts).
-- Rolling back is "unset the flag"; the columns can stay.
--
-- PRIVACY: still no ACL anywhere (migration 044's rule). A standalone
-- recording is reachable by its OWNER (`recordings.owner_user_id`) or through
-- a meeting that holds a clip on it — nothing else. None of these columns is
-- ever served to anyone but the owner.

-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_stage/' 049_recordings_born_bare.sql | psql …
SET search_path = meeting_whisperer_prod, public;

-- A recording that exists on its own: born by an unlinked upload, owned by
-- the uploader, and NOT derived from any `transcripts` row. It outlives every
-- meeting that clips it — removing the last clip (unlink, permanent delete of
-- the meeting) hands it back to its owner's Recordings instead of deleting it
-- the way a derived recording goes with its meeting.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS standalone boolean NOT NULL DEFAULT false;

-- The recording's own name: the call's title (tray) or NULL (the UI then
-- shows "Recording · <when>", never a filename as a meeting title). A
-- meeting made from it takes a name of its own.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS title text;

-- P8: a temporary upload is a recording with an expiry. NULL = kept. The
-- 5-minute sweeper deletes an expired standalone recording (bytes and
-- transcription) unless a meeting holds a clip on it (invariant I6); Keep,
-- Link and Make a meeting clear it in the same write.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- In-flight bookkeeping of a standalone recording's upload and hand-off —
-- what a `transcripts` placeholder's gmeet_context carries for a meeting-born
-- upload: the multi-file group (parts, bytes, hashes), bytes received, the
-- heartbeat, the original filename and language, a kept ingest failure with
-- its retry schedule, and whether the owner dismissed the calendar
-- suggestion. Owner-only; never served to anyone else.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS upload_state jsonb;

-- The "your recording is transcribed" DM, claimed exactly once per
-- recording (risk §6.1: never twice, never zero times). A recording that is
-- later made into a meeting sends nothing more.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS ready_notified_at timestamptz;

-- Q9 (landmine #8): `recorder_recordings.transcript_id` points at a MEETING;
-- this points at the bytes. `transcript_id` is kept — the Darth Recorder tray
-- reads it for its "uploaded" state.
ALTER TABLE recorder_recordings ADD COLUMN IF NOT EXISTS recording_id uuid;

CREATE INDEX IF NOT EXISTS recordings_standalone_owner_idx
  ON recordings (owner_user_id, created_at DESC)
  WHERE standalone AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS recordings_expires_at_idx
  ON recordings (expires_at)
  WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- Parts 2..N of a multi-file upload find their recording by group id.
CREATE INDEX IF NOT EXISTS recordings_upload_group_idx
  ON recordings (owner_user_id, (upload_state->'group'->>'id'))
  WHERE standalone AND upload_state ? 'group';

CREATE INDEX IF NOT EXISTS recorder_recordings_recording_id_idx
  ON recorder_recordings (recording_id)
  WHERE recording_id IS NOT NULL;

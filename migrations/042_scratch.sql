-- Temporary ("scratch") transcripts: a quick one-off transcription the user
-- wants out of the way. scratch = true keeps the row OUT of the main listing,
-- search, series auto-attach / retro-attach, same-event sibling + dedupe
-- hints, the already-imported lookups (a scratch row never makes a calendar
-- event look imported) and the offline-plan defaults. It stays a real
-- transcript otherwise: the detail page, GET /api/transcripts/:id, every AI
-- pass, sharing, labels and /m/<uuid> links all work on it. A dedicated
-- "Temporary" tab lists them; linking a calendar event clears the flag;
-- the 5-minute sweeper soft-deletes scratch rows 30 days after creation
-- (deleted_at — normal trash behaviour from there, see 021_soft_delete.sql).
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS scratch boolean NOT NULL DEFAULT false;

-- The Temporary tab and the auto-trash sweep only ever touch live scratch
-- rows — a partial index keeps both off the main table's heap.
CREATE INDEX IF NOT EXISTS transcripts_scratch_live_idx
  ON transcripts (user_id, created_at)
  WHERE scratch AND deleted_at IS NULL;

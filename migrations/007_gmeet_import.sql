-- Google Meet / Drive import support.
--
-- drive_file_id: the Drive file ID of the imported recording (video mode) —
--   used for dedupe ("this meeting was already imported").
-- gmeet_context: everything we know about the source meeting, shape
--   GmeetContext in src/lib/format.ts: calendar event (id/title/times/
--   attendees), meeting code, artifact file IDs, and — when available — the
--   parsed Google Meet transcript (real speaker names, block-level timing)
--   kept as a sidecar for cross-referencing/alignment.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS drive_file_id text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS gmeet_context jsonb;

CREATE INDEX IF NOT EXISTS transcripts_drive_file_id_idx
  ON transcripts (drive_file_id)
  WHERE drive_file_id IS NOT NULL;

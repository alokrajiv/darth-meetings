-- Soft delete (trash): deleting a transcript stamps deleted_at instead of
-- destroying the row. Trashed rows vanish from listings, search, series,
-- dedupe, and every background poller/sweeper, but keep their AAI
-- transcript, audio files, shares, and notes so restore is lossless.
-- Permanent delete (trash view / placeholders) still removes the row.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- AI-suggested topical segments of the transcript, produced by the same
-- headless-Claude pass that writes auto_notes. Shape:
--   [{ "title": string, "start_ms": int }, ...]  (ordered by start_ms)
-- Rendered as named jump points in the right-rail outline (replacing the
-- arbitrary 5-equal-chunks timestamps) and as section headings inside the
-- transcript body.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_segments jsonb;

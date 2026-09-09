-- Which AssemblyAI speech model transcribed the row (Alok 2026-09-09).
-- NULL on rows created before this migration: every AAI-transcribed row
-- (uuid assemblyai_id) up to now ran on 'universal'; imports that never ran
-- AAI (gmeet-/teams- primaries) stay NULL for good. New AAI submits stamp
-- 'universal-3-5-pro' (the default from now on) so the detail page can
-- offer "re-transcribe with the newer model" only where it applies.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speech_model text;

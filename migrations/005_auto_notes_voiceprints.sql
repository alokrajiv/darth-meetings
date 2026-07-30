-- Auto-generated meeting notes (headless Claude on the VM) + voiceprint-based
-- speaker auto-identification.
--
-- auto_notes: markdown produced by `claude -p` after transcription completes.
-- Kept separate from the user-owned `description` (Notes) field so we never
-- clobber hand-written notes; the UI offers "copy into notes" instead.
--
-- voiceprints: one row per known person (keyed by normalized display name,
-- matching the free-text customName convention used by speaker_mappings).
-- `embedding` is a 192-dim ECAPA-TDNN speaker vector stored as jsonb; at our
-- scale a linear cosine scan beats introducing pgvector. `sample_count` lets
-- enrollment do an incremental rolling average across meetings.
--
-- speaker_mappings.suggestions: per-transcript auto-detected names, shape
-- { "<originalSpeaker>": { "name": string, "confidence": number } }.
-- Confirming a suggestion just writes speaker_labels through the normal flow.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_notes        text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_notes_status text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_notes_error  text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_notes_at     timestamptz;

CREATE TABLE IF NOT EXISTS voiceprints (
  id           serial      PRIMARY KEY,
  name         text        NOT NULL,
  name_key     text        NOT NULL UNIQUE, -- lower(trim(name))
  embedding    jsonb       NOT NULL,        -- float[192]
  sample_count integer     NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE speaker_mappings ADD COLUMN IF NOT EXISTS suggestions jsonb;

-- Transcript Docs that Google produced for meetings with NO captured speech.
--
-- Gemini-notes Docs always get attached to the calendar event, even when the
-- meeting had "not enough conversation" — the Transcript tab then only says
-- "Transcription ended after HH:MM:SS". The series sweep counts a Doc as an
-- importable transcript (it cannot know otherwise without reading it), so a
-- series "Import all" would re-queue and re-fail these forever. The import
-- probes the Doc at queue time (and the poller/inline paths on execution),
-- notes the empty Doc here, and the sweep marks the occurrence "transcript
-- empty" — not importable. Keyed by Doc id: the Doc IS the artifact.
CREATE TABLE IF NOT EXISTS empty_transcript_docs (
  doc_id       text        PRIMARY KEY,
  meeting_code text,
  event_id     text,
  occ_start    timestamptz,
  title        text,
  ended_after  text,        -- "HH:MM:SS" from the Transcript tab header
  noted_by     uuid,
  noted_at     timestamptz NOT NULL DEFAULT now()
);

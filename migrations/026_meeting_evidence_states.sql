-- Classified evidence states on the artifact cache (docs/meeting-evidence-
-- consolidation.md, Phase 1). Until now the SQL views re-derived
-- has-recording / has-transcript from raw counts, with two famous lies:
--  D4: recording_count counted file-less (never-generated) entries — 20/138
--      prod rows showed a "Recording" badge with a dead Drive link;
--  D3: the unimported WHERE counted transcript_parseable (Teams rows) but
--      the SELECT's has_transcript didn't, so a row could be listed as
--      importable while its glyph said "No recording".
-- The states are computed ONCE, in src/lib/meeting-evidence.ts, at write
-- time; the views only read them.
--
--  recording_state:  none | generating | partial | ready
--  transcript_state: none | generating | ready | unparseable
--  transcript_source: meet | gemini | teams

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE gmeet_meeting_cache
  ADD COLUMN IF NOT EXISTS recordings_listed    int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ready_recording_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transcripts_listed   int  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recording_state      text,
  ADD COLUMN IF NOT EXISTS transcript_state     text,
  ADD COLUMN IF NOT EXISTS transcript_source    text;

-- Backfill from what the old columns can prove. Conservative:
--  - ready count: raw->recordings entries with a driveDestination file when
--    raw is present; else video_file_id presence stands in for "≥1 ready".
--  - a legacy recording_count>0 row with no file ever seen = 'generating'
--    (the display layer ages that to "nothing" for old events rather than
--    resurrecting the dead-link badge).
UPDATE gmeet_meeting_cache SET
  recordings_listed = recording_count,
  ready_recording_count = CASE
    -- Graph never lists file-less entries, so every Teams count is ready.
    WHEN meeting_code LIKE 'teams-%' THEN recording_count
    -- Meet rows: count entries whose Drive file actually exists. NB a
    -- count(*) subquery yields 0 (never NULL) when raw is absent, so the
    -- fallback must be an explicit jsonb_typeof guard, not COALESCE.
    WHEN jsonb_typeof(raw->'recordings'->'recordings') = 'array' THEN
      (SELECT count(*)::int FROM jsonb_array_elements(raw->'recordings'->'recordings') r
        WHERE r->'driveDestination'->>'file' IS NOT NULL)
    WHEN video_file_id IS NOT NULL THEN recording_count
    ELSE 0
  END,
  transcripts_listed = GREATEST(
    COALESCE(jsonb_array_length(raw->'transcripts'->'transcripts'), 0),
    COALESCE(jsonb_array_length(transcript_doc_ids), 0)
  )
WHERE recording_state IS NULL;

UPDATE gmeet_meeting_cache SET
  recording_state = CASE
    WHEN ready_recording_count >= recordings_listed AND ready_recording_count > 0 THEN 'ready'
    WHEN ready_recording_count > 0 THEN 'partial'
    WHEN recordings_listed > 0 THEN 'generating'
    ELSE 'none'
  END,
  transcript_state = CASE
    WHEN COALESCE(jsonb_array_length(transcript_doc_ids), 0) > 0 OR transcript_parseable IS TRUE
      THEN CASE WHEN transcript_parseable IS FALSE THEN 'unparseable' ELSE 'ready' END
    WHEN transcripts_listed > 0 THEN 'generating'
    ELSE 'none'
  END,
  transcript_source = CASE
    WHEN meeting_code LIKE 'teams-%' AND transcript_parseable IS TRUE THEN 'teams'
    WHEN COALESCE(jsonb_array_length(transcript_doc_ids), 0) > 0 THEN 'meet'
    ELSE NULL
  END
WHERE recording_state IS NULL;

-- Calendar attachments (the post-call Docs/videos Meet pins to the event).
-- The poller now persists their classification per event — the ONLY evidence
-- that survives the Meet record's ~30d retention, and the only evidence
-- Gemini-notes-only meetings ever get (D1).
ALTER TABLE calendar_event_cache
  ADD COLUMN IF NOT EXISTS attachment_video_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attachment_video_file_id text,
  ADD COLUMN IF NOT EXISTS attachment_transcript_doc_id text,
  ADD COLUMN IF NOT EXISTS attachment_gemini_notes boolean NOT NULL DEFAULT false;

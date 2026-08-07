-- Poll-time metadata snapshot per meeting occurrence (workstream: crisp
-- import UX). Captured ONCE per meeting by the first connected user whose
-- token can see the artifacts, then served to everyone for display: the
-- import dialog shows duration / size / turn counts instantly instead of
-- fanning out Google API calls in the browser, and the sync view can skip
-- meetings with nothing real to import.
--
-- ACCESS RULE (deliberate): rows here never grant content access. Importing
-- or joining a meeting always re-verifies through the acting user's own
-- Google token — the cache only ever powers display metadata. That is why
-- no transcript CONTENT is stored, only counts/flags/names; the parsed Doc
-- itself stays at Google (Docs don't expire, unlike Meet API entries) and
-- is re-fetched with the importer's token at import time.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS gmeet_meeting_cache (
  event_key            text        PRIMARY KEY,  -- "<meetingCode>|<eventStartIso>"
  meeting_code         text        NOT NULL,
  event_start          timestamptz,              -- calendar occurrence start
  conference_record    text,                     -- conferenceRecords/<id>
  conf_start           timestamptz,              -- actual start per Meet API
  conf_end             timestamptz,
  recording_count      int         NOT NULL DEFAULT 0,
  video_file_id        text,                     -- first recording's Drive file
  video_size           bigint,
  video_duration_ms    bigint,
  transcript_doc_ids   jsonb,                    -- string[]; >1 = stop/start sessions
  -- null = Doc not fetched yet (retry next sweep); false = fetched fine but
  -- zero utterances parsed → quick import WILL fail, warn before the click.
  transcript_parseable boolean,
  utterance_count      int,
  word_count           int,
  speakers             jsonb,                    -- string[] display names from the Doc
  recurring_event_id   text,                     -- Calendar series key (outranks meeting_code
                                                 -- for identity: Meet links get recycled)
  ical_uid             text,
  organizer_email      text,
  -- Verbatim structured API payloads captured along the way (conference
  -- record get, recordings list, transcripts list). Cheap to keep, and
  -- every field Google adds later is preserved without a migration.
  raw                  jsonb,
  captured_by          uuid,                     -- whose token captured it (provenance only)
  captured_at          timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gmeet_meeting_cache_code_idx
  ON gmeet_meeting_cache (meeting_code);

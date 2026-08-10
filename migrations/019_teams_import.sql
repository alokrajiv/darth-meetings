-- Microsoft Teams import (docs/teams-integration-spec.md §7).
--
-- No new tables: Teams rows overload gmeet_context with a `teams` object
-- (provider marker, canonical join URL, Graph meeting id, occurrence callId,
-- artifact ids) and reuse gmeet_meeting_cache with a join-URL-hash meeting
-- code. These expression indexes power the dedupe lookups, mirroring
-- transcripts_gmeet_meeting_code_idx from 011:
--   - callId: exact occurrence identity, known after artifact resolution
--     (import-time cross-user dedupe).
--   - joinWebUrl: pre-resolution identity straight from the calendar event
--     (check-time dedupe, no Graph call in the hot path); occurrence scoping
--     happens by time window on top, like Meet's code+window matching.

SET search_path = meeting_whisperer_prod, public;

CREATE INDEX IF NOT EXISTS transcripts_teams_call_id_idx
  ON transcripts ((gmeet_context->'teams'->>'callId'))
  WHERE gmeet_context IS NOT NULL;

CREATE INDEX IF NOT EXISTS transcripts_teams_join_url_idx
  ON transcripts ((gmeet_context->'teams'->>'joinWebUrl'))
  WHERE gmeet_context IS NOT NULL;

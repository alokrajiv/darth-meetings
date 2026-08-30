-- T1: one stable id per meeting, independent of provider id churn.
--
-- Problem: a queued import's transcript row is a placeholder (`defer-<uuid>`,
-- `up-<uuid>`) whose assemblyai_id is RENAMED on promotion (video modes) or
-- retired in favor of a fresh `gmeet-…`/`teams-…` row (transcript mode), so a
-- URL taken at click time can die minutes later. `meetings` gives every
-- meeting a uuid that never changes: `/m/<uuid>` always redirects to the
-- CURRENT transcript id, and `former_ids` remembers every id the meeting has
-- ever worn so even old /transcript/<defer-…> links can self-heal.
--
-- One row per transcript IDENTITY (assemblyai_id), not per (user,id) row —
-- when two users hold copies of the same import they share the meeting row.
-- provider_key carries the canonical occurrence key when known (Meet meeting
-- code / Teams join URL); it is deliberately NOT unique yet — cross-user
-- dedupe (T2) will decide the constraint once the account-level auto-sync
-- lands.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS meetings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Current transcripts.assemblyai_id (also covers waiting/uploading
  -- placeholders — those ARE transcript rows).
  transcript_id text        NOT NULL UNIQUE,
  -- Every previous transcript_id this meeting had (renames append here).
  former_ids    text[]      NOT NULL DEFAULT '{}',
  provider      text        NOT NULL,  -- gmeet | teams | upload | import
  -- Canonical occurrence key when known: Meet meeting code or Teams join URL.
  provider_key  text,
  title_hint    text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meetings_former_ids_idx ON meetings USING gin (former_ids);
CREATE INDEX IF NOT EXISTS meetings_provider_key_idx ON meetings (provider_key);

-- Backfill: one meeting per existing transcript identity. Provider from the
-- id prefix (matches how ids are minted), provider_key from the context's
-- meeting code where present. min(user_id::text) is only a tie-break for the
-- rare two-owner import.
INSERT INTO meetings (transcript_id, provider, provider_key, title_hint, created_by, created_at)
SELECT
  t.assemblyai_id,
  CASE
    WHEN t.assemblyai_id LIKE 'gmeet-%' THEN 'gmeet'
    WHEN t.assemblyai_id LIKE 'teams-%' THEN 'teams'
    WHEN max(t.gmeet_context->>'provider') = 'teams' THEN 'teams'
    WHEN max(t.gmeet_context->>'meetingCode') IS NOT NULL THEN 'gmeet'
    WHEN max(t.source) = 'imported' THEN 'import'
    ELSE 'upload'
  END,
  COALESCE(max(t.gmeet_context->'teams'->>'joinWebUrl'), max(t.gmeet_context->>'meetingCode')),
  max(t.title),
  min(t.user_id::text)::uuid,
  min(t.created_at)
FROM transcripts t
GROUP BY t.assemblyai_id
ON CONFLICT (transcript_id) DO NOTHING;

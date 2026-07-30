-- When the MEETING actually happened, as opposed to when the row was created
-- (created_at — which is upload time and can be months later for imported
-- recordings). Auto-filled from the source calendar event / Meet conference
-- when known, editable by hand, backfilled here for existing Meet imports.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS recorded_at timestamptz;

-- Backfill Meet imports from their captured event/conference start time.
UPDATE transcripts
SET recorded_at = COALESCE(
  NULLIF(gmeet_context->>'startTime', '')::timestamptz,
  NULLIF(gmeet_context->'actuals'->>'conferenceStart', '')::timestamptz
)
WHERE recorded_at IS NULL
  AND gmeet_context IS NOT NULL
  AND COALESCE(
    NULLIF(gmeet_context->>'startTime', ''),
    NULLIF(gmeet_context->'actuals'->>'conferenceStart', '')
  ) IS NOT NULL;

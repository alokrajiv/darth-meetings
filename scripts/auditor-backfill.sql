-- Give the auditors a read share of every EXISTING meeting with an outside
-- party on it — the same rule new meetings follow (src/lib/auditor-policy.ts
-- + shareWithAuditors in src/lib/server/auto-share.ts). First run
-- 2026-10-06; re-run it after adding someone to the `auditors` table
-- (migration 054 — WHO the auditors are lives there now, not in a VALUES
-- list here). The domain lists below MIRROR auditor-policy.ts; change them
-- together.
--
--   outside party = an invitee / the organizer on a domain that is not
--     internal (trames.sg, trames-engineering.com), not a calendar resource
--     (*.calendar.google.com) and not a personal mailbox (gmail.com & co. —
--     candidate interviews are not customer conversations);
--   an auditor never gets a share of a meeting they own, an existing share is
--     never touched (ON CONFLICT DO NOTHING), and an auditor removed from a
--     meeting before (auditor_share_removals, migration 052) is skipped.
--
-- Needs 048 (origin) + 052 (the ledger) + 054 (auditors). Idempotent: a
-- re-run adds nothing.
-- Dry run: wrap in BEGIN … ROLLBACK and read the RETURNING rows.
SET search_path = meeting_whisperer_prod, public;

WITH aud AS (
  SELECT lower(email) AS email, name FROM auditors
),
auditor_ids AS (
  -- the auditor's own user_id(s), to skip meetings they own
  SELECT DISTINCT a.email, ta.user_id
  FROM aud a JOIN transcript_activity ta ON lower(ta.user_email) = a.email
),
emails AS (
  SELECT t.id, lower(e) AS email
  FROM transcripts t
  CROSS JOIN LATERAL (
    SELECT a->>'email' FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.gmeet_context->'attendees') = 'array'
           THEN t.gmeet_context->'attendees' ELSE '[]'::jsonb END) a
    UNION ALL SELECT t.gmeet_context->>'organizerEmail'
  ) x(e)
  WHERE t.deleted_at IS NULL AND NOT t.scratch AND e IS NOT NULL AND e LIKE '%@%'
),
external_meetings AS (
  SELECT DISTINCT id FROM emails
  WHERE split_part(email, '@', 2) NOT IN ('trames.sg', 'trames-engineering.com')
    AND split_part(email, '@', 2) NOT LIKE '%calendar.google.com'
    AND split_part(email, '@', 2) NOT IN (
      'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.sg', 'hotmail.com',
      'outlook.com', 'live.com', 'icloud.com', 'me.com')
)
INSERT INTO transcript_shares (
  transcript_id, owner_user_id, shared_by_user_id,
  shared_with_email, shared_with_name, shared_with_ppl_id, access, origin
)
SELECT t.id, t.user_id, t.user_id, a.email, a.name, NULL, 'read', 'auditor-external'
FROM external_meetings m
JOIN transcripts t ON t.id = m.id
CROSS JOIN aud a
WHERE NOT EXISTS (SELECT 1 FROM auditor_ids ai WHERE ai.email = a.email AND ai.user_id = t.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM auditor_share_removals r
    WHERE r.transcript_id = t.id AND r.auditor_email = a.email)
ON CONFLICT (transcript_id, shared_with_email) DO NOTHING
RETURNING transcript_id, shared_with_email;

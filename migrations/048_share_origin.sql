-- Where a share CAME FROM (docs/recorder-link-confirm-spec.md D5).
--
-- "Unlink this recording from that meeting" has to undo exactly what the link
-- did — including the shares the link created. On 2026-09-22 a Slack huddle
-- was auto-linked to a Google Meet invite and, at the same instant, shared
-- with the invite's 8 internal invitees with EDIT access; the repair had to
-- pick those rows out by hand. From now on a share that exists only because
-- a calendar event was attached is stamped `origin = 'event-link'`, and the
-- unlink deletes by that stamp.
--
-- Additive and optional: every writer and reader goes through
-- src/db-ops/share-origin.ts, which probes for the column once per process
-- and simply omits it when this migration has not been applied (the same
-- shape as 045's aai_job_id). Rolling back is "leave the column alone".
--
-- Values, today: 'event-link' (an auto-share fired when a calendar event was
-- attached to the meeting). NULL = a share from before this migration, or one
-- a human made in the Share dialog — never deleted by an unlink.

-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_stage/' 048_share_origin.sql | psql …
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcript_shares
  ADD COLUMN IF NOT EXISTS origin text;

-- The only query the column serves: "the link-born shares of this meeting".
CREATE INDEX IF NOT EXISTS transcript_shares_origin_idx
  ON transcript_shares (transcript_id, origin)
  WHERE origin IS NOT NULL;

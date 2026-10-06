-- Auditor shares (src/lib/auditor-policy.ts): a meeting with an outside party
-- is shared read-only with the auditors, stamped
-- `transcript_shares.origin = 'auditor-external'` (048's column). The owner
-- (or an editor) may remove an auditor's share — allowed, but recorded here,
-- and a removed auditor is never auto-added to that meeting again.
--
-- Append-only ledger. No FK to transcripts on purpose: the record of who
-- removed an auditor outlives the meeting (a trashed-then-purged meeting
-- keeps its row here, with the title it had).
--
-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first.
SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS auditor_share_removals (
  id                 serial PRIMARY KEY,
  transcript_id      integer     NOT NULL,
  auditor_email      text        NOT NULL,
  removed_by_user_id uuid        NOT NULL,
  removed_by_email   text        NOT NULL,
  meeting_title      text,
  removed_at         timestamptz NOT NULL DEFAULT now()
);

-- "Was this auditor removed from this meeting?" — the auto-add's guard.
CREATE INDEX IF NOT EXISTS auditor_share_removals_tx_email_idx
  ON auditor_share_removals (transcript_id, auditor_email);

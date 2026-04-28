-- Per-transcript sharing: the owner can grant other Trames users read or
-- edit access to a transcript. Identity is by email (the durable identifier
-- across SSO logins), resolved against the Trames directory (darth_plagueis.ppl)
-- at picker time but stored here as a plain lowercased email.
--
-- Edits do NOT get a per-collaborator layer — collaborators with 'edit'
-- access write to the owner's `transcript_edits` / `speaker_mappings` rows.
-- Last-write-wins. Simpler and what "collaboration" usually means.

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS transcript_shares (
  id                  serial PRIMARY KEY,
  transcript_id       integer      NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  owner_user_id       uuid         NOT NULL,
  shared_with_email   text         NOT NULL,
  shared_with_name    text,
  shared_with_ppl_id  integer,
  access              text         NOT NULL CHECK (access IN ('edit','read')),
  shared_by_user_id   uuid         NOT NULL,
  shared_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

-- One share per (transcript, email). Email stored lowercased by the app.
CREATE UNIQUE INDEX IF NOT EXISTS transcript_shares_txid_email_key
  ON transcript_shares (transcript_id, shared_with_email);

-- Fast "what is shared with me?" lookup for the listing page.
CREATE INDEX IF NOT EXISTS transcript_shares_email_idx
  ON transcript_shares (shared_with_email);

-- Fast "who has access to this transcript?" lookup for the share dialog.
CREATE INDEX IF NOT EXISTS transcript_shares_transcript_idx
  ON transcript_shares (transcript_id);

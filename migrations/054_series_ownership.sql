-- Curated series v2 — a series runs as its OWNER (docs/curated-series-spec.md
-- §11, owner 2026-10-06 evening). Additive only: safe to apply BEFORE the
-- deploy that reads it (the live v1 code never touches these columns or
-- tables). The one constraint change §11.8 asks for — a meeting may be in
-- several series — is migrations/055_series_multi_membership.sql, applied
-- AFTER the deploy: dropping series_members' transcript_id UNIQUE breaks the
-- v1 code's `ON CONFLICT (transcript_id)` writes.
--
--  - series.owner_user_id / owner_email: the person a series runs as. A
--    series can only ever match meetings its owner can open (owns, or holds
--    any share on) — unless the owner is an auditor (the `auditors` table
--    below), whose series reach every meeting. Backfilled from created_by;
--    the email from the activity log, the only identity table in this app
--    (db-ops/transcript-activity identitiesForUsers). Rows it cannot map keep
--    owner_email NULL until scripts/series-ownership-seed.ts sets them. A
--    series the still-running v1 code creates between this migration and the
--    v2 deploy has no owner — re-run the UPDATE below after the deploy (it
--    only touches rows with owner_email IS NULL).
--  - series_editors: may edit the definition and manage editors + followers
--    (never transfer or delete). On an auditor-owned series every editor must
--    be an auditor (enforced by the routes).
--  - auditors: the ONE deliberate exception to "a series reaches what its
--    owner reaches", and the people external meetings are auto-shared with
--    (lib/auditor-policy.ts, lib/server/auto-share.ts). Replaces the
--    hard-coded AUDITORS list. No UI edits it — psql by Alok:
--      INSERT INTO auditors (email, name, added_by_email)
--        VALUES ('x@trames.sg', 'X Y', 'alok@trames.sg');
--    The app re-reads it within ~60 s.
--
-- The code probes for these objects (src/db-ops/series-ownership-schema.ts)
-- and keeps every series write and the matcher off until they exist.
--
-- CONVENTION (docs/recordings-phase1-spec.md §5a): every migration here
-- hard-codes the PROD schema on the line below. Applying this to any other
-- schema means sed-ing that one line first.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE series ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE series ADD COLUMN IF NOT EXISTS owner_email text;      -- lower-cased

UPDATE series s
SET owner_user_id = s.created_by,
    owner_email = (
      SELECT lower(ta.user_email)
      FROM transcript_activity ta
      WHERE ta.user_id = s.created_by
      ORDER BY ta.at DESC
      LIMIT 1
    )
WHERE s.owner_email IS NULL;

CREATE INDEX IF NOT EXISTS series_owner_email_idx ON series (owner_email);

CREATE TABLE IF NOT EXISTS series_editors (
  series_id      int  NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  email          text NOT NULL,             -- lower-cased
  name           text,
  added_by_email text NOT NULL,
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, email)
);
CREATE INDEX IF NOT EXISTS series_editors_email_idx ON series_editors (email);
CREATE INDEX IF NOT EXISTS series_followers_email_idx ON series_followers (email);

CREATE TABLE IF NOT EXISTS auditors (
  email          text PRIMARY KEY,          -- lower-cased
  name           text NOT NULL,
  added_at       timestamptz NOT NULL DEFAULT now(),
  added_by_email text
);
INSERT INTO auditors (email, name, added_by_email) VALUES
  ('alok@trames.sg', 'Alok Rajiv', 'alok@trames.sg'),
  ('ivan@trames.sg', 'Ivan Seow', 'alok@trames.sg')
ON CONFLICT (email) DO NOTHING;

-- Eyeball before deploying v2: every series should have the owner you expect
-- (the 2026-10-06 seed set #66–#83 → alok@trames.sg, an auditor — so they
-- keep reaching every meeting). A NULL or unexpected owner here would shrink
-- that series to its owner's reach on the first v2 sweep; fix it (or run
-- scripts/series-ownership-seed.ts) first.
SELECT id, title, owner_email, owner_email IN (SELECT email FROM auditors) AS owner_is_auditor
FROM series ORDER BY id;

-- 057: google_accounts becomes a MIRROR of darth-auth's account links
-- (plans/connectors/SWITCH-2026-10-12.md).
--
-- Since 2026-10-12 darth-auth owns every Google link: people connect on
-- auth…/connections, auth holds the refresh token, and this app fetches access
-- tokens from POST {auth}/api/links/google/token (src/lib/server/google-oauth.ts).
-- google_accounts stays as this app's POLL BOOKKEEPING — who to sweep,
-- last_poll_at, teams_chat_backfilled_at — re-synced from
-- POST {auth}/api/links/google/lookup at the top of every poller sweep
-- (src/lib/server/google-link-sync.ts). People who linked only on auth get a
-- row with NO token, hence the dropped NOT NULL.
--
-- refresh_token_enc is DEAD: nothing reads or writes it any more. The old
-- blobs stay as the rollback snapshot until Alok ends the soak (plan step 7
-- drops the column and GOOGLE_TOKEN_ENC_KEY).
--
-- APPLY BEFORE THE DEPLOY. Harmless to the old code (it never inserts NULL).
-- Without it the new code still runs, but the sync's INSERT for a person who
-- linked only on auth fails (logged, skipped) and they are not polled.
SET search_path = meeting_whisperer_prod, public;

ALTER TABLE google_accounts ALTER COLUMN refresh_token_enc DROP NOT NULL;

COMMENT ON TABLE google_accounts IS
  'Poll bookkeeping, mirrored from darth-auth account_links (provider google) since 2026-10-12. auth owns the link and the refresh token; refresh_token_enc is dead (rollback snapshot only).';
COMMENT ON COLUMN google_accounts.refresh_token_enc IS
  'DEAD since 2026-10-12 — tokens come from darth-auth. Dropped after the soak.';

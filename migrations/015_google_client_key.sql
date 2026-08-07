-- Multi-workspace OAuth: which client a connection was minted by.
-- 'sg'  = trames.sg Internal client (meeting-whisperer-504016)
-- 'eng' = trames-engineering.com Internal client (darth-504810)
-- Refresh tokens are client-bound at Google, so refresh/revoke must use the
-- same client that issued them.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE google_accounts
  ADD COLUMN IF NOT EXISTS client_key text NOT NULL DEFAULT 'sg';

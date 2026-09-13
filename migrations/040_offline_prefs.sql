-- Offline support: per-account defaults for what the browser keeps available
-- offline (service worker + Cache Storage on each device).
--
-- offline_prefs: {"transcripts": 100, "audio": 10, "video": 0}
--   transcripts = newest N meetings whose page + transcript JSON are cached
--   audio       = newest N of those that also get an audio-only copy
--   video       = newest N of those that also get the full recording
-- NULL = app defaults (100 / 10 / 0). Manual per-meeting pins are a device
-- concern (IndexedDB) and are NOT stored here.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS offline_prefs jsonb;

COMMENT ON COLUMN user_prefs.offline_prefs IS
  'Offline auto-pin counts {"transcripts","audio","video"}; NULL = app defaults 100/10/0';

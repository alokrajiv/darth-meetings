-- Live upload visibility: uploads now create their row BEFORE the bytes
-- arrive (status 'uploading', synthetic `up-<uuid>` assemblyai_id that gets
-- rewritten to the real AAI id on submit). Progress is persisted here,
-- debounced, so every viewer's listing can show a live percentage.
-- upload_progress_at doubles as the liveness heartbeat the sweeper uses to
-- reap uploads orphaned by a closed tab or pm2 restart.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS upload_bytes_received bigint;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS upload_bytes_total bigint;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS upload_progress_at timestamptz;

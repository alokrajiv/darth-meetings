-- darth uploads (Azure Blob transit) as a byte-delivery MODE of the chunked
-- upload session (2026-09-18; lifted from ../chat E8c-7, SPEC §20.23 (b)).
-- A file ≥ 8 MiB goes browser → Azure Blob (account darthuploads, container
-- meetings, per-blob user-delegation SAS) in parallel 4 MiB blocks, and on
-- complete the VM pulls the committed blob ONCE over the Azure backbone into
-- the session's temp file (sha256 verified), then the shared finalize tail
-- runs unchanged. Tailscale is out of the byte path (the 408s of
-- 2026-09-18). The blob name is <user>/<session id>/<name>: same user +
-- fingerprint → same open session → same blob → the client resumes from the
-- uncommitted block list Azure keeps. Nothing changes for 'chunks' rows.
SET search_path = meeting_whisperer_prod, public;

-- 'chunks' (PUT /chunks/:idx through the VM) | 'blob' (Azure Blob transit).
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS via text NOT NULL DEFAULT 'chunks';
-- Blob sessions: the blob's name in the container, the whole-file sha256 the
-- client computed before opening (verified during the pull), and when the
-- last minted write SAS expires (re-opening the session re-mints it).
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS blob_name text;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS sas_expires_at timestamptz;

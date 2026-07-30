-- "Attached context" for a transcript: files (decks, PDFs, docs) and
-- typed/pasted text that collaborators add before generating AI notes.
-- Visible to everyone with access to the transcript; fed into the
-- notes-generation prompt (text_content holds pasted text, or the text we
-- extracted from the file at upload time).

SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS transcript_attachments (
  id                 serial PRIMARY KEY,
  transcript_id      integer      NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  added_by_user_id   uuid         NOT NULL,
  added_by_email     text,
  kind               text         NOT NULL CHECK (kind IN ('text','file')),
  title              text         NOT NULL,
  -- pasted text (kind='text') or best-effort extracted file text (kind='file')
  text_content       text,
  -- file storage (kind='file'): stored name under MW_STORAGE_DIR/attachments/
  filename           text,
  original_filename  text,
  mime_type          text,
  size_bytes         bigint,
  -- 'ok' = text extracted, 'none' = format not extractable, 'failed' = tried and errored
  extraction_status  text,
  created_at         timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_attachments_transcript_idx
  ON transcript_attachments (transcript_id);

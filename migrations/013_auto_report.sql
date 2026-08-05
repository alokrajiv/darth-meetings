-- Detailed AI report — the second summary tier. auto_notes stays the quick,
-- clean summary; auto_report is the on-demand wiki-style deep dive (topic
-- sections, embedded video frames, clickable [m:ss](t:<ms>) citations,
-- attachment links), generated at high reasoning effort.

SET search_path = meeting_whisperer_prod, public;

ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_report text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_report_status text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_report_error text;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS auto_report_at timestamptz;

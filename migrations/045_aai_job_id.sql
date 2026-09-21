-- First-class recordings, Phase 1b — the ids we mint
-- (docs/recordings-phase1b-spec.md, on top of DEC-4 in
-- docs/recordings-first-class-design.md §7).
--
-- Until now an upload's MEETING id WAS its AssemblyAI job id: `promoteUploadingRow`
-- renamed the `up-<uuid>` placeholder to whatever AssemblyAI called the job, the
-- media file was named after it, and every poller asked "is `assemblyai_id`
-- UUID-shaped?" to mean "this is an AssemblyAI job". Under DEC-4 the job is
-- disposable (24 h retention, we delete it ourselves), so it cannot go on being
-- anyone's identity.
--
-- After this migration the job id lives HERE and `assemblyai_id` is only the
-- document's opaque public id (D-H: the column is NOT renamed — ~27 files, the
-- URLs, `transcript_edits`/`speaker_mappings` uniqueness and darth-cli all key on
-- that name). A new upload's meeting id becomes the bare uuid of its placeholder
-- (`up-1234…` → `1234…`), which keeps every "no known prefix ⇒ an ordinary
-- transcribed upload" test correct with zero edits.
--
-- Additive, and the code tolerates it being absent: `aaiJobIdOf()` falls back to a
-- UUID-shaped `assemblyai_id`, and `MW_MINTED_IDS` is forced OFF until the column
-- exists (src/db-ops/aai-job-id.ts). So this can be applied before or after the
-- deploy, and rolling back is "leave the column alone".
--
-- The UPDATE below stamps the legacy rows whose meeting id IS their job id. On
-- prod (read-only check, 2026-09-22) that is exactly 502 of 691 rows; the other
-- 189 are 144 gmeet- + 21 teams- + 14 ext- + 1 up- + 9 defer-, and no row is
-- neither UUID-shaped nor one of those prefixes.

-- CONVENTION (spec §5a): every migration here hard-codes the PROD schema on the
-- line below. Applying this to any other schema — the stage clone, a local
-- scratch cluster, an integration check — means sed-ing that one line first.
SET search_path = meeting_whisperer_prod, public;

-- The AssemblyAI job that produced this row's content. NULL = never went to
-- AssemblyAI (gmeet-/teams-/ext- imports, a placeholder that has not been
-- submitted yet), or a legacy row this migration has not stamped.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS aai_job_id text;

-- Every row born before 1b: the meeting id IS the job id.
UPDATE transcripts SET aai_job_id = assemblyai_id
 WHERE aai_job_id IS NULL
   AND assemblyai_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- NOT unique: one legacy job (f4a32ca1-f1d4-442e-a848-c39053648adc) is held by
-- two owners, which is exactly what `UNIQUE (user_id, assemblyai_id)` allows.
-- New rows can never share a job, but that is a property of the writer, not
-- something this index should enforce over history.
CREATE INDEX IF NOT EXISTS transcripts_aai_job_id_idx
  ON transcripts (aai_job_id) WHERE aai_job_id IS NOT NULL;

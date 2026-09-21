-- First-class recordings, Phase 2 — a new transcription on the SAME meeting
-- (docs/recordings-phase2-spec.md, on top of
-- docs/recordings-first-class-design.md §5 D-G and §7).
--
-- Until now "re-transcribe" made a SECOND meeting row: a new /m link, a
-- sibling in the listing, shares re-derived from the calendar event, the
-- edits and the speaker names left behind on the old row, and it could be
-- done once only. After this migration a MEETING is stable and a
-- TRANSCRIPTION is a version of what was heard on its recording: re-run with
-- another model or another language, keep every version, switch between them.
--
-- `recording_transcriptions` (migration 044) already holds one row per job
-- and `recordings.active_transcription_id` already says which one is live, so
-- Phase 2 adds only the two things versions need that 044 has nowhere to put:
-- somewhere to PARK the annotations of the version being left, and the record
-- of who asked for a run and why.
--
-- Additive, and the code tolerates it being absent: `MW_TRANSCRIPTION_VERSIONS`
-- is forced OFF until every object below exists (src/db-ops/transcriptions.ts
-- probes them once per process), and with it off `POST …/retranscribe` answers
-- exactly as it does today — a new meeting row. So this can be applied before
-- or after the deploy, and rolling back is "leave the table alone".
--
-- Depends on 044 (the recordings tables) and 045 (`transcripts.aai_job_id`):
-- activating a version rewrites the meeting's job id, which has to have a
-- column of its own or the meeting would be left pointing at a job that
-- produced a payload it no longer carries.

-- CONVENTION (spec §5a): every migration here hard-codes the PROD schema on
-- the line below. Applying this to any other schema — the stage clone, a
-- local scratch cluster, the Phase 2 integration check — means sed-ing that
-- one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_p2test/' 046_transcription_versions.sql | psql …
SET search_path = meeting_whisperer_prod, public;

-- The annotations of a version that is NOT live, parked verbatim.
--
-- Why park them rather than carry them across: utterance edits are keyed by
-- INDEX into `imported_content.utterances` and speaker names by the letter
-- label of ONE diarization run, so neither can be applied to another version
-- without meaning something different (design §4 landmines 2 and 12). D-G
-- settles it: drop with history, never silently re-apply. Restoring them when
-- the user switches back is what makes that safe — nothing is ever lost, it
-- just belongs to the version it was made against.
--
-- `user_id` is part of the key because both live tables are per-user
-- (`transcript_edits` / `speaker_mappings` are UNIQUE (user_id,
-- assemblyai_id) and collaborators write into the OWNER's row — see
-- db-ops/transcript-shares.ts). Every user's annotations are parked, and
-- every user's are restored.
--
-- PRIVACY: this table is reachable only through the MEETING it names
-- (`transcript_id`), which every route gates on first with `resolveAccess`.
-- Counts of another user's parked annotations may be shown; their CONTENT
-- may not leave the server (feedback_privacy_caller_scoping_gate).
CREATE TABLE IF NOT EXISTS transcription_annotations (
  -- recording_transcriptions.id — the version these belong to. Not an FK:
  -- the transcription may be removed by a permanent delete of the meeting,
  -- which drops these rows in the same transaction anyway.
  transcription_id uuid        NOT NULL,
  -- transcripts.id — the int family, like meeting_clips (the DOCUMENT).
  transcript_id    int         NOT NULL,
  -- The owner key the live tables use (transcripts.user_id family).
  user_id          text        NOT NULL,
  -- transcript_edits.edits, verbatim: {"<utteranceIndex>": {text?, speaker?}}.
  edits            jsonb,
  -- The speaker_mappings row, verbatim: {"labels": [...], "suggestions": {...}}
  -- — the confirmed names AND the voiceprint/ID-pass suggestions, because
  -- both are keyed on that job's diarization labels.
  speaker_labels   jsonb,
  archived_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcription_id, transcript_id, user_id)
);
-- "What is parked for this meeting?" — the versions list asks it once per
-- meeting, and permanent delete asks it to clean up.
CREATE INDEX IF NOT EXISTS transcription_annotations_meeting_idx
  ON transcription_annotations (transcript_id);

-- Who asked for this run, when, and with what:
--   {"by": {"userId": …, "email": …, "name": …}, "at": <iso>,
--    "speechModel": "universal-3-5-pro", "languageCode": "auto" | "en",
--    "reason": "wrong language"}
--
-- Present = a human (or a future automation) deliberately started this
-- version; absent = the transcription the meeting was born with. That
-- distinction is load-bearing beyond the UI: `applyRecordingGraph` refuses to
-- delete a transcription that carries it, so a re-run in flight can never be
-- swept away by the dual-write re-deriving the meeting's graph.
ALTER TABLE recording_transcriptions ADD COLUMN IF NOT EXISTS requested jsonb;

-- Why a run failed, in the words the Sources card shows ("AssemblyAI no
-- longer has this job", "Stuck at AssemblyAI for over 6 hours — gave up").
-- 044 has nowhere to put this: the meeting's own failures live in
-- `gmeet_context.ingestFailure`, but a failed RE-RUN must leave the meeting
-- completely untouched — that is the whole promise of Phase 2 — so its reason
-- belongs to the transcription.
ALTER TABLE recording_transcriptions ADD COLUMN IF NOT EXISTS error text;

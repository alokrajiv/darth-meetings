-- First-class recordings, Phase 1 (docs/recordings-phase1-spec.md §1, on top
-- of docs/recordings-first-class-design.md §7 — Alok's decisions).
--
-- Vocabulary, fixed: a MEETING is the document (a `transcripts` row); a
-- RECORDING is one capture = its bytes + ONE transcription with ONE
-- diarization space; a PART is a file inside a recording (Meet stop/restart
-- videos, tray screen-share flips) and never reaches the user or AssemblyAI
-- on its own; a CLIP is a `[from_ms, to_ms]` window of a recording used by a
-- meeting — a pointer, nothing is cut and nothing is re-transcribed.
--
-- Additive only. Nothing reads these tables until MW_RECORDINGS is on:
-- `transcripts.imported_content` / `local_audio_path` stay the source of
-- truth (dual-write) through Phase 3, so this migration is safe to apply
-- ahead of the code and rolling back is "leave them empty".
--
-- PRIVACY: there is no ACL table here on purpose. A recording is reachable
-- (a) through a meeting the caller can access — `meeting_clips` joined to
-- `transcripts` + `transcript_shares`, the existing caller-scoped predicate —
-- or (b) by its owner (`recordings.owner_user_id`). Every route that serves a
-- recording must state which of the two it used
-- (feedback_privacy_caller_scoping_gate).

-- CONVENTION (spec §5a): every migration here hard-codes the PROD schema on
-- the line below. Applying this to any other schema — the stage clone, a
-- local scratch cluster, the writers' integration check — means sed-ing that
-- one line first, e.g.
--   sed 's/meeting_whisperer_prod/meeting_whisperer_stage/' 044_recordings.sql | psql …
-- The convention stays as it is: a migration that picked its schema from the
-- environment would be one typo away from creating prod tables somewhere else.
SET search_path = meeting_whisperer_prod, public;

-- One capture. `owner_user_id` is the darth user id family used by
-- transcripts.user_id (text, not uuid — there is no users table). A recording
-- may outlive every meeting that points at it, and (landmine #14: two users
-- importing the same Meet call share one AssemblyAI id) may be referenced by
-- meetings belonging to two different owners — the earlier `created_at` wins
-- the ownership.
CREATE TABLE IF NOT EXISTS recordings (
  id                      uuid PRIMARY KEY,
  owner_user_id           text NOT NULL,
  -- recorder | upload | meet | teams | text | aai-import
  source_kind             text NOT NULL,
  -- Wall clock of ms 0 on the recording's own timeline, when it is known
  -- (Meet's first recording startTime / the tray's started_at). NULL = the
  -- recording timeline is not anchored to a clock.
  started_at              timestamptz,
  duration_ms             bigint,
  -- sha256 of the canonical media (the exact bytes AssemblyAI heard). Lazy:
  -- the backfill leaves it NULL and a sweeper fills it in; Phase 2's
  -- "already transcribed — open / link / transcribe anyway" prompt is what
  -- needs it.
  sha256                  text,
  -- recorder_recordings.id (migration 041) when the bytes came from the
  -- macOS tray. `recorder_recordings.transcript_id` is today's reverse link
  -- and points at a MEETING; this column is the one that means "these bytes".
  recorder_recording_id   uuid,
  -- Which transcription a clip reads when it names none. Not an FK: the
  -- transcription references the recording, so an FK both ways would make
  -- inserting either row first impossible without a deferred constraint.
  active_transcription_id uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
CREATE INDEX IF NOT EXISTS recordings_owner_started_idx
  ON recordings (owner_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS recordings_recorder_idx
  ON recordings (recorder_recording_id)
  WHERE recorder_recording_id IS NOT NULL;
-- Owner-scoped byte dedupe. NON-UNIQUE in Phase 1 on purpose: prod already
-- holds 18 groups of the same file transcribed 2–4× and a unique index would
-- refuse the backfill. Uniqueness arrives with Phase 2, after the dedupe
-- prompt exists to prevent new duplicates (spec §1).
CREATE INDEX IF NOT EXISTS recordings_owner_sha256_idx
  ON recordings (owner_user_id, sha256)
  WHERE sha256 IS NOT NULL AND deleted_at IS NULL;

-- Every file that belongs to a recording. `kind` says what it is:
--   canonical   the one file that was transcribed / is played by default
--               (today's transcripts.local_audio_path)
--   part        a source file in capture order (Meet videoParts today, the
--               tray's rolled files once we keep them). Part NUMBER as the
--               player and /audio?part=N know it = canonical is 1, then the
--               kind='part' rows in `ord` order are 2, 3, … — the ORDER is
--               what matters, not the absolute `ord`.
--   audio_only  the 64 kbps mono extract of `of_media_id`
--   faststart   the remuxed mp4 of `of_media_id`
-- The last two are rebuildable derivatives and may be deleted at will.
CREATE TABLE IF NOT EXISTS recording_media (
  id            uuid PRIMARY KEY,
  recording_id  uuid NOT NULL REFERENCES recordings(id),
  kind          text NOT NULL,
  ord           smallint NOT NULL DEFAULT 0,
  -- Where this file starts on the RECORDING's timeline. For Meet parts it is
  -- the wall-clock delta from the primary video (what the detail page
  -- computes today); for a stitched upload's sources it is uploadedParts
  -- offsetSec. NULL = unknown.
  offset_ms     bigint,
  duration_ms   bigint,
  -- Basename under ${MW_STORAGE_DIR}/audio (never an absolute path, never a
  -- slash — see lib/server/audio-storage.ts). NULL = not on the VM: either
  -- never fetched, or (uploadedParts/combinedParts) the source file was a
  -- temp that the stitch consumed. From Phase 4 on this is only a cache hint
  -- and `blob_name` is the permanent home (DEC-3).
  filename      text,
  blob_name     text,
  bytes         bigint,
  has_video     boolean,
  sha256        text,
  -- {driveFileId} | {teamsRecordingId} | {originalFilename, comment} —
  -- where the bytes came from, in the provider's own terms.
  source_ref    jsonb,
  -- For a derivative: the media row it was built from.
  of_media_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recording_media_recording_idx
  ON recording_media (recording_id, kind, ord);

-- One transcription run over one recording. DEC-1: one recording = one
-- AssemblyAI job, always (parts are concatenated first) — so there is never
-- more than one diarization space per recording. Several rows over time =
-- re-transcribes (Phase 2); `superseded_by` chains them and
-- `recordings.active_transcription_id` says which one is live.
CREATE TABLE IF NOT EXISTS recording_transcriptions (
  id                  uuid PRIMARY KEY,
  recording_id        uuid NOT NULL REFERENCES recordings(id),
  -- assemblyai | meet-doc | teams-vtt | text
  provider            text NOT NULL,
  -- The provider's own job id. Disposable by DEC-4 (AssemblyAI keeps nothing
  -- of ours; we delete the job once the payload is stored), which is exactly
  -- why it lives here and not in an id column anyone keys on.
  provider_job_id     text,
  -- Stamped when we deleted the job at the provider (DEC-4).
  provider_deleted_at timestamptz,
  speech_model        text,
  language_code       text,
  -- processing | completed | error
  status              text NOT NULL,
  -- Today's transcripts.imported_content, verbatim (TranscriptResponse).
  payload             jsonb,
  -- What the job actually heard: {"media": [<recording_media.id>, …],
  -- "timeline": "wall" | "concat"}. 'concat' = inter-part gaps were removed
  -- before the job ran, so payload ms are concat time, not wall time. A media
  -- id absent from `media` is the "this video was not transcribed" case that
  -- the amber warning shows today.
  covers              jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  superseded_by       uuid
);
CREATE INDEX IF NOT EXISTS recording_transcriptions_recording_idx
  ON recording_transcriptions (recording_id, created_at DESC);
-- The double-send guard: one AssemblyAI job is stored once, however many
-- meetings point at it.
CREATE UNIQUE INDEX IF NOT EXISTS recording_transcriptions_job_idx
  ON recording_transcriptions (provider_job_id)
  WHERE provider_job_id IS NOT NULL;

-- A meeting's ordered list of clips. A clip is a pointer: it selects
-- [from_ms, to_ms) of the recording's timeline and lands it at offset_ms on
-- the meeting's timeline. transcript_id is the int family (transcripts.id)
-- because clips follow the DOCUMENT, like shares/labels/activity do — not
-- the AssemblyAI id, which follows the job.
CREATE TABLE IF NOT EXISTS meeting_clips (
  transcript_id    int      NOT NULL,
  ord              smallint NOT NULL DEFAULT 0,
  recording_id     uuid     NOT NULL REFERENCES recordings(id),
  -- NULL = read the recording's active transcription.
  transcription_id uuid,
  from_ms          bigint   NOT NULL DEFAULT 0,
  -- NULL = to the end of the recording.
  to_ms            bigint,
  offset_ms        bigint   NOT NULL DEFAULT 0,
  -- include  | both texts, sorted by time (two mics of one room)
  -- gap_fill | only where no 'include' clip has speech within ±1.5 s
  -- exclude  | playable/alternate audio, contributes no text
  text_policy      text     NOT NULL DEFAULT 'include',
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, ord)
);
-- "Which live meetings still reference this recording?" — the question
-- permanent delete asks before removing any bytes.
CREATE INDEX IF NOT EXISTS meeting_clips_recording_idx
  ON meeting_clips (recording_id);

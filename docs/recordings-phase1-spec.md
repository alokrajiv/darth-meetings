# First-class recordings — Phase 1 build spec

Status: **build brief**, written 2026-09-21 (SGT evening) against main `3cfe1ad` + the Step 0 change set
(DEC-4). Read `docs/recordings-first-class-design.md` first: §1 (today's model, with file/line refs), §4
(landmines) and **§7 (Alok's decisions — they win over §2–§5)**. This spec replaces §2.1–§2.3 and §3 Phase 1.

Vocabulary (§7): **Meeting** = the document (`transcripts` row). **Recording** = one capture, one transcription,
one speaker space. **Part** = a file inside a recording. **Clip** = a window of a recording used by a meeting.
The word "segment" is not used for any of these.

## 0. What Phase 1 is and is not

Is: new tables, a 1:1 backfill, ONE resolver that every reader goes through, dual-write from every writer.
Behind `MW_RECORDINGS` (unset/`0` = today's code path, byte for byte).
Is not: any visible change, any new id scheme, blob-permanent storage, re-transcribe-as-new-transcription,
clips with a real window. Those are Phases 1b, 2, 3, 4 below and each builds on these tables unchanged.

Acceptance is a diff: for every live row, the responses of the listed endpoints with the flag on are
byte-identical to the flag off (§5).

## 1. Tables — migration `044_recordings.sql`

Additive only. Same header/`SET search_path` convention as 041–043; every FK-ish column indexed.

```sql
CREATE TABLE recordings (
  id                     uuid PRIMARY KEY,
  owner_user_id          text NOT NULL,                 -- same id family as transcripts.user_id
  source_kind            text NOT NULL,                 -- recorder | upload | meet | teams | text | aai-import
  started_at             timestamptz,                   -- wall clock of ms 0 when known
  duration_ms            bigint,
  sha256                 text,                          -- of the canonical media (the file AAI heard); lazy
  recorder_recording_id  uuid,                          -- recorder_recordings.id
  active_transcription_id uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz
);

-- Every file that belongs to a recording. kind says what it is:
--   canonical  the one file that was transcribed / is played by default (today's local_audio_path)
--   part       a source file in capture order (Meet videoParts today; tray parts once we keep them)
--   audio_only / faststart   rebuildable derivatives of `of_media_id`
CREATE TABLE recording_media (
  id            uuid PRIMARY KEY,
  recording_id  uuid NOT NULL REFERENCES recordings(id),
  kind          text NOT NULL,
  ord           smallint NOT NULL DEFAULT 0,            -- capture order among kind='part'
  offset_ms     bigint,                                 -- where this file starts on the RECORDING timeline
  duration_ms   bigint,
  filename      text,                                   -- basename under storage/ (cache; NULL = not on the VM)
  blob_name     text,                                   -- permanent home (Phase 4 of this spec; NULL for now)
  bytes         bigint,
  has_video     boolean,
  sha256        text,
  source_ref    jsonb,                                  -- {driveFileId} | {teamsRecordingId} | {originalFilename, comment}
  of_media_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recording_transcriptions (
  id                  uuid PRIMARY KEY,
  recording_id        uuid NOT NULL REFERENCES recordings(id),
  provider            text NOT NULL,                    -- assemblyai | meet-doc | teams-vtt | text
  provider_job_id     text,                             -- disposable; UNIQUE when not null
  provider_deleted_at timestamptz,                      -- DEC-4 stamp (mirrors gmeet_context.aai)
  speech_model        text,
  language_code       text,
  status              text NOT NULL,                    -- processing | completed | error
  payload             jsonb,                            -- today's imported_content, verbatim
  covers              jsonb,                            -- which media ids the job heard + timeline: 'wall' | 'concat'
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  superseded_by       uuid
);

CREATE TABLE meeting_clips (
  transcript_id    int  NOT NULL,                       -- transcripts.id (the int family follows the document)
  ord              smallint NOT NULL DEFAULT 0,
  recording_id     uuid NOT NULL REFERENCES recordings(id),
  transcription_id uuid,                                -- NULL = the recording's active one
  from_ms          bigint NOT NULL DEFAULT 0,
  to_ms            bigint,                              -- NULL = to the end
  offset_ms        bigint NOT NULL DEFAULT 0,           -- where from_ms lands on the meeting timeline
  text_policy      text NOT NULL DEFAULT 'include',     -- include | gap_fill | exclude
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, ord)
);
```

Indexes: `recordings(owner_user_id, started_at DESC)`, `recordings(recorder_recording_id)`, partial unique
`recordings(owner_user_id, sha256) WHERE sha256 IS NOT NULL AND deleted_at IS NULL` — **create it NON-unique in
Phase 1** (18 known duplicate groups; uniqueness arrives with Phase 2's dedupe prompt), `recording_media(recording_id, kind, ord)`,
unique `recording_transcriptions(provider_job_id) WHERE provider_job_id IS NOT NULL`, `recording_transcriptions(recording_id)`,
`meeting_clips(recording_id)`.

Decisions baked in:
- **Meet stop/restart videos are parts of ONE recording** (same room, same people — DEC-1), each with its own
  `offset_ms` (wall-clock delta from part 1). "Later videos are not transcribed" stops being a special case: it is
  `transcription.covers` not listing those media ids. Phase 2's "combine & re-transcribe" is then a new
  transcription on the same recording — no new meeting row. That is D1 closed by construction.
- **A recording is reachable through a meeting you can access, or by its owner.** No separate ACL table. Every
  new route that serves a recording must state which of the two it used (privacy gate: caller-scoped always).
- **Two users holding the same AAI id** (landmine #14) → ONE recording, ONE transcription, two `meeting_clips`
  rows. Owner = the earlier `created_at`. This is the first shared recording and gets its own test.
- `transcripts.imported_content` and `local_audio_path` stay populated (dual-write) through Phase 3. ~0.5 GB of
  duplicated jsonb in Postgres is accepted.

## 2. Backfill — `scripts/recordings-backfill.ts`

Idempotent, resumable, dry-run by default, `--apply`, `--only <assemblyai_id>`. One transaction per meeting row.
Deterministic ids so a re-run converges: `recording.id = uuidv5(ns, 'rec:' + canonicalKey)` where canonicalKey is
the AAI id for real-AAI rows (so two-owner copies collapse), else the row's `assemblyai_id` + user id.

Per `transcripts` row (including trashed; excluding `up-`/`defer-` placeholders with no payload and no media):
1. recording: `source_kind` from `gmeet_context.recorder` → `recorder`; id prefix `gmeet-`/`teams-`/`ext-` →
   `meet`/`teams`/`text`; real AAI id + no media + no context → `aai-import`; else `upload`.
   `started_at` from `actuals.anchorIso` when present; `recorder_recording_id` from the marker or the reverse
   link `recorder_recordings.transcript_id`.
2. media: `canonical` from `local_audio_path` (bytes/has_video via stat + the existing probe helpers, `filename`
   only — never an absolute path); one `part` per `videoParts[]` entry (`offset_ms` = the wall-clock delta the
   detail page computes today at `page.tsx:899-935` — lift that arithmetic into a shared pure function and use it
   in both places); `uploadedParts[]` / `combinedParts[]` become `part` rows with `filename NULL` and `source_ref`
   (the source files no longer exist; their offsets do); existing `audio-only/<stem>.m4a` → `audio_only`.
3. transcription: `payload = imported_content` (same jsonb, no re-serialisation through JS — do it in SQL:
   `INSERT … SELECT imported_content`), `provider_job_id` only for real AAI ids, `status` from the row,
   `covers.timeline = 'concat'` when `combinedParts`/`uploadedParts` exist, else `'wall'`.
4. clip: `(ord 0, from 0, to NULL, offset 0, include)`.

Report at the end: counts per source_kind, rows skipped and why, shared recordings found, rows whose
`local_audio_path` file is missing on disk (run the file checks on the VM, read-only).

## 3. The resolver — `src/lib/server/recordings.ts` (server-only)

```ts
resolveMeetingContent(row: StoredTranscript): Promise<{
  content: TranscriptResponse | null;      // what /content serves
  media: ResolvedMedia[];                  // what the player, /audio, offline plan, frames, voiceprints use
  compat: boolean;
  recordingIds: string[];
  rev: string;                             // stable hash of clips + active transcription ids + media ids
}>
```
- **Compat mode** = exactly one clip with defaults, whose transcription covers the canonical media. Return
  `payload` **verbatim** — no map, no re-tag, no re-join, plain speaker labels, plain `"<index>"` edit keys.
  All 667 rows are compat after the backfill; the non-compat branch is written and unit-tested now (windowing by
  `from_ms/to_ms`, `offset_ms` shift, `<recordingId>:<label>` speakers, `text_policy`), but no prod row reaches it.
- `media[]`: `{ part: number, mediaId, recordingId, filename, isVideo, offsetMs, durationMs, transcribed }`,
  `part` numbering identical to today's `?part=N` (canonical = 1, videoParts = index + 2).
- With `MW_RECORDINGS` off, or when a row has no clip yet (a writer that has not been converted), the resolver
  falls back to the row's own columns and logs `[recordings] fallback <id>` once per id per process.
- One loader with a per-request cache; no N+1 on the listing (the listing needs only `recording_count` →
  one aggregate join, caller-scoped exactly like the existing CTE, inside the MATERIALIZED fence).

Readers to move onto it (each keeps its current response shape): `content/route.ts`, `audio/route.ts`,
`frames` route + `video-frames.ts`, `edits` + `speakers` routes (keys unchanged in compat), `offline-plan.ts`
(the plan `rev` must NOT change in compat mode — feed it the same inputs as today; a changed rev would re-download
every pin on every device), `offline-urls.ts`, `auto-notes.ts` (`getContentCached`, `buildTranscriptText`),
`voiceprint.ts`, `meet-align.ts`, `post-completion.ts`, permanent delete in `[id]/route.ts`.

Writers to dual-write (row first, then recording/media/transcription/clip in the same transaction where the
code already has one): `ingest.ts` (upload → promote), `upload-pipeline.ts` (stitched groups — one recording,
canonical = the concat, `part` rows from `uploadedParts`), `gmeet-import-core.ts`, `recording-fetch.ts` +
`recording-poller.ts` (videoParts → `part` media), `transcript-sync.ts` (status/payload on the transcription),
Teams import, text import, `transferOwnership` (move `recordings.owner_user_id` too), soft delete / restore /
permanent delete (a recording's files are removed only when no other live meeting has a clip on it).

## 4. What stays for later (so nobody builds it early)

- **1b — ids we mint.** New meetings stop taking the AAI id as their document id; `up-<uuid>` promotes to
  `mt-<uuid>` (same uuid → `former_ids` self-heal already covers old links), media files are named after the
  recording id, the poller polls `provider_job_id`. Needs an audit of every "no known prefix ⇒ real AAI job"
  test (`grep -nE "gmeet-|teams-|ext-|up-|defer-"`). Separate change, separate flag.
- **2 — a new transcription on the same recording** (re-transcribe, combine, language override), sha256 dedupe
  prompt, recorder uploads landing as bare recordings (D-B).
- **3 — clips with a real window**, `darth-cli meetings recordings|clips`, AI-proposed windows.
- **4 — blob-permanent** (`blob_name`), AAI reads a SAS URL, playback by redirect to a short-lived SAS, VM as cache.

## 5. Verification — the gate

1. **Never develop against the prod schema.** `SCHEMA_PREFIX` selects the schema; build and test on a
   non-prod schema on the VM's Postgres cloned from prod (`meeting_whisperer_stage`: tables + data for
   `transcripts`, `transcript_edits`, `speaker_mappings`, `recorder_recordings`, `meetings`, and whatever the
   touched routes join). Creating that schema is a write on the prod DB *server* — ask before doing it; if it is
   refused, fall back to a local Postgres restore of those tables.
2. `tmp/recordings-diff/run.ts`: for every non-placeholder row, call the handlers (or a local server) twice —
   flag off, flag on — for `/api/transcripts/<id>`, `/content`, `/edits`, `/speakers`, `/audio` (HEAD + a Range
   probe, every `?part=N`), the offline plan, and the v2 + legacy listings; write one line per mismatch.
   Gate = zero mismatches, including the offline `rev`.
3. Unit tests over real payload shapes for the non-compat branch (two recordings, overlapping clips, each
   `text_policy`, speaker prefixing, index renumbering).
4. `bun test`, `bunx tsc --noEmit`, `bunx eslint` clean. `bun run build` with no env.

## 6. Rollout

Migration 044 (Alok applies) → deploy with the flag off (dual-write starts) → backfill `--apply` (Alok) →
diff script against prod read-only → flag on → a week with offline pins and darth-cli as the canaries → Phase 1b/2.
Rollback at any point = flag off; the tables are additive.

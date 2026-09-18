# Recordings as first-class objects — design brainstorm

Status: **brainstorm input for Alok, nothing built.** Written 2026-09-18 (SGT evening) against main `78f9453`.
Every claim below is grounded in the code at that commit or in a read-only query of `meeting_whisperer_prod`
run 2026-09-18 ~23:20 SGT. Decisions are marked as Alok's (§5); the rest is a proposal.

## 0. The ask and the evidence

Alok (2026-09-18): *"an audio or video recording and its AssemblyAI result should be a first-class object, so we
can use a segment of it inside a transcript — sometimes one recording sits across two different events, and the
reverse: one event can have 3 or 4 recordings, with or without overlap."*

What prod looks like today (667 transcript rows, 666 identities, 480 real AAI jobs, 142 `gmeet-`, 21 `teams-`,
14 `ext-`, 10 placeholders; 488 rows with local media; 507 MB of `imported_content`):

| Symptom | Evidence |
|---|---|
| One recording, two events → audio re-sent to AAI | Rows 830 (`kerner-coco-…m4a`, 4182 s, 2026-09-17 01:55 UTC) then 846 + 847 (`part1-msft-kerner.m4a` 3028 s, `part2-gabe-1on1.m4a` 2439 s, 10:00 UTC): the same podcast was cut into two files and transcribed again — 9,649 s billed for 4,182 s of audio. This is the "sent twice" of chat 5c0f93b6 (the chat itself diarised locally with sherpa-onnx; the AAI sends happened afterwards through the meetings upload). |
| Same file uploaded 2–4× | 18 (filename, owner) groups with >1 live AAI row: `TFCN.m4a` ×4, `TFCN 2.m4a` ×4, `BBT.m4a` ×4, `Bega.m4a` ×3, `New Recording.m4a` ×3 … Nothing dedupes on bytes; `upload_sessions.fingerprint` only dedupes an *open* session (migration 037). |
| Several recordings, one event | 4 rows with `videoParts`, 9 stitched (`uploadedParts`), 4 combined (`combinedParts`), 2 `combined-2-videos.mp4` siblings for the same occurrence (df4a0457 / 031e13b6 — the resume-sweep duplicate). |
| Re-transcribe = new row | 1 `retranscribed` pair (ad12e3d1 → a1c1f5a3). Tech-debt D1 (superseded-row lifecycle) is exactly this. |
| Manual multi-source merge | SI-BL row 548 built by hand (cross-correlation offsets in `tmp/sibl-merge/analyze.py`). |

## 1. Today's model, precisely

**One `transcripts` row = one media file = one AssemblyAI job = one meeting document.** There is no separate
recording identity anywhere. The row carries two keys that everything else hangs off:

| Key | Type | Who keys on it |
|---|---|---|
| `transcripts.assemblyai_id` | text (AAI uuid, or synthetic `gmeet-…` / `teams-…` / `ext-…` / `up-…` / `defer-…`) | URLs (`/transcript/<id>`, every `/api/transcripts/<id>/*`), `transcript_edits` + `speaker_mappings` `UNIQUE (user_id, assemblyai_id)`, `meetings.transcript_id` + `former_ids` (031), `recorder_recordings.transcript_id` (041:62), `ai_runs.assemblyai_id`, on-disk media names, frame cache dir, SSE events, DM dedupe keys, the offline plan |
| `transcripts.id` | int | `transcript_shares`, `transcript_activity`, `transcript_attachments`, `transcript_labels`, `series_members` (UNIQUE), `series_exclusions`, share DM dedupe (`shares/route.ts:146`) |

### 1.1 Columns that *are* the recording / the AAI job

`src/lib/format.ts:19-83` (`StoredTranscript`) — `assemblyai_id`, `original_filename`, `status`, `duration`,
`speaker_count`, `language_code`, `speech_model` (038), `imported_content` = the frozen AAI payload
(`TranscriptResponse`, format.ts:691-717: `text`, `utterances[]`, `words[]`), `audio_url`, `local_audio_path`,
`drive_file_id` (007). The row is written by `createForUser` (`src/db-ops/transcripts.ts:703-735`,
`ON CONFLICT (user_id, assemblyai_id)` at :720) and promoted in place from `up-<uuid>` by `promoteUploadingRow`
(:992). Content is cached once and never refreshed: `content/route.ts:25-37`,
`setCachedContentForUser` (transcripts.ts:1195-1205), `getContentCached` (`src/lib/server/auto-notes.ts:360-372`)
— "AAI content is immutable" is assumed everywhere.

### 1.2 Media on disk, named after the AAI id

- Primary: `audioFilename(assemblyaiId, original)` → `<aai-id>.<ext>` (`src/lib/server/audio-storage.ts:37-52`),
  renamed into place at `src/lib/server/ingest.ts:289-298`; Drive/Teams pulls do the same
  (`recording-fetch.ts:182-190`, :152-155).
- Extra Meet segments: `<aai-id>.part<N>.<ext>` (`recording-fetch.ts:120`), N = array index + 2, append-only
  (`setVideoPartStoredForUser`, transcripts.ts:1414-1441); served by `audio/route.ts:54-71` (`?part=N`).
- Derivatives: audio-only `audio-only/<stem>.m4a` keyed by the stored basename (`audio-only.ts:49-53`, stale-by-mtime
  :79-88); frames `frames/<aai-id>/<ms>.jpg` (`video-frames.ts:86-95`).
- Multi-track recorder files are re-muxed in place at ingest so the mix is track 0 (`multitrack.ts:12-40`).
- Permanent delete removes primary + parts + derivatives by walking the row (`[id]/route.ts:156-167`).

### 1.3 The three timelines nobody names

1. **Job time** — AAI `utterances[].start` = ms from the start of the file AAI received.
2. **Meeting time** — `actuals.anchorIso` (format.ts:141); the detail page assumes job time == meeting time for the
   primary and derives part offsets from wall-clock (`page.tsx:899-935`, `seekMeetingTime` :954-973).
3. **Concat time** — combined rows: gaps removed, sidecar remapped (`gmeet-import-core.ts:193-240`), `actuals`
   left in wall-clock, `uploadedParts.offsetSec` for stitched uploads (`upload-pipeline.ts:445-458`).

`t:<ms>` chips, `auto_segments.start_ms`, `frame:<ms>` and voiceprint snippets are all written in whichever of
the three the row happens to be in.

### 1.4 Everything keyed by utterance INDEX or by ms

| Thing | Where | Key |
|---|---|---|
| Utterance text/speaker overrides | `transcript_edits.edits` = `{ "<index>": {text?, speaker?} }` — `src/db-ops/transcript-edits.ts:10-12`, `:78` (`String(utteranceIndex)`); PATCH body `utteranceIndex` (`edits/route.ts:113-147`); client `displayTextFor` (`page.tsx:472-479`), `handleSaveText` (:1345-1385), `data-utterance-index` (`editable-utterance.tsx:173`); find-and-replace PUTs the whole map (edits route :84) | array index into `imported_content.utterances` |
| Speaker names | `speaker_mappings.speaker_labels[].originalSpeaker` = AAI letter label of *that job* (format.ts:605-609); suggestions from voiceprints/Meet-align/speaker-ID pass keyed the same way | per-job label namespace |
| AI section headings | `auto_segments[].start_ms` mapped to the first utterance at/after it (`page.tsx:423-437`) | ms |
| Citations | `[m:ss](t:<ms>)`, `![…](frame:<ms>)`, `[…](attachment:<int id>)` (prompt rules `auto-notes.ts:79,93-95`; renderer `notes-markdown.tsx:37-43,73`; frame rewrite `auto-notes.ts:434-437`) | ms / int attachment id |
| Prompt transcript | `buildTranscriptText` prints `[m:ss] Speaker X: …` per utterance (`auto-notes.ts:341-357`) | ms |
| Voiceprints | `pickSegments` slices the *local file* at utterance ms (`voiceprint.ts:66-77`, :155-175) | ms on the primary file only |
| Meet ↔ AAI alignment | overlap voting in job time (`meet-align.ts:12-30`) | ms |
| Deep search | `transcripts_trgm_content_idx` on `imported_content->>'text'` (migration 012:12-13; `transcript-search.ts:54,68`) | one text blob per row |
| Offline pins | plan `rev` = md5 over row fields + `local_audio_path` + `videoParts` + newest edit/mapping (`offline-plan.ts:44-55`); URL set per id incl. `?part=N` (`offline-urls.ts:28-40, 95-101`); parts count (`offline-pins.ts:445`) | assemblyai_id + part number |
| Pollers | `transcript-sync.ts:30-46` polls AAI by `row.assemblyai_id`; recording-poller / video-fetch sweeper diff `videoParts` by `fileId` and store under the row id | assemblyai_id |
| Listing `recording_count` | `GREATEST(1+videoParts, uploadedParts, combinedParts)` (`transcripts.ts:386-392`, v2 only — legacy listing at :111 is byte-compat for darth-cli, `route.ts:193-196`) | jsonb |

### 1.5 The five workarounds for "more than one recording"

| Flow | Mechanism | Result |
|---|---|---|
| Meet stop/restart | `videoParts` sidecars (format.ts:203-210), `recording-poller.ts:199-246` diff-attach | playable, **not transcribed** (amber warning) |
| Combine & re-transcribe | `gmeet-import-core.ts:405-436` + `concatMediaToTemp` (:975-993) with `sourceTranscriptId` | **new row**, `combinedParts`, new /m uuid; old row stays (D1) |
| Stitched upload | `upload-pipeline.ts:433-490`, `concatMediaSmart` (`media-concat.ts:190-214`), `uploadedParts` | one row, offsets only in jsonb + prompts |
| Re-transcribe (newer model / `?source_id=`) | `retranscribe/route.ts:76-110` opens a fresh upload with `sourceId` + `retranscribedFrom`; old row gets `retranscribed.newId` | **new row**, shares carried by re-linking the event, edits/mappings NOT carried |
| Resume sweep | adopts sibling conferenceRecords as parts, `pendingRecombine` auto-fires the combine (`recording-poller.ts:433-…`) | yet another row |

## 2. Target model

Principle: **`transcripts` stays the meeting *document*** (title, notes, report, shares, labels, activity, series,
/m link, Temporary flag). **`recordings` becomes the *media + result* object.** A document is an ordered list of
segments over recordings. `assemblyai_id` stays as the document's opaque public id (renaming it is a separate,
later cleanup) — it simply stops meaning "the AAI job".

### 2.1 Tables (sketch)

```sql
recordings (
  id             uuid PRIMARY KEY,
  owner_user_id  uuid NOT NULL,
  source_kind    text NOT NULL,          -- upload | meet | teams | recorder | concat | text
  started_at     timestamptz,            -- wall clock of byte 0 when known (Meet recording start, tray started_at, phone creation_time - duration)
  duration_ms    int,
  sha256         text,                   -- whole-file hash (043 already computes it for blob sessions)
  fingerprint    text,                   -- upload_sessions.fingerprint (name|size|mtime) for the cheap pre-hash check
  recorder_recording_id uuid,            -- FK-ish to recorder_recordings.id
  drive_file_id  text, teams_recording_id text,
  concat_of      jsonb,                  -- source_kind=concat: [{recording_id, from_ms, to_ms}] in order
  created_at, updated_at, deleted_at
);
recording_media (                         -- files on disk; today's primary + parts + derivatives
  recording_id uuid, role text,           -- original | mix | audio_only | faststart
  filename text, bytes bigint, has_video bool, faststart bool, audio_tracks int, created_at
);
recording_results (                       -- one AAI (or parsed) result per run; several per recording over time
  id uuid PRIMARY KEY, recording_id uuid, provider text,   -- assemblyai | meet-doc | teams-vtt | text
  provider_job_id text,                   -- the real AAI id; UNIQUE → the double-send guard
  speech_model text, language_code text, status text,
  payload jsonb,                          -- today's imported_content, verbatim
  speaker_id jsonb,                       -- voiceprint suggestions for THIS result's labels (today speaker_mappings.suggestions)
  created_at, completed_at, superseded_by uuid
);
transcript_segments (
  transcript_id int NOT NULL,             -- transcripts.id
  recording_id  uuid NOT NULL,
  result_id     uuid,                     -- which result's utterances this segment reads (NULL = recording's active result)
  ord           smallint NOT NULL,
  from_ms       int NOT NULL DEFAULT 0,   -- window inside the recording
  to_ms         int,                      -- NULL = end
  offset_ms     int NOT NULL DEFAULT 0,   -- where from_ms lands on the DOCUMENT timeline
  text_policy   text NOT NULL DEFAULT 'include',  -- include | gap_fill | exclude (overlap handling, §2.4)
  PRIMARY KEY (transcript_id, ord)
);
```

`recordings.active_result_id` (or "newest completed") decides what a segment with `result_id NULL` reads.

### 2.2 Stable utterance ids

`<recording_id>:<index>` where `<index>` is the position in the *active result's* `utterances[]`. Re-transcribing
creates a new result → a new index space; edits keyed to the old result are kept (history) and offered for
best-effort carry by time overlap, never silently reapplied (text differs anyway). Speaker keys become
`<recording_id>:<label>` so "A" in recording 1 and "A" in recording 2 never collide.

`transcript_edits` / `speaker_mappings` get a `recording_id` + `result_id` column; the (user_id, assemblyai_id)
uniqueness becomes (user_id, transcript_id, result_id).

### 2.3 The segment resolver (byte-identical for the 1:1 case)

One server function, `resolveTranscriptContent(transcriptId, viewer)` in a new `src/lib/server/segments.ts`,
replacing every direct read of `row.imported_content` / `row.local_audio_path` / `gmeet_context.videoParts`:

- Input: segments (ordered), each recording's active result, media inventory.
- Output: `{ content: TranscriptResponse, media: [{part, recording_id, filename, isVideo, offsetMs, fromMs, toMs}], utteranceIds: string[] }`.
- Per segment: take `payload.utterances` with `from_ms <= start < to_ms`, shift by `offset_ms - from_ms`, re-tag
  `speaker` with the recording prefix, concatenate in `ord`, then sort by start only when segments overlap.
  `words[]` the same way; `text` = join of utterance texts (today's AAI `text` is the raw join — see below).
- **Compat mode** (exactly one segment, `from_ms=0`, `to_ms NULL`, `offset_ms=0`, `text_policy=include`): return
  `payload` **verbatim** (no map, no re-tag, no re-join), speaker keys unprefixed, edit-map keys as plain `"<index>"`.
  This is the byte-identical guarantee for `/content`, `/edits`, `/speakers`, darth-cli and the offline caches.
- Player: `media` replaces `videoParts`; `/audio?part=N` keeps working (N = segment ord + 1) and gains
  `/api/recordings/<id>/media`. `seekMeetingTime` reads `offset_ms` instead of wall-clock arithmetic.

Verification: dump `/content`, `/edits`, `/speakers`, `/audio` headers and the rendered detail-page text/notes for every
completed row before and after Phase 1; diff must be empty (script under `tmp/`, not committed).

### 2.4 Overlap between two recordings of one event

Two segments whose document windows intersect (e.g. Teams video 0–4h55 with dead audio 1h52–3h39, plus a phone
clip covering 1h50–3h45). Representation is just two segments with overlapping `[offset_ms, offset_ms+len]`;
`text_policy` says what the merged transcript shows:

- `include` — both texts, sorted by time (two mics of the same room: noisy, sometimes wanted).
- `gap_fill` — this segment's utterances only where no `include` segment has speech within ±1.5 s (the SI-BL
  case: phone fills the dead-audio hole).
- `exclude` — playable/alternate audio, contributes no text.

The player offers every segment as a "part"; the transcript body is one merged list. AI prompts get a
"Sources" block generated from the segments (replacing `buildUploadedPartsContext`).

### 2.5 Offset guesser as a normal server op

`POST /api/recordings/<id>/align { against: <recording_id>, nominalOffsetMs?, searchWindowMs? }` → runs the
envelope cross-correlation from `tmp/sibl-merge/analyze.py` (100 Hz log-RMS, fftconvolve, ±120 s around the
nominal from `started_at`) as a job in the existing python sidecar (voiceprint sidecar, port 3004 — same
deployment shape) on the audio-only derivatives; returns `{ offsetMs, confidence, driftPpm }` and the UI shows a
waveform strip pair to accept/nudge. Never applied automatically. Nominal offset comes from `started_at`
(tray `started_at`, Meet `recordings[].startTime`, m4a `creation_time` − duration, filename timestamp in the
organiser's TZ — all already known to be unreliable, hence the correlation).

## 3. Migration path — strangler style

### Phase 1 — backfill 1:1, all readers through the resolver (no behaviour change)

- **Tables:** create `recordings`, `recording_media`, `recording_results`, `transcript_segments`; add
  `recording_id`/`result_id` to `transcript_edits`, `speaker_mappings` (nullable, backfilled). Backfill: every
  `transcripts` row → one recording (`source_kind` from the id prefix / `gmeet_context`, `sha256` computed lazily
  by a sweeper), media rows from `local_audio_path` + `videoParts[].filename` + existing `audio-only/` files,
  one result with `payload = imported_content`, `provider_job_id = assemblyai_id` for real AAI rows, one segment
  `(ord 0, 0, NULL, 0, include)`. `videoParts` become extra `recording_media`? No — each part is its **own
  recording** (it is a separate Meet file with its own start) with a segment `text_policy=exclude` and
  `offset_ms` from the wall-clock delta, so the player output is unchanged and the "not transcribed" warning
  falls out of "segment has no result".
- **Code:** `segments.ts` resolver; `content/route.ts`, `audio/route.ts`, `edits`, `speakers`, `frames`,
  `offline-plan.ts` (`rev` now hashes segments + media), `auto-notes.ts` `getContentCached`/`buildTranscriptText`,
  `voiceprint.ts` (segment → file map), `meet-align.ts`, `post-completion.ts`, `transcript-sync.ts` (poll by
  `provider_job_id`), `ingest.ts` (create recording + result instead of naming files after the AAI id —
  filenames become `<recording_id>.<ext>`; existing names stay), `recording-fetch.ts`, `upload-pipeline.ts`,
  `gmeet-import-core.ts`, listing `recording_count` = segment count. `transcripts.imported_content` /
  `local_audio_path` stay populated (dual-write) until Phase 4.
- **Risk:** medium — pure plumbing but wide; the compat-mode contract is the safety net. Dual-write keeps every
  poller and darth-cli working untouched.
- **Estimate:** 2.5–3 days (1 day migration + backfill + verification script, 1.5–2 days readers).
- **Rollback:** readers behind a `MW_SEGMENTS=0` env flag that returns the old code path; tables are additive, drop
  them.

### Phase 2 — re-transcribe onto the same recording (closes D1 and the double-send)

- **Tables:** none new. `recording_results.provider_job_id UNIQUE`; `recordings.sha256` UNIQUE per owner
  (partial, non-null).
- **Code:** `retranscribe/route.ts` and the `?source_id=` / `sourceTranscriptId` paths create a **result**, not a
  row: upload bytes → new result `status=processing` → on completion `active_result_id` flips, edits/mappings of the
  old result stay attached to it, speaker-ID + auto-review re-run, `speech_model` shown per result. The Sources card
  gets a result switcher ("universal · 3 Sep" / "3.5 Pro · 9 Sep"). Upload path: after `sha256` (043 already has it
  for blob sessions; chunk sessions hash on complete) look for an owner recording with the same hash → offer
  "already transcribed — open / link to another event / transcribe again anyway". Resume sweep's
  `pendingRecombine` becomes "add sibling recording as a segment + re-run" on the *same* document (no new /m).
- **Risk:** low-medium; the retranscribe UI and the resume sweep are the only callers.
- **Estimate:** 1–1.5 days.
- **Rollback:** feature flag on the new-result path; old create-a-row path remains for one release.

### Phase 3 — split and combine

- **Split:** `POST /api/transcripts/<id>/split { atMs | range, target: 'new' | 'event:<calendar event ref>' }` →
  new `transcripts` row with a segment `(recording, from_ms, to_ms, offset 0)`; the source segment shrinks to the
  remainder (or keeps full range with a "also in ↗" chip — §5 decision). Edits/labels/shares handling per §4/§5.
  UI: range handles on the player timeline + "Split here → new transcript / link to event…" in the ⋯ menu; the
  event picker is the existing link-event dialog.
- **Combine:** `POST /api/transcripts/<id>/segments { recording_id, offset_ms, text_policy }` where the
  recording comes from (a) another transcript's recording, (b) a fresh upload with `?attach_to=<id>`, (c) a Meet/
  Teams sibling. Offset from §2.5 or typed. "Add this meeting's recording" (D6) becomes this.
- **Tables:** none new; `transcript_activity` actions `split` / `segment_add` / `segment_remove`.
- **Risk:** medium — this is where index-keyed edits and ms citations must be re-based (§4); AI notes for a split
  half must be regenerated (they cite the old timeline).
- **Estimate:** 2–3 days including UI.
- **Rollback:** routes off; segments already written are still valid for the resolver.

### Phase 4 — retire `videoParts`, `uploadedParts`, `combinedParts`, `imported_content`, `local_audio_path`

- Stitched uploads become N recordings + N segments (offsets from `probeDurationSec`, no concat at all — AAI gets
  the concat only as a `concat` recording when the user wants one job; otherwise N jobs, which is what they cost
  anyway). `concatMediaToTemp` survives only for the "one AAI job over several files" option.
- Drop the jsonb fields from readers, then from writers, then from the columns; move the GIN index to a
  `transcript_text` materialised column maintained by the resolver (§4 search).
- **Estimate:** 1.5 days. **Risk:** low once Phases 1–3 have run for a couple of weeks. **Rollback:** none needed
  before the column drop; the drop is the point of no return — take a `pg_dump` of the schema first.

## 4. Landmines

1. **Two id families** (int `transcripts.id` vs text `assemblyai_id`). Shares/labels/activity/attachments/series
   are int-keyed and follow the *document*, which is what we want for split/combine. Edits/mappings/meetings/
   recorder/ai_runs/frames/SSE/DM keys are text-keyed on the AAI id and follow the *job* — every one of them needs
   the "document id ≠ job id" decision written down. `transferOwnership` (`transcript-shares.ts:128-190`) moves
   both families; it must also move `recordings.owner_user_id`.
2. **Index-keyed edits.** 9 edit maps / 48 keys in prod today — small, but a split shifts every index. The
   resolver must renumber (`new_index = old_index − first_index_in_range`) at split time and re-key on
   `<recording_id>:<index>` in Phase 1 so it never has to happen again.
3. **ms-keyed citations in notes/report** (`t:`, `frame:`, `auto_segments`). A split half whose segment starts at
   `from_ms > 0` makes every existing chip point past the end. Options: rewrite chips by `−from_ms` (regex on the
   markdown) or blank notes on the new half and mark the source half stale. Recommend: rewrite + stale banner.
4. **Search GIN on `imported_content->>'text'`** (012). With segments the document text is derived; keep a
   `transcripts.search_text` column written by the resolver (trigger-free, app-written like `labels.path_key`) and
   move the index; darth-cli `--regex` search reads the same column.
5. **"Content cached forever."** `getContentCached`, the offline `rev`, the SW cache of `/content`, and
   `transcript_activity`-based "who viewed" all assume a row's content never changes. Phase 2 breaks that on
   purpose: `rev` must include `active_result_id` + segment table hash, and `/content` must send a `Vary`/ETag so
   pinned copies refresh (`offline-pins.ts:407-417` reads `videoParts` off the row — replace with the resolver's
   media list).
6. **Pollers match on `assemblyai_id`.** `transcript-sync.ts:30` polls AAI by the row id; after Phase 2 the id to
   poll is `recording_results.provider_job_id`. Recording-poller / video-fetch sweeper diff `videoParts` by
   `fileId` — they become "recording with `drive_file_id` and no media" queries.
7. **`meetings` (031/036) is keyed by the document id string.** Fine for split (new document → `ensureMeeting`),
   but `repointMeeting` (`meetings.ts:185-267`) and `former_ids` must never be fed a *result* id. Decide in §5
   what the old /m link does on split.
8. **`recorder_recordings.transcript_id`** (041:62) points at a document today; it should point at the
   `recordings` row (`recorder_recording_id` FK) — the tray's "uploaded ✓" state is about bytes, not a document.
   `relinkRecordingTranscript` (`recorder.ts:377-386`) goes away.
9. **DM dedupe keys** embed the document id (`mw-transcript-ready:<id>:<email>` post-completion.ts:126,
   `mw-needs-review:` / `mw-report-ready:` auto-review.ts:115/175, `mw-resume:` recording-poller.ts:565,
   `mw-share:<int id>` shares/route.ts:146). A re-transcribe on the same document would be *silenced* by the
   ready-DM dedupe — add the result id to the key.
10. **darth-cli byte-compat.** Legacy listing (`transcripts.ts:111`, `route.ts:193-196`) and `GET /api/transcripts/<id>`
    stay byte-identical only in compat mode; a multi-segment document must still serve *something* on the legacy
    shape (serve the resolved content; `duration` = document span).
11. **Temporary flag on split halves** — §5.
12. **Speaker label namespace.** `speaker_mappings.originalSpeaker = "A"` per job; a combined document has two
    "A"s. Prefixing happens only outside compat mode, but every consumer that builds prompts from labels
    (`auto-notes.ts:136-150`, `identifySpeakers` :771, `maybeAutoReview`) must use the prefixed key.
13. **On-disk names.** Existing files are `<aai-id>.<ext>`; new ones `<recording_id>.<ext>`. `resolveAudioPath`
    guards are name-agnostic, but the permanent-delete walk (`[id]/route.ts:156-167`) must delete by
    `recording_media` and only when no other document references the recording.
14. **`UNIQUE (user_id, assemblyai_id)` two-owner copies** (Meet imports by two users share one AAI id: `transcript-access.ts:33-39`,
    `offline-plan.ts:60-62`). Backfill must create ONE recording per AAI id, referenced by both documents — the
    first true "shared recording", and a test case for every reader.
15. **Voiceprint snippets and frames read the primary file only.** With segments, `pickSegments` and
    `grab_frames` must map document ms → (recording, local ms) through the resolver or they will slice the wrong file.

Riskiest three: #5 (content-immutability assumptions across cache/offline/SW), #2+#3 together (index and ms
re-basing on split), #14 (backfill of shared AAI ids).

## 5. Decisions for Alok

| # | Question | Recommendation |
|---|---|---|
| D-A | Does a split keep **Temporary** on both halves? | Yes: halves inherit `scratch` from the source; linking a half to a calendar event clears it on that half only (existing `link-event` behaviour, 042). A split is not a promotion. |
| D-B | Should **Recorder uploads** land as a bare recording with **no transcript** until linked/named? | Yes, but keep it invisible in the archive: recording rows with no segment show in a "Recordings" tray (and in the calendar row via `matched.meeting_code`), transcription is triggered on link/name or after the tray's auto-match confidence ≥ threshold; never bill AAI for a recording nobody has claimed. Today's behaviour (transcribe immediately) stays as the default for *manual* uploads. |
| D-C | What happens to the **old row's /m link on split**? | Old /m keeps pointing at the source document (now the remainder, or the full one if "also in" mode). The new half mints its own /m via `ensureMeeting` with `occ_start` of its event, so a pre-import occurrence uuid (036) is adopted when the half is linked to an event — that is the link people already hold. |
| D-D | Split mode: does the source **shrink** to the remainder, or keep the full range with the new half **also** referencing it? | Shrink by default (one utterance lives in one document); offer "keep in both" as a checkbox for the rare "same segment matters to two events" case. Overlapping references are legal in the model either way. |
| D-E | **AAI results per recording or per segment** when languages differ? | Per recording (one job = one file = one language/model). A recording that genuinely switches language mid-file is split into two recordings at the byte level (ffmpeg cut, new sha256, `concat_of`-style provenance) — segments never own results. |
| D-F | **Retention**: raw recordings vs derivatives. | Keep the original bytes as the single source of truth (they are what re-transcribe needs); derivatives (audio-only, faststart remux, mixes, frames) are rebuildable and get a sweeper (A5) that drops any derivative with no live recording. A raw recording is deleted only when no live document references it and the owner trashes it explicitly — no auto-purge of originals. |
| D-G | Edits made against an old result after a re-transcribe: **auto-carry** by time overlap or **drop with history**? | Drop with history + "carry 12 of 14 edits?" prompt showing the diff; never silent. |
| D-H | Do we rename `assemblyai_id` (document id) now? | No — out of scope; it is an opaque string to every consumer already. |

## 6. Effort

| Phase | Estimate | Unattended (subagent) | Needs Alok's eyes |
|---|---|---|---|
| 1 backfill + resolver | 2.5–3 d | migration SQL + backfill script, resolver + compat mode, unit tests over real payloads, before/after diff script, reader plumbing | migration apply on the VM (auto-mode blocks it), the diff report, the two-owner AAI id cases (#14) |
| 2 re-transcribe on same recording | 1–1.5 d | result lifecycle, sha256 dedupe prompt, poller change, result switcher | product copy of the "already transcribed" prompt; whether the resume sweep may re-run AAI unattended (cost) |
| 3 split / combine | 2–3 d | routes, renumbering, chip rewrite, alignment job in the sidecar | the timeline UI, D-A/C/D, one real split (kerner) and one real combine (SI-BL) as acceptance |
| 4 retire jsonb parts | 1.5 d | everything | the column drop |
| **Total** | **7–9 d** | | |

Sequence suggestion: Phase 1 on a branch with the diff script green, deploy, sit a week (offline pins and the
darth-cli are the canaries), then Phase 2 (cheapest win: it stops paying AAI twice), then 3.

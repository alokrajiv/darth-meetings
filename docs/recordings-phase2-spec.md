# First-class recordings — Phase 2: a new transcription on the SAME meeting

Status: **build brief**, 2026-09-22. Depends on Phase 1 (`d6481a3`, tables of migration 044) and Phase 1b
(`aai_job_id`, migration 045). Decisions: `docs/recordings-first-class-design.md` §5 D-G and §7 DEC-1/2/4.

## Why

Re-transcribing today creates a second meeting row (`retranscribe/route.ts` → `openUpload` with `sourceId`): a new
/m link, a sibling in the listing, shares re-derived from the event, edits and speaker names left behind on the old
row, the old row never retired (tech-debt D1), and it can be done once only. It is also the only way to change the
language — and it forwards the detected language, so the five Indonesian-detected rows reproduce the same result.

After Phase 2 a meeting is stable and a **transcription** is a version of what was heard: re-run with another model
or language, keep every version, switch between them, lose nothing.

## Model

`recording_transcriptions` (044) already holds one row per job. Phase 2 lets a recording have several and adds the
notion of the **active** one (`recordings.active_transcription_id`). The meeting row stays the source of truth for
readers in Phase 1 terms, so "activate" means *copy that version onto the row*:

```
activate(meeting, T):
  tx:
    cur = recording.active_transcription_id
    archive   transcript_edits + speaker_mappings of this meeting (every user_id) → transcription_annotations[cur]
    restore   transcription_annotations[T] → transcript_edits + speaker_mappings   (none for a brand-new T)
    row       imported_content = T.payload, aai_job_id = T.provider_job_id, speech_model, language_code,
              duration, speaker_count, completed_at   (status stays 'completed')
    recording active_transcription_id = T ; cur.superseded_by = T (only when T is newer than cur)
    context   notesStale = { since, fromTranscriptionId: cur } when auto_notes / auto_report exist
  after: publish 'status' + 'meta' events; onTranscriptCompleted only for a brand-new T
```
One mechanism serves both "the new job finished" (create T, then activate) and "switch back to the older version".
Edits are index-keyed and speaker labels are per-job, so they can never be applied to another version — D-G: set
aside with history, never silently re-applied. Restoring them when you switch back is what makes that safe.

### Migration `046_transcription_versions.sql` (additive)

```sql
CREATE TABLE transcription_annotations (
  transcription_id uuid NOT NULL,          -- recording_transcriptions.id
  transcript_id    int  NOT NULL,          -- the meeting
  user_id          text NOT NULL,          -- the owner key the live tables use
  edits            jsonb,                  -- transcript_edits.edits, verbatim
  speaker_labels   jsonb,                  -- speaker_mappings row, verbatim (labels + suggestions)
  archived_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcription_id, transcript_id, user_id)
);
ALTER TABLE recording_transcriptions ADD COLUMN IF NOT EXISTS requested jsonb;   -- {by, at, speechModel, languageCode, reason}
```

### Recording graph

`deriveRecordingGraph` keeps describing only the ACTIVE transcription (from the row). The sync must stop treating
other transcriptions of the same recording as drift: it never deletes a transcription that is superseded, is
referenced by `transcription_annotations`, or is `processing` with a `requested` stamp; `recordings-verify` reports
them as "versions", not findings. Transcription ids: keep the existing derivation for the row's job; a re-run's id
is `uuidv5(ns, 'trn:' + provider_job_id)` — check what Phase 1 used and stay consistent so a later sync converges
on the same id.

## Flow

`POST /api/transcripts/:id/retranscribe { speechModel?, languageCode? | 'auto', reason? }` — editors only.
1. Preconditions: meeting `completed` or `error`-with-media; local media present; no run in flight; flags on
   (`MW_RECORDINGS_WRITE` and 044–046 present — detect columns/tables once per process like 1b does); otherwise fall
   back to TODAY's new-row behaviour untouched. Drop the "already ran on the current model" and the once-only
   refusals: same model + different language is legitimate; same model + same language asks the client to confirm
   (`409 {sameSettings:true}` unless `force`).
2. Submit the stored file to AssemblyAI (`uploadFile` + `submitTranscription`; keyterms gated by language as today,
   `language_code` forwarded ONLY when the caller chose one — `'auto'` means detection with code-switching options
   per `docs/eval-aai-code-switching-2026-09-21.md`). Insert the transcription `processing` with `requested`.
   Stamp `gmeet_context.retranscribing = { transcriptionId, jobId, startedAt, by, speechModel, languageCode }`.
   **The meeting stays `completed` and fully readable on the old version while the job runs.** Respond 202.
3. Completion is observed by the existing pollers, extended to also poll `retranscribing.jobId` (listing poll,
   detail sync) plus the 5-minute sweeper as the backstop (nobody may have the page open). On `completed`: store the
   payload on the transcription in the same write, then `activate`. On `error` / 404 / stuck 6 h: mark the
   transcription `error`, clear the marker, leave the meeting exactly as it was, surface the reason in the Sources
   card. DEC-4 delete-on-complete applies to the new job; the OLD job was already deleted (or gets purged).
4. After activate: speaker-ID pass + voiceprint suggestions re-run (labels are new); the speaker-review gate applies
   again; summary/report are NOT regenerated automatically — the page shows "Written from the previous transcription
   · Regenerate" (`notesStale`), because regeneration costs money and the old notes are still mostly right.
   DM dedupe keys that embed the meeting id (`mw-transcript-ready:<id>:<email>`) would silence the "ready" DM for a
   re-run — add the transcription id to the key for re-runs (landmine #9).
5. `GET /api/transcripts/:id/transcriptions` → `[{ id, active, status, speechModel, languageCode, confidence,
   requested, createdAt, completedAt, editsSetAside: n, error? }]` (access = the meeting's). 
   `POST /api/transcripts/:id/transcriptions/:tid/activate` — editors; refuses a non-completed T.
6. Offline/caches (landmine #5): the offline plan `rev` already hashes the row's fields + newest edit/mapping, so a
   swap moves it — verify, don't assume. `/content` must not be served stale from the service worker after a swap:
   check how the SW keys `/content` and bump what it needs (ETag from the active transcription id is the clean fix).
7. Shared AssemblyAI job across two owners (the one legacy pair): re-transcribe is refused there with a plain
   message (no media on the second row anyway).

## UI (transcript page — follow `docs/transcript-page-redesign.md`, the Sources card owns this)

- Sources card: the plain sentence stays. Under it a quiet **"Transcribe again…"** action (editors) opening a small
  dialog: Language (Auto-detect / the meeting's language / pick), Model (current default preselected), a one-line
  cost/time hint, and for same-settings the confirm. While running: "Transcribing again — Universal-3.5 Pro, English ·
  started 14:02 · you can keep reading" with no spinner over the text.
- When more than one version exists: a **Versions** disclosure in the Sources card — each line "Universal-2 ·
  Indonesian (auto) · 21 Sep 16:41 · 12 edits set aside" with **Use this version** on the inactive ones and the
  failure reason on failed ones. Switching is instant and says what happened to edits and names in one sentence.
- Replace the old "Re-transcribed → new row" pointer UI; legacy rows that carry `retranscribed`/`retranscribedFrom`
  keep their existing link.
- Notes/report tabs: the stale line with Regenerate.
- 24-hour times, SGT via the page's existing formatter, people as people; no filenames.

## darth-cli (report only in this phase)
List what `meetings retranscribe`-like verbs exist and what they expect back; the server keeps answering the old
shape when the fallback path runs. New verbs (`transcriptions`, `use-transcription`) are a follow-up for the CLI agent.

## Verification
- Unit: activate() bookkeeping as a pure planner (what is archived/restored/written) + the poller's decision table.
- Scratch Postgres with 044–046, AssemblyAI stubbed: run → read old version during the run → complete → row carries
  the new payload/job id, edits + names archived, versions list right; switch back → old payload AND old edits/names
  restored byte-for-byte; switch forward again → same; failure path leaves everything untouched; two quick runs are
  refused; recording graph sync + `recordings-verify` clean at every step; the Phase 1 diff-gate harness idea
  (flag off/on identical) still holds for meetings that were never re-run.
- Browser pass on a local server against the scratch DB for the dialog, the running state, the Versions list and the
  stale-notes line (light + dark, 390 px).
- `bun test`, `tsc`, `eslint`, env-less build.

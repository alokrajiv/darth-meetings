# Recordings on Azure Blob — Stage D: the VM becomes a cache

Status: spec, 2026-10-04. Completes `docs/recordings-blob-spec.md` (Stages A–C shipped 2026-09-22, the
read half of `ensureLocal` shipped 2026-10-02 as `src/lib/server/media-local.ts`). Alok's go: 2026-10-04
("complete the chain… make sure u have checksum and shit on the objects to be sure… make sure we have a pg
table with all this info safely"). Numbers that day: `storage/` on the root disk = 110 GB (103 GB canonical
mp4/m4a, 6.8 GB audio-only); the media container = 1,046 blobs / 108.46 GB, all stamped; `/temphigh` NVMe =
216 GB with 59 GB free.

## Goal

1. Every archived blob is **read back from Azure and hashed**, and the match is recorded in Postgres with a
   timestamp. Today's stamp proves "the hash we computed while uploading equals the metadata we set"; it never
   re-reads the bytes. Reads are in-region and free.
2. Local copies under `storage/audio/` and `storage/audio-only/` are **deleted only for rows whose blob was
   read-back-verified at least N days ago**, after one more local hash right before the unlink, and every
   deletion is written to an append-only ledger table first.
3. Work that needs a file (ffmpeg, the sidecar, frame grabs, clip cuts, combines, re-transcribes) gets it from
   the **bounded cache on the NVMe** (`/temphigh/mw-scratch/media-cache/`, 50 GiB cap) via `ensureLocalMedia`,
   which now verifies sha256 on the pull. `/temphigh` is ephemeral; a cold cache after a redeploy is normal.

Nothing in this stage writes to the blob container except the lifecycle canary that already exists.

## Decisions

- **Verification is a read-back, not a properties call.** `verifyArchivedBlob(row)` streams the whole blob
  through sha256 and counts bytes; both must equal `recording_media.sha256` / `bytes`. The cheap properties
  gate (size + metadata hash) runs first so a wrong blob fails without a download.
- **The stamp and the verification are separate columns.** `archiveMedia` re-archives a rewritten file under
  the same blob name (faststart remux); whenever `stampMediaArchived` writes, it RESETS the verification
  columns in the same UPDATE. A verification is only ever valid for the hash it was computed against, and the
  eviction query checks `blob_verified_sha256 = sha256` explicitly.
- **Eviction never trusts the stamp alone.** Right before the unlink the local file is hashed again and must
  equal `sha256`; a different hash means the file was rewritten after the stamp → the row's verification is
  cleared (not the stamp — the existing "rewritten since the stamp" path in `archiveMedia` handles the
  re-archive) and nothing is deleted. The blob's properties are read once more (exists, size, metadata hash)
  as a final existence check.
- **Ledger first, unlink second.** The `media_local_evictions` row is INSERTed and `local_evicted_at` is set in
  one transaction BEFORE the unlink. A crash between the two leaves a file on disk that the ledger says is
  gone — harmless (the next pass sees `local_evicted_at` set and skips the row; `scripts/media-evict.ts
  --orphans` lists such files). The opposite order could delete a file with no record of it.
- **Age gate: 7 days from verification, env-tunable** (`MW_MEDIA_EVICT_AFTER_DAYS`, default 7). Reason: the
  14-day blob soft delete and the rule that any post-archive rewrite (remux, re-encode) has long settled.
- **Oldest capture first**, caps per tick. A drain of today's 110 GB is a few hours of 5-minute ticks; the
  script can drain faster.
- **Frames (`storage/frames/`, 238 MB) are untouched.** They are already a cache keyed on the blob (c972097).
- **Nothing re-populates `storage/audio/`.** A pulled file lives in the cache only (already true of
  `media-local.ts`). A row with `local_evicted_at` set and its file missing is the normal state, not a defect:
  `scripts/recordings-verify.ts` and `media-archive-status.ts` must treat it as such (new "evicted" column).
- **Flag:** `MW_MEDIA_EVICT=1` gates the sweeper's eviction pass only. Verification runs whenever the archive
  is configured (it is read-only toward Azure and only writes the new columns). The script is dry-run by
  default and needs `--apply`.

## Schema — `migrations/051_media_local_eviction.sql` (prod schema convention, additive)

```sql
ALTER TABLE recording_media
  ADD COLUMN IF NOT EXISTS blob_verified_at      timestamptz,  -- read-back matched sha256 + bytes
  ADD COLUMN IF NOT EXISTS blob_verified_sha256  text,         -- the hash the read-back produced
  ADD COLUMN IF NOT EXISTS blob_verified_bytes   bigint,
  ADD COLUMN IF NOT EXISTS blob_verify_failed_at timestamptz,  -- last read-back that did NOT match
  ADD COLUMN IF NOT EXISTS blob_verify_error     text,
  ADD COLUMN IF NOT EXISTS local_evicted_at      timestamptz;  -- local copy removed by Stage D

CREATE INDEX IF NOT EXISTS recording_media_verify_pending_idx
  ON recording_media (created_at) WHERE blob_name IS NOT NULL AND blob_verified_at IS NULL;
CREATE INDEX IF NOT EXISTS recording_media_evict_pending_idx
  ON recording_media (blob_verified_at) WHERE blob_verified_at IS NOT NULL AND local_evicted_at IS NULL;

-- Append-only. One row per local file Stage D removed. Never joined back (the media row may be gone later).
CREATE TABLE IF NOT EXISTS media_local_evictions (
  id                bigserial PRIMARY KEY,
  media_id          uuid NOT NULL,
  recording_id      uuid NOT NULL,
  kind              text NOT NULL,
  filename          text NOT NULL,
  local_path        text NOT NULL,
  bytes             bigint NOT NULL,
  local_sha256      text NOT NULL,        -- hashed right before the unlink
  blob_name         text NOT NULL,
  blob_sha256       text NOT NULL,        -- recording_media.sha256 at that moment (= blob_verified_sha256)
  blob_verified_at  timestamptz NOT NULL,
  evicted_at        timestamptz NOT NULL DEFAULT now(),
  evicted_by        text NOT NULL,        -- 'sweeper' | 'script:<user>@<host>'
  note              text
);
CREATE INDEX IF NOT EXISTS media_local_evictions_media_idx ON media_local_evictions (media_id);
CREATE INDEX IF NOT EXISTS media_local_evictions_evicted_idx ON media_local_evictions (evicted_at);
```

Applied like 047 (`sed 's/meeting_whisperer_prod/…/'` for any other schema). Code probes for the columns once
per process like `mediaArchiveTablesExist()` so a deploy ahead of the migration is inert.

## Code

### `src/lib/server/media-archive.ts`
- `verifyArchivedBlob(row): Promise<VerifyOutcome>` — `{status:'verified', bytes, sha256, ms} |
  {status:'mismatch', error} | {status:'skipped', reason}`. Properties gate → streamed read-back → UPDATE via
  `stampMediaVerified(id, {sha256, bytes})` guarded `WHERE id = $1 AND blob_name = $2 AND sha256 = $3`. Mismatch →
  `stampMediaVerifyFailed(id, error)` + `console.error('[media-verify] MISMATCH …')`. A mismatch is NEVER
  auto-repaired here; the status script shows it and a human decides (the local file, if present, is the truth).
- `stampArchived` (via `stampMediaArchived`) resets the six verification/eviction columns.
- `sha256OfFile` is exported (the eviction and the script use it).

### `src/lib/server/media-evict.ts` (new; shared by the sweeper pass and the script)
- `listEvictableMedia({minAgeDays, limit})` (db-ops): `blob_name IS NOT NULL AND blob_verified_at <= now() -
  interval AND blob_verified_sha256 = sha256 AND local_evicted_at IS NULL AND kind IN ('canonical','audio_only',
  'part') AND recording not deleted`, oldest `created_at` first.
- `evictLocalCopy(row, {by}): Promise<EvictOutcome>` — the per-row procedure in "Decisions": skip when the
  transcript of that recording is `uploading|queued|processing` or any `*_status = 'running'`, when the file's
  mtime is < 1 h, or when `__mwAudioOnlyInflight` / `__mwMediaPrepInflight` / the clip-cut queue hold that
  recording; stat size must equal `bytes`; local hash must equal `sha256` (else clear verification, return
  `{status:'rewritten'}`); blob properties must match; INSERT ledger + SET `local_evicted_at` in one
  transaction; unlink; return `{status:'evicted', bytes}`. A missing file with no ledger row → set
  `local_evicted_at` with a ledger note `'already gone'` so the row stops being a candidate.
- `evictionPass({files, by})` with the pass-level `archiveShouldYield()` and a mid-pass yield check every 5
  files, one log line per tick like the archive's.

### `src/lib/server/media-sweeper.ts`
- After `archiveBackfillPass()`: `verifyBackfillPass()` — caps `MW_VERIFY_FILES_PER_TICK` (default 20) /
  `MW_VERIFY_GB_PER_TICK` (default 10), rows with `blob_verified_at IS NULL AND (blob_verify_failed_at IS NULL OR
  < now() - 24 h)`, same yield rule. Then, only with `MW_MEDIA_EVICT=1`: `evictionPass({files:
  MW_EVICT_FILES_PER_TICK default 20, by:'sweeper'})`.

### `src/lib/server/media-local.ts`
- `LocalizableMedia` gains optional `sha256: string | null` (and `audioOnly.sha256`). `pullToCache` hashes
  while writing; when a hash is known and differs → throw (the `.part` is removed) and the warning says so.
  Callers that build `LocalizableMedia` from rows pass the row's sha256.
- Before a pull: `statfs` on the cache dir; if `bavail*bsize < size + MW_MEDIA_CACHE_MIN_FREE_BYTES` (default
  5 GiB) run `evictMediaCache()` first, then re-check; still short → return null with a warning naming the
  free space. The cache must never fill `/temphigh`.
- Defaults stay (4 GiB / 1 h); the VM env sets `MW_MEDIA_CACHE_MAX_BYTES=53687091200` and
  `MW_MEDIA_CACHE_TTL_MS=86400000`.

### `scripts/media-evict.ts` (new; dry-run default)
`SCHEMA_PREFIX=prod bun run scripts/media-evict.ts [--apply] [--limit N] [--min-age-days N] [--largest-first]
[--orphans]`. Prints the candidate table (id, kind, bytes, captured, verified-at, path) and totals; `--apply`
runs `evictLocalCopy` per row with `by:'script:<user>@<host>'`; `--orphans` lists files under `storage/audio*`
that no live media row names (report only). Runs on the VM (managed identity) from the LIVE colour.

### `scripts/media-archive-status.ts`
New counts per kind: verified / unverified / verify-failed / evicted (+ bytes), and `--verify [--limit N]` to run
`verifyArchivedBlob` synchronously (the fast drain). `--check-blobs` keeps its meaning.

### Readers that still open the stored path directly
Audited separately (2026-10-04); each is routed through `ensureLocalMedia` / `localMediaSession` or, for the
write paths, left alone. See the audit table appended to this document.

## Tests
`src/lib/server/__tests__/media-evict.test.ts` on `helpers/fake-media-blob.ts` + the scratch PG: verify →
age gate → evict (ledger row, `local_evicted_at`, file gone); rewritten-after-verify → nothing deleted,
verification cleared; running transcript → skipped; crash between ledger and unlink → next pass skips; pull with
wrong sha256 → null and no cache entry; low free space → eviction then pull, or null.

## Rollout (runbook; Alok applies the migration, the rest is the usual deploy)
1. `migrations/051_media_local_eviction.sql` on prod (Alok applies it, like 047–050).
2. Deploy. Verification starts on its own (10 GB / 5-min tick → today's 108 GB in ~1 h), or
   `media-archive-status.ts --verify` to drain at once. Check `--check-blobs` style output: verified 1046/1046.
3. VM `.env.local`: `MW_MEDIA_CACHE_MAX_BYTES=53687091200`, `MW_MEDIA_CACHE_TTL_MS=86400000`,
   `MW_MEDIA_CACHE_MIN_FREE_BYTES=5368709120`.
4. `scripts/media-evict.ts` dry run (expect 0 until the age gate passes; `--min-age-days 0` shows the full set).
5. After the readers are wrapped and a cold-cache pass is proven (voiceprint, frames, clip cut, retranscribe on
   an evicted row): `MW_MEDIA_EVICT=1`, deploy. The sweeper drains `storage/` as rows cross the age gate.

## As built — verification, eviction, the cache's guards (2026-10-04)

Everything in "Schema", "Code" (bar the readers, audited separately) and "Tests" above, with these
deviations:

- **The migration is `migrations/051_media_local_eviction.sql`, not 048.** 048–050 already exist
  (`048_share_origin`, `049_recordings_born_bare`, `050_voiceprint_weight_secs`); the DDL is the one
  above, verbatim. Rollout step 1 applies 051. `local_sha256 = ''` marks an "already gone" ledger
  row (the column is NOT NULL and nothing was hashed).
- **Extra guards, all in the safe direction:** eviction also refuses while the lifecycle canary is
  gone (the blob would be the only copy); while a `recording_transcriptions` row of the recording is
  `processing` (re-transcribe); while ANY clip pre-cut drain is running (the queue does not say which
  meeting it is cutting); when the file changed while it was being hashed; and when the blob's HEAD
  no longer matches (then the verification is cleared and it is logged as an error). A local SIZE
  mismatch is treated like a hash mismatch (`rewritten`, verification cleared). The per-recording
  busy probe is not time-bounded: a status stuck at `processing` keeps that file, never frees it.
- **`stampMediaVerified` / `listEvictableMedia`** additionally require `blob_verified_bytes = bytes`.
  `stampMediaVerifyFailed` revokes any earlier pass in the same UPDATE. A read-back that dies
  part-way is recorded as a failure (so the 24 h back-off applies) but reported `skipped`, not
  MISMATCH. A transient HEAD error records nothing.
- **Two eviction hazards outside the spec's list, closed:** (1) `applyRecordingGraph`'s probed stale
  DELETE now never removes an `audio_only` row with `local_evicted_at` set (that DELETE queues the
  row's blob for deletion — it would have deleted the extract's only copy); a failed 051 probe skips
  judging derivatives for that sync. (2) The sweeper's orphan-derivative sweep treated an extract
  whose source `<stem>.*` is missing from `storage/audio/` as an orphan — after a canonical is
  evicted that is every extract — and removing it also drops its row and queues its blob; stems of
  evicted canonical/part rows now count as live (`evictedSourceStems`). The readers' builder made
  `recording-sync.ts` keep archived extracts (`archivedAudioOnly`) and `media-readers.ts`
  (`stemsStillNamed`) in parallel (in flight as this was written); the guards overlap and agree.
- **`RecordingMediaRow`** gains the six columns as OPTIONAL fields; `mediaCols` stays fixed and
  `mediaColsStageD` is chosen per call on the cached probe (`stageDColumnsOn`), so every SELECT keeps
  working on a schema without 051. The probe is silent (it runs on playback paths).
- **`media-local.ts`** (with two additions from the readers' audit): every `ensureLocalMedia` result
  takes a reference — disk hits too — keyed by the absolute path it returns, and
  `localMediaHeld(abs)` is what the eviction asks (`{status:'skipped', reason:'held'}`). A third
  want, `'canonical'`: the stored file, else the canonical blob, never the derivative, regardless of
  `isVideo` (re-transcribe / re-ingest need the bytes `recordings.sha256` describes). `sha256` on
  `LocalizableMedia` / `audioOnly` is optional; the pull hashes while writing and a known hash that
  differs throws `sha256 mismatch` (the `.part` is removed, nothing is cached). The free-space guard
  runs after the blob's HEAD (its size is needed); a `statfs` that fails lets the pull go ahead.
  `setMediaCacheStatfsForTests` is the test seam. **Not done here:** the resolver
  (`lib/server/recordings.ts` `ResolvedMedia`) and `align.ts` do not yet pass the row's `sha256`
  into `LocalizableMedia`, so the hash check is live only for callers that do — the field is
  optional so that wiring can land with the readers.
- **Scripts:** `media-archive-status.ts --verify` needs `bun --conditions=react-server` (it imports
  the server libs lazily; the report itself still runs under plain `bun run`) and drains every row
  unless `--limit`. `media-evict.ts --apply` refuses without `DARTH_MEDIA_ACCOUNT`; `--orphans`
  also lists files the ledger calls evicted (the crash leftover).

| Env | Default | Meaning |
|---|---|---|
| `MW_MEDIA_EVICT` | off | `1`/`true`: the sweeper's eviction pass runs |
| `MW_MEDIA_EVICT_AFTER_DAYS` | 7 | days from read-back to delete (0 allowed) |
| `MW_EVICT_FILES_PER_TICK` | 20 | deletions per tick |
| `MW_VERIFY_FILES_PER_TICK` / `MW_VERIFY_GB_PER_TICK` | 20 / 10 | read-backs per tick |
| `MW_MEDIA_CACHE_MIN_FREE_BYTES` | 5 GiB | free space the cache's filesystem keeps after a pull |

Files: `migrations/051_media_local_eviction.sql`; `src/db-ops/recordings.ts` (Stage D section,
`stampMediaArchived` reset, the `applyRecordingGraph` guard); `src/lib/server/media-archive.ts`
(`verifyArchivedBlob`, `sha256OfFile` exported); `src/lib/server/media-evict.ts`;
`src/lib/server/media-sweeper.ts` (`verifyBackfillPass`, the eviction pass, the derivative-sweep
guard); `src/lib/server/media-local.ts`; `scripts/media-evict.ts`; `scripts/media-archive-status.ts`;
`scripts/recordings-verify.ts` (evicted rows are INFO). Tests: `media-evict.test.ts` (27),
`media-local.test.ts` (+6), and the scratch-PG check `tmp/media-evict/` (39 checks over 000…051).

## As built — readers (2026-10-04)

Every reader of a stored file now (1) never destroys a blob or a row because a LOCAL file is absent, and
(2) reads through `ensureLocalMedia` / `localMediaSession` with a hold (`localMediaHeld`) for as long as
the file is in use. Shared pieces: `src/db-ops/media-readers.ts` (`stemsStillNamed`,
`archivedStoredFiles`, `archivedAudioOnlyRows`) and `src/lib/server/stored-media.ts` ("held" = on disk OR
`blob_name` + `sha256`, the `aai-retention.ts mediaIsSafe` definition; `storedFileSources`,
`withHeldStoredFiles`).

**A — blob and row protection**
- A1 `lib/recording-graph.ts` `GraphFileFacts.archivedAudioOnly` + `archivedAudioOnlyFacts`;
  `lib/server/recording-sync.ts` `probeFiles`: an ARCHIVED `audio_only` row whose `<stem>.m4a` is not on
  disk is reported, so `deriveRecordingGraph` keeps it (bytes from the row) and `applyRecordingGraph`
  neither deletes it nor queues its blob. Only stems of files the row still names (a renamed source's
  extract is still dropped); a failed row read = "not probed" (derivatives not judged). The upsert never
  names `blob_name` / `sha256` / `local_evicted_at`, so they survive; a canonical/part not on disk sends
  `bytes` NULL (COALESCE keeps the row's). `applyRecordingGraph` itself is unchanged by this item (the
  `local_evicted_at` guard in its DELETE is the eviction builder's, kept as a second layer).
- A2 `media-sweeper.ts` `sweepOrphanDerivatives`: after the disk check (and the evicted-source guard),
  an extract is an orphan only when `stemsStillNamed` finds no canonical/part media row and no meeting
  (`local_audio_path`, `videoParts[].filename`) naming its stem — trashed meetings/recordings count
  (restorable). A failed lookup removes nothing that tick.
- A3 `born-bare.ts` (completion delete in `refreshBornBare`, the AAI-delete backlog in `sweepBornBare`):
  an archived canonical counts as held; `standaloneMedia` / `listStandaloneAaiDeletePending` now return
  `sha256` (+ `bytes`, `of_media_id`; `canonical_blob_name`, `canonical_sha256`).
- A4 `media-sweeper.ts` `prepareRow`: a missing file whose canonical/part row is archived reports
  "archived, not on disk — nothing to prepare" and is stamped done (no error, no attempt); nothing is
  rebuilt into `storage/`. Not archived = "file missing" as before.

**B — holds on long-running readers**
- B1 `clip-cut.ts` `cutOnce`: both branches go through `ensureLocalMedia` (the resolved media, else a
  disk-only `LocalizableMedia` in fallback mode), held for the ffprobe and every ffmpeg run, released in
  `finally`. `?variant=audio` of a video keeps reading the audio-only extract when it is the cheaper rung
  (existing behaviour); everything else reads the stored file's own bytes. `cutKeyOf` uses the row's
  `isVideo` when known (stable across eviction; ffprobe only when the row does not know).
- B2 `align.ts` `audioPathForRecording`: one `ensureLocalMedia(…, 'audio')` handle released by the
  caller after the sidecar; passes `sha256`. LIMIT: when the canonical is on disk and the extract is
  read, the hold is on the canonical — media-local's ladder answers with the source first, so it hands
  out no handle on an on-disk extract while its source is there. A fresh build is protected by the
  eviction's 1 h mtime rule; an old extract is not held (an open fd survives an unlink on Linux, so the
  exposure is the gap before the sidecar opens it). Fix belongs in media-local (prefer the on-disk
  extract for `'audio'` of a video, or export a hold for a known path).
- B3 `transcription-runs.ts`: the 422 accepts an archived canonical (`storedFileSource`); `uploadFile`
  reads a `'canonical'` handle held for the whole upload (`withHeldStoredFiles`).
- B4 `born-bare.ts` `resendToAai`: same as B3.
- B5 `transcripts/[id]/retranscribe/route.ts` `legacyRetranscribe`: archived accepted (size from the
  row); a `'canonical'` handle is taken BEFORE the new row is opened (fetch failure = 503, nothing
  created) and released after the copy. A media-cache entry is always COPIED, never hard-linked (the
  pipeline may rewrite its temp in place; a link would be a second name on the cache's inode); a disk
  hit keeps `link` → `copyFile`.
- B6 `gmeet-import-core.ts`: the combine and the re-run copy read every input through one
  `localMediaSession('canonical')`, held until ffmpeg / the copy is done. New
  `media-concat.ts concatMediaPathsToTemp` (absolute inputs) and `audio-storage.ts copyPathToAudioTemp`.
  A source that cannot be had is a 502 with a "try again" message instead of an ffmpeg error.
- B7 `ingest-retry.ts` `retryIngest`: an evicted + archived stored file is no longer non-retryable — it is
  pulled, COPIED to a fresh `upload-*.part` under the audio dir while held, released, and the copy is
  ingested (the cache entry is never handed to ingest). A fetch failure leaves the row retryable. NOTE:
  ingest renames that temp to its stored name, so a successful retry puts the file back under
  `storage/audio/` while the row still has `local_evicted_at` — the eviction pass skips such a row; it is
  listed by `media-evict.ts --orphans`.

**C — probes and metadata**
- C1 `video-frames.ts` `hasVideoStream`: a failed ffprobe is no longer cached as "no video".
- C2 `offline/plan/route.ts`: one `storedFileSources` per page — an evicted + archived file reports
  `hasLocal` and the row's `bytes`; `isVideo` from the row when not on disk. `storedFileDurationMs` is
  unchanged: an archived file always has a media row, whose `durationMs` the plan already prefers.
  `clip-cut.ts findClipCut`: a missing source counts any existing cut as fresh (comment says why).
- C3 `recordings/[id]/audio/route.ts`: `?variant=audio` with no local file proxies the archived
  audio-only extract when there is one, else the canonical.

**Tests** — `src/lib/server/__tests__/stage-d-readers.test.ts` (31: A1–A4, the helpers, B2–B7, C2, C3
over the fake tag + `FakeMediaBlob` + a fake AssemblyAI `fetch`), `clip-cut-ffmpeg.test.ts` (+4: B1 hold
on disk and pulled, the cut found after eviction, C1), `recording-graph.test.ts` (+3),
`clip-cut-routes.test.ts` (source assertion updated for B1). The readers file routes
`listRecordingMedia` to a real module instance while it runs, because media-archive / media-evict tests
replace it process-wide.

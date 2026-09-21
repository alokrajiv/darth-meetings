# Recordings live in Azure Blob — DEC-3 build spec

Status: **design + staged build brief**, 2026-09-22. Decision: `docs/recordings-first-class-design.md` §7 DEC-3 —
Azure Blob is the permanent home of recording bytes, the VM is a cache, manipulation happens on the NVMe scratch.
Depends on Phase 1 tables (`recording_media.blob_name`, `.sha256`, `.bytes`).

## Facts (checked 2026-09-21/22)

- Account `darthuploads` (southeastasia, same region as the VM), container `meetings`, used today as **transit**:
  browser/tray → block blob via a per-blob user-delegation SAS → the VM pulls it once, verifies sha256, deletes it
  (`src/lib/server/darth-uploads.ts`, `darth-uploads-store.ts`, `docs/darth-uploads.md`). Auth = the VM's managed
  identity (Storage Blob Data Contributor on the account); no keys anywhere; `allowSharedKeyAccess=false`.
- **The transit account deletes everything after a day — verified 2026-09-22** (`az storage account
  management-policy show`, read-only): rule `expire-uploads`, enabled, blockBlob, `daysAfterModificationGreaterThan: 1`,
  **no prefix filter** → it applies to every container in `darthuploads` (today: `chat`, `meetings`), including any
  new one. Permanent media put there would be destroyed the next day.
  → NEEDS ALOK (management plane, his call): **a separate account for permanent media** (recommended:
  `darthmedia`, same region/RG `prod-internal-rg`, Standard_LRS or ZRS, `allowSharedKeyAccess=false`, no public
  access, blob soft-delete 14 d + container soft-delete, CORS for the meetings origin, the VM identity `darth-p01`
  gets Storage Blob Data Contributor) — transit and archive have opposite lifecycles and should not share a rule
  set. Alternative: add `prefixMatch: ["chat/", "meetings/"]` to `expire-uploads` and use a third container; one
  edit, but a future rule change in the chat repo could then delete the archive.
  Config is therefore `DARTH_MEDIA_ACCOUNT` + `DARTH_MEDIA_CONTAINER` (default `meetings-media`), independent of
  `DARTH_UPLOADS_*`. Unset → every stage below is off. The canary (Stage A.4) stays as the guard against a rule
  appearing later.
- VM: media today = 80 GB under `~/apps/meeting-whisperer/storage/` on the root disk (495 GB, 287 GB free), a single
  copy with no backup. NVMe scratch `/temphigh` = 216 GB, 101 GB free, ephemeral (lost on deallocate) — cache and
  scratch only, never the only copy of anything.
- `darth-uploads.ts` is lifted verbatim from `../chat` and must stay in step: do not edit it. Everything new goes in
  a meetings-only module on top of the `BlobLike` seam (extend the seam in a sibling file if a method is missing,
  e.g. server-side copy; the fake store in tests must grow the same method).

## Layout

Container **`meetings-media`** in the media account (`DARTH_MEDIA_ACCOUNT` / `DARTH_MEDIA_CONTAINER`). Blob name
`<recording_id>/<media_id><.ext>`: no user id, no filename, no meeting title in the path (names leak; ids do not).
Blob properties: `Content-Type` from the extension (the player needs it after a redirect), `Content-Disposition:
inline`. Metadata: `sha256`, `kind`. Tier Hot; a later lifecycle rule may move blobs untouched for 90 d to Cool —
not part of this spec.

## Stage A — archive (durability first, zero reader change)   flag `MW_MEDIA_ARCHIVE`

1. New `src/lib/server/media-archive.ts`: `archiveMedia(mediaRow)` streams the local file to its blob (block upload,
   sha256 computed on the way, 8 MB blocks, bounded parallelism), then re-reads the blob's size + stored hash,
   and only then writes `recording_media.blob_name`, `sha256`, `bytes`. Idempotent: an existing blob with the same
   size + hash is adopted. Never deletes the local file.
2. Hook: after the recording-graph sync that follows ingest / a part landing / a derivative being built, queue the
   archive (fire-and-forget, serialised per media id). Derivatives (`audio_only`) are archived too — they are what
   phones stream.
3. Backfill pass in `media-sweeper.ts` (NOT in auto-notes-sweeper): media rows with a local file and no `blob_name`,
   oldest first, `nice`-equivalent pacing: at most 2 GB or 5 files per 5-minute tick, skipped while an ingest or AI
   run is active. 80 GB ≈ 3–4 h of ticks. Progress line in the pm2 log per tick; totals via
   `scripts/media-archive-status.ts` (read-only: archived / pending / bytes, by kind).
4. **Lifecycle canary**: on first enable, write `_canary/<date>` to the container and record it; the sweeper checks
   that the canary from ≥ 36 h ago still exists before it archives anything after the first 36 h, and
   `media-archive-status` prints CANARY OK / CANARY GONE. If the rule eats the canary, archiving stops and says why.
5. The recording-graph sync and `recordings-verify` must treat `blob_name` / `sha256` as NOT derived from the meeting
   row: never nulled by a sync, never reported as drift. (Check `applyRecordingGraph`'s upsert — it must not
   overwrite them.)
6. `recordings.sha256` = the canonical media's sha256 (this is what Phase 2's same-file check reads).
7. Permanent delete of a recording's rows also deletes its blobs (only when no clip of any meeting is left — the
   Phase 1 rule); soft delete never touches blobs.

### Stage A as built — 2026-09-22

Nothing here is on: `DARTH_MEDIA_ACCOUNT` does not exist yet, so every piece below is inert (no query, no
network) until the account is provisioned AND `MW_MEDIA_ARCHIVE` is set.

| Piece | File |
|---|---|
| The permanent store: `DARTH_MEDIA_*` config, `createAzureBlobStore` + the three archive methods (`putStream`, `setMetadata`, `properties`), blob name, content type | `src/lib/server/media-store.ts` |
| `archiveMedia` / `archiveRecording` / the fire-and-forget queue, the canary, the pacing rule, the blob-delete paths, the "is the VM busy" probe | `src/lib/server/media-archive.ts` |
| The hook (one call after a successful sync) + permanent delete takes the blobs | `src/lib/server/recording-sync.ts` |
| The paced backfill (≤ 2 GB / 5 files per 5-minute tick) + the pending-delete drain | `src/lib/server/media-sweeper.ts` |
| Archive db-ops (append-only section), and the note on `applyRecordingGraph`'s upsert that keeps A.5 true | `src/db-ops/recordings.ts` |
| `media_blob_deletes` + `media_archive_canaries` | `migrations/047_media_archive.sql` |
| Totals / canary / `--check-blobs` | `scripts/media-archive-status.ts` |
| The archive as INFO, never drift | `scripts/recordings-verify.ts` |
| Tests | `src/lib/server/__tests__/media-archive.test.ts` (+ `helpers/fake-media-blob.ts`), `tmp/media-archive/` (scratch PG integration check) |

Decisions taken while building:

- **A.5 needed no code change.** `applyRecordingGraph` never names `blob_name` / `sha256` in the media upsert and
  never names `recordings.sha256` — the stamps already survive a re-derive. A comment now says so, and
  `recordings-verify` reads the two columns only to COUNT them in an INFO block that cannot affect the exit code.
- **Pending deletes are a table, not a jsonb stash.** Permanent delete destroys the meeting row AND the recording /
  media rows in one transaction, so afterwards no surviving row owns those blob names; a jsonb queue would have to
  squat on an unrelated row. The names are written to `media_blob_deletes` BEFORE the blob delete is attempted and
  the row is cleared on success, so a crash mid-delete costs one retry, never a leaked blob.
- **Verify is size + the stored hash, as the spec says.** Azure cannot hash a blob for us, so the sha256 we compare
  against is the one we wrote as metadata: the check proves the blob exists, is exactly as long as the local file,
  and carries the hash every later reader (Stage B/D, `--check-blobs`) will verify against. A full byte read-back is
  `media-archive-status --check-blobs` and Stage D's `ensureLocal`, not the hot path.
- **Busy = a DB probe + the in-process ffmpeg maps.** There is no shared busy flag in the app and `ai_runs` rows are
  only written when a run FINISHES, so the backfill yields on `transcripts.status IN (uploading, queued, processing)`
  within 12 h and on `auto_notes/auto_report/speaker_id_status = 'running'` within 30 min (time-bounded because those
  statuses get stuck across a pm2 restart), plus `__mwAudioOnlyInflight` / `__mwMediaPrepInflight` in this process.

Config (names only, never a key), once the account exists:

```
DARTH_MEDIA_ACCOUNT=darthmedia
DARTH_MEDIA_CONTAINER=meetings-media
MW_MEDIA_ARCHIVE=1
```

**CORS is not needed for Stage A** — the VM is the only client and it talks to Blob server-side. CORS becomes
necessary in Stage B, when a browser follows a redirect to a SAS URL (and even then only for `Range`/preflight
cases); it is listed in the provisioning note above so it is not forgotten, not because Stage A uses it.

## Stage B — serve from blob   flag `MW_MEDIA_FROM_BLOB`

- `/api/transcripts/:id/audio` (and `?part=N`, `?variant=audio`): access check as today → when the resolved media
  has a `blob_name`: **302 to a read-only SAS, TTL 60 min**, `Cache-Control: private, no-store` on the redirect.
  `<audio>/<video>` follow cross-origin redirects and Range works against Blob, so the player needs no change.
- Stays on the app (streamed from the local cache, fetched from blob on a miss): requests with `?via=app`, the
  service worker's pin downloads (a pinned URL must be stable and same-origin — `offline-urls.ts` adds `via=app`),
  and any caller sending the `dth_` bearer (darth-cli downloads) unless it passes `?redirect=1`.
- A SAS URL is a bearer link for its lifetime: whoever gets the URL can read that one blob for ≤ 60 min. That is the
  trade for not proxying bytes; it is the same trust the upload ticket already takes. The access decision is still
  per request, caller-scoped, before the redirect. Never log the SAS query string.
- Speed: bytes no longer cross nginx/Next on the VM or Tailscale at all — the browser talks to the storage front end.

## Stage C — AssemblyAI reads the blob; the VM stops pushing bytes   flag `MW_AAI_FROM_BLOB`

- Single-file uploads that arrived through blob transit: **server-side copy** transit blob → `meetings-media`
  (no bytes through the VM), hand AssemblyAI `audio_url` = read SAS with TTL 6 h instead of `files.upload`. The VM
  fetches a local copy in the background only for what needs one (faststart check/remux, audio-only extract,
  voiceprints, frames). The meeting is transcribing while that happens.
- Anything that must be manipulated first (tray parts → one file, multi-track mix-down, stitched uploads, Meet
  combine — DEC-1: one recording = one job): work in `/temphigh/mw-scratch/<id>/`, upload the result to
  `meetings-media`, then the same SAS hand-off. Parts are archived as `part` media.
- DEC-4 note: with a SAS there is no AssemblyAI-side upload to delete; deleting the job removes their transcript,
  and our SAS simply expires. Keep the TTL as short as the longest realistic queue + processing time.
- The transit pull path stays as the fallback when the flag is off or the copy fails.

## Stage D — the VM becomes a cache   flag `MW_MEDIA_CACHE`  (last; needs Alok's go)

- Local reads go through `ensureLocal(media)` → path in `/temphigh/mw-cache/` (LRU by atime, cap 60 GB, never evicts
  a file an ffmpeg/voiceprint/AI run holds — lease files), fetching from blob on a miss with hash verification.
- `storage/` on the root disk is drained only for media whose blob was verified (size + sha256) at least 7 days ago,
  by an explicit script (`scripts/media-evict.ts`, dry-run default). Until then both copies exist.
- `/temphigh` is ephemeral by design: after a VM redeploy the cache is simply cold.

## Cost (order of magnitude, southeastasia, Hot LRS)
Storage ≈ US$0.02/GB-month → 80 GB ≈ US$1.6/month. Reads from the VM (same region) are free. Internet egress to
people's browsers ≈ US$0.09–0.12/GB → a full 600 MB video view ≈ 6 cents; audio-only playback is ~1/20 of that.

## Verification per stage
Unit tests on the fake blob store. Live proof on `.6` follows `docs/darth-uploads.md`'s E2E pattern (needs the VM's
managed identity → runs on the VM, read-only toward the DB except the rows under test). A: archive one recording,
kill it mid-upload, resume, verify hash; canary. B: browser playback + seek + phone, SW pin still same-origin, SAS
never in logs. C: a real short upload end to end with the VM's outbound bytes to AssemblyAI ≈ 0. D: cold-cache play.

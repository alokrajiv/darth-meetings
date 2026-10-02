# Recordings live in Azure Blob — DEC-3 build spec

Status: **design + staged build brief**, 2026-09-22. Decision: `docs/recordings-first-class-design.md` §7 DEC-3 —
Azure Blob is the permanent home of recording bytes, the VM is a cache, manipulation happens on the NVMe scratch.
Depends on Phase 1 tables (`recording_media.blob_name`, `.sha256`, `.bytes`).

> **2026-10-02:** the web app's offline pins and service worker described below (`src/lib/offline/*`, the
> `public/sw.js` media cache) were removed — README "Offline and PWA — removed 2026-10-02". The
> `x-darth-media-via: app` header stays: the player's audio-only probe still sends it.

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
  `<audio>/<video>` follow cross-origin redirects and Range works against Blob, so the player needs no change
  *for playback*; it did need one for RECOVERY, since a SAS can expire mid-session (see "Stage B as built").
- Stays on the app (streamed from the local cache, fetched from blob on a miss): requests with `?via=app`, the
  service worker's pin downloads (a pinned URL must be stable and same-origin — **as built this is a request
  header, `x-darth-media-via: app`, NOT a query parameter; see "Stage B as built" for why adding one to a pinned
  URL would have re-downloaded and broken every existing pin**), and any caller sending the `dth_` bearer
  (darth-cli downloads) unless it passes `?redirect=1`.
- A SAS URL is a bearer link for its lifetime: whoever gets the URL can read that one blob for ≤ 60 min. That is the
  trade for not proxying bytes; it is the same trust the upload ticket already takes. The access decision is still
  per request, caller-scoped, before the redirect. Never log the SAS query string.
- Speed: bytes no longer cross nginx/Next on the VM or Tailscale at all — the browser talks to the storage front end.

### Stage B as built — 2026-09-22

Inert until `DARTH_MEDIA_ACCOUNT` exists **and** `MW_MEDIA_FROM_BLOB` is set **and** the media row has a
`blob_name`. Any one of the three missing → the route streams from disk exactly as before, with not one extra
query and not one call to the store (proven: `tmp/media-serve/` check 4).

| Piece | File |
|---|---|
| `blobName` + the `audioOnly` derivative (id / filename / its own `blob_name`) on `ResolvedMedia`, attached from the graph the resolver already loaded — **no extra query** | `src/lib/server/recordings.ts` |
| The policy: `MW_MEDIA_FROM_BLOB`, who may be redirected, which blob answers which request, the 302, `redactSas`, the Stage-D proxy with Range | `src/lib/server/media-serve.ts` |
| The route: access check → 302 / local stream / blob proxy, and a `redactError` on every `console.*` | `src/app/api/transcripts/[id]/audio/route.ts` |
| `readRange` added to the `MediaBlobLike` seam (the sibling module, never `darth-uploads.ts`) | `src/lib/server/media-store.ts` (+ the fake) |
| The pin downloader sends `x-darth-media-via: app`; the URL shape is untouched | `src/lib/offline/offline-pins.ts`, `src/lib/offline/offline-urls.ts` |
| The probe sends the same header; a media error re-requests the app URL once and resumes, then falls back to `?via=app` | `src/components/audio-player.tsx` |
| Stage A leftovers: the stale-media DELETE, the promotion DELETE and `dropDerivativeMediaByFilename` all queue the blobs they orphan (`RETURNING blob_name` → `media_blob_deletes`, same transaction, gated on a 047 probe) | `src/db-ops/recordings.ts` |
| Tests | `src/lib/server/__tests__/media-serve.test.ts` (21), `src/lib/__tests__/offline-urls.test.ts` (31), `tmp/media-serve/` (46-check scratch-PG integration) |

**The pinned-URL decision — no `via=app` in `offline-urls.ts`.** The sketch above said this file would append
`?via=app` to every media URL it emits. It must not: those strings ARE the Cache Storage keys. `public/sw.js`
`media()` matches on `pathname + search` exactly; `offline-pins.ts` stores, sizes and evicts by the same string;
`audio-player.tsx` spells `?variant=audio` identically on purpose so a pinned extract answers the player from
cache. Re-spelling them would orphan every body already in `CACHE_MEDIA` — hundreds of MB re-downloaded per
pinned meeting — and, worse, **break offline playback** for those pins, because the `<audio>` element still asks
for the un-suffixed URL and the worker would miss. So the pin downloader and the probe mark themselves with a
REQUEST HEADER, `x-darth-media-via: app`, which no cache key in the stack can see. Nothing moves: same URLs,
same worker matching, same plan `rev` (it hashes clip/media identity, never a URL), zero re-download. `?via=app`
still works as an explicit opt-out for anyone who wants it in a URL — it is simply not what a pin uses.

**What the owner must provision** (beyond Stage A's account + container + the VM identity):

- **Role: nothing new.** Minting a user-delegation SAS needs
  `Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action`, and **Storage Blob Data
  Contributor already contains it** — as do Data Reader and Data Owner. `Storage Blob Delegator` is the role you
  add when an identity's data access is scoped to a container/blob but it still needs the account-level
  delegation right; Stage A assigns Contributor at **account scope**, so the key is already mintable. (The two
  halves are independent and both required: the SAS's effective permission is the intersection of what the SAS
  says and what the signing identity may actually do — a Delegator-only identity mints keys whose SAS grants
  nothing.) If the assignment is ever narrowed to a container, add `Storage Blob Delegator` at account scope.
- **CORS: not needed by anything shipped here.** A `<audio>`/`<video>` load with no `crossorigin` attribute is a
  `no-cors` request, `Range` is CORS-safelisted for a simple byte range, and the element follows the cross-origin
  302 and seeks against Blob with no response header from us at all. The two `fetch()` callers that WOULD have
  needed it — the offline pin and the player's audio-only probe — never leave the origin, because they send
  `x-darth-media-via: app`. Add a rule only if that changes; the rule to add then is:
  `AllowedOrigins: https://meetings.darth-internal.trames.io`, `AllowedMethods: GET, HEAD`,
  `AllowedHeaders: Range, x-ms-*`, `ExposedHeaders: Content-Length, Content-Range, Content-Type, Accept-Ranges`,
  `MaxAgeInSeconds: 3600`.
- Blob `Content-Type` and `Content-Disposition: inline` are already written by Stage A (`archiveMedia`), which is
  what makes the redirect play: after a 302 the browser believes the BLOB's content type, not ours.

**Live proof on the VM once the account exists** (spec's "B" line, in order):

1. `DARTH_MEDIA_ACCOUNT` + `MW_MEDIA_ARCHIVE`, archive one meeting, confirm `blob_name` on its rows.
2. `MW_MEDIA_FROM_BLOB=1`, pm2 restart. `curl -sI -b <cookie> '…/audio'` → `302`, `Location` on the media
   account, `Cache-Control: private, no-store`. **Do not paste the Location anywhere** — it is a live credential
   for an hour.
3. Browser: play, seek forward and back, toggle the video on and off. Then leave it paused past the hour and
   press play — it must resume without a reload (the player re-requests the app URL once for a fresh SAS).
4. Phone (relay path): the same, on `?variant=audio`.
5. Service worker: pin a meeting at `video`, confirm in devtools that the pin requests were answered `200` by
   the app (not `302`) and that `CACHE_MEDIA` keys are unchanged from before the deploy; go offline and play.
6. `curl -H 'Authorization: Bearer dth_…' -sI '…/audio'` → `200`; add `?redirect=1` → `302`.
7. `pm2 logs meeting-whisperer --lines 2000 | grep -c 'sig='` → `0`.

**Two things to watch on that first live run**, neither reproducible without a real account:

- **Safari + service worker + a cross-origin media redirect.** Our SW intercepts every `/audio` request and, on a
  cache miss, passes it to `fetch(request)`; with Stage B the answer becomes an opaque cross-origin response.
  Chrome and Firefox hand that to the media element unchanged, Safari has historically been the weak one for
  Range-over-SW. If it misbehaves, the player already self-heals (second failure → `?via=app`, local bytes); the
  permanent fix would be to keep the SW out of the media path when nothing is cached.
- **Clock skew.** `darth-uploads.ts` backdates `startsOn` by 5 minutes, which is what makes a freshly minted SAS
  usable immediately; the effective window is therefore 65 minutes, not 60.

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

### Stage C as built — 2026-09-22

Inert until `MW_AAI_FROM_BLOB` is set AND both accounts are configured. Every upload that is not eligible — and
every failure on the way — falls back to the pull path with nothing changed: no blob written, no row touched, the
transit blob still there. That is why the transit blob is deleted **after the row exists** on this path rather
than after the copy as the sketch above said: the fallback needs those bytes.

| Piece | File |
|---|---|
| The gates, the plan (blob name + ids before the row exists), the server-side copy + verify, the 6 h SAS, the row, the background local copy, the re-archive after a faststart remux, the sweeper's retry | `src/lib/server/aai-from-blob.ts` |
| `copyFromUrl` on the `MediaBlobLike` seam (`Put Block From URL` × N + `Put Block List`), `copyBlockPlan` / `copyBlockId` | `src/lib/server/media-store.ts` (+ the fake) |
| `submitForIngest` / `createOrPromoteRow` / `attachSeriesForRow` — the two halves of the ingest made reusable without a local file; `ingestLocalAudio` keeps its exact shape and error ordering | `src/lib/server/ingest.ts` |
| `FinalizeHashes.fromBlob`, the one-line branch, and `BlobIngestFailed` rethrown before any cleanup | `src/lib/server/upload-pipeline.ts` |
| `tryAaiFromBlob` — the whole attempt, with the intent stamp before the copy, the transit delete on success and the clear on every exit | `src/app/api/uploads/[id]/complete/route.ts` |
| The intent itself: `BlobCopyIntent` on `UploadSpec`, `blobIntentOf`, the pure `abandonedBlobOf` rule | `src/lib/server/upload-pipeline.ts`, `src/lib/server/aai-from-blob.ts` |
| `stampUploadSessionBlobIntent` / `clearUploadSessionBlobIntent` (jsonb merge on `upload_sessions.spec` — no migration), `claimedMediaBlobNames` | `src/db-ops/upload-sessions.ts`, `src/db-ops/recordings.ts` |
| `sweepExpiredUploadSessions` + `queueAbandonedStageCBlobs` — the reaper queues an abandoned blob into `media_blob_deletes` | `src/lib/server/auto-notes-sweeper.ts` |
| DEC-4: "media we hold" = a local file that EXISTS or a blob-verified canonical | `src/lib/server/aai-retention.ts` |
| The `blobFirst` marker | `src/lib/format.ts` (`GmeetContext`) |
| The prep candidates skip a row whose bytes are still in flight; one retry fetch per tick | `src/lib/server/media-sweeper.ts` |
| `getRecordingMediaRow`, `clearMediaArchiveStamp` | `src/db-ops/recordings.ts` |
| `redactSasInText` | `src/lib/server/media-serve.ts` |
| `MW_SCRATCH_DIR` — the stitch works on the NVMe (item 2, below) | `src/lib/server/scratch-dir.ts`, `media-concat.ts`, `upload-pipeline.ts` |
| INFO, never drift: blob-before-local, and the Stage C counters | `scripts/recordings-verify.ts`, `scripts/media-archive-status.ts` |
| The tray's half: the live mix, its `qmx` label, and the declaration at open | `poc/mac-recorder/Sources/RecorderCore/LiveMix.swift`, `Recorder.swift`, `darth-tray/Uploader.swift` |
| `tracks` on the wire: `UploadTracks`, `parseUploadTracks`, the 400, the frozen spec | `src/lib/server/upload-pipeline.ts`, `src/app/api/uploads/route.ts` |
| `isMixTrack` / `MIX_TRACK_LANGUAGE`, and the skip that follows from it | `src/lib/server/multitrack.ts` |
| Tests | `src/lib/server/__tests__/aai-from-blob.test.ts` (24), `upload-group-progress.test.ts` (`parseUploadTracks`), `tmp/media-ingest/` (91-check scratch-PG integration, real ffmpeg, AssemblyAI stubbed) |

**The multitrack decision: a recorder upload takes the fast path only if it says track 0 is the mix.** Handing a
multi-track file to AssemblyAI as-is is the 2026-09-16 incident (a Slack huddle transcribed from the system track
alone — 484 words instead of 1429), and `normalizeMultiTrack` is what prevents it by re-muxing the file so the MIX
is track 0 *before* AssemblyAI hears it. Whether a file is multi-track cannot be known without probing the bytes,
and not having the bytes is the whole point of this stage. The tray is the only producer of such files and it
identifies itself on every upload (`recorderRecordingId` at open, or `gmeet_context.recorder`) — so it has to SAY
what its tracks are, and since **0.3.12 it does**: it writes the mix itself, live, as audio track 0 of every file
(`LiveMix.swift`, labelled with the local-use language `qmx` so `isMixTrack` recognises it) and declares
`tracks: {count, mixFirst: true}` at open. `blobFastPathRefusal` lets a recorder upload through on that promise
and refuses without it — an older tray, a recording whose mix could not hear every source, any client that says
nothing — exactly as before. The declaration is per FILE (from the tray's registry row, not from its version:
older recordings are still on that Mac), it is frozen on the session at open because Stage C runs at complete, and
`parseUploadTracks` answers 400 to a malformed one rather than silently dropping the promise.

Nothing on the VM then has to touch the audio: the stored file's track order is already what `normalizeMultiTrack`
would have produced, so the background local copy PROBES the landed bytes and skips the pass (`verifyMixFirst`,
logging `track 0 is the mix as declared — nothing to normalise`). That probe is also the only moment anyone can
check a client's promise: a file whose track 0 turns out NOT to be the mix is mixed down after all — the transcript
was already made from one track and cannot be helped, but the file people play, re-transcribe and cut clips from
can be — and the blob is re-archived to match, on a loud `DECLARED mixFirst but the landed file…` line.

**The blob-naming / adoption decision.** The blob is written at the name Stage A would choose —
`<recording id>/<media id><.ext>` — computed BEFORE the row exists, which is possible because every id involved is
deterministic:

- the recording is `rec:t<placeholder's transcripts.id>` and a MINTED promotion does not move that key
  (`canonicalKeyOf`), which is why `mintedIdsEnabled()` is a gate: without minting, the promotion renames the
  meeting to the job id, the canonical key becomes the job id and the blob would be at the wrong name;
- the canonical media is `media:<recording>:canonical:0`;
- the stored filename is `<minted meeting id>.<ext>`, so a file whose extension `audioFilename` cannot recover
  (`.bin`, which would have to be SNIFFED from the bytes) is refused rather than named differently from what the
  archive would later compute.

The STAMP is nevertheless the authority: `recording_media.blob_name` is a plain string and every reader (Stage B,
the delete paths, `--check-blobs`) goes through it, so if reality ever diverges from the prediction — the
stale-upload sweeper reaped the placeholder mid-flight and the row was inserted fresh — the stamp still names the
blob that exists and nothing is stranded. The deterministic name only buys `archiveMedia`'s adopt-by-name for the
case where the stamp itself was lost (a restart between the copy and the UPDATE).

**The one leak, and how it is closed (2026-09-22).** Stage C shipped with a window it could not fall back
from: `copyTransitToMedia` puts the bytes in the PERMANENT container and the row that names them
(`recording_media.blob_name`) is written afterwards, so a process death in between — a pm2 restart mid-ingest,
which leaves the session stuck at `completing` — left a blob nothing referred to, findable again only by listing
the whole container. The fix is an INTENT: before the copy the session records the name it is about to write
(`BlobCopyIntent` in `upload_sessions.spec.blobIntent`, an atomic jsonb merge — the column already exists, so no
migration), and Stage C clears it on every exit it survives (the row exists; the copy failed and took its blob
back out; AssemblyAI refused and the route deleted the blob). What is left stamped is by definition a session
that died mid-flight, so as the expired-session sweeper reaps it (`sweepExpiredUploadSessions`, 24 h for an
open/completing session, 7 days for a done/failed audit row) the intended blob goes into `media_blob_deletes` and
the media sweeper's drain deletes it with retries.

The rule has exactly one guard, and it is the one that matters: **an intent whose blob a live `recording_media`
row claims is never queued.** That is the crash-AFTER-the-row case — the row was created and only the clear never
ran — where deleting would destroy a meeting's only copy of itself. The question is asked of the database at
sweep time (`claimedMediaBlobNames`), never inferred from the session's status, because a promotion may have
moved the row the session remembers. If a stamp cannot be written at all the fast path is not taken: the pull
path is slower, not worse, and an un-recorded copy is the leak itself. Sessions that never went near Stage C —
every chunk session, every pull-path session — carry no intent and cost the sweeper not one query.

**Where the hash check moved.** The pull path verifies the client's sha256 by reading every byte. Stage C cannot:
the size is verified against the committed transit blob, the hash is written as blob metadata and *believed* until
the background fetch reads the bytes back and hashes them. A mismatch there is a loud `SHA MISMATCH` line; the file
and the blob are kept (they are what AssemblyAI is transcribing) and the row's + the blob's hashes are corrected to
what the bytes actually are. Only de-duplication ever cared about the claimed value.

**The faststart consequence, and why the blob is uploaded twice for a moov-last video.** The invariant everything
downstream leans on is "what a media row says about its blob is true of the file that row names". `ensureFaststart`
rewrites the canonical file in place, so after the local copy lands the first blob is no longer the file. The local
copy job therefore runs faststart itself, awaited, and on `remuxed` clears the stamp and lets `archiveMedia` put the
remuxed file up under the same name (`clearMediaArchiveStamp` refuses unless the row is still at the deterministic
name, so nothing can be stranded). Cost: for a moov-last video the bytes go up twice — once by Azure's own copy
engine (no VM egress) and once as an ordinary archive upload. The win is unchanged: AssemblyAI is never sent the
file, and the transcription starts before the VM has seen a byte.

**Item 2 is the scratch-dir change only** (the spec's "anything that must be manipulated first" keeps the pull
path in this stage, as the brief allowed). `MW_SCRATCH_DIR` unset is not a different default — it is literally the
old code path, the stitch written straight into the audio dir with no move. Set (`/temphigh/mw-scratch` on the VM)
each stitch gets `<root>/<group uuid>/` for its list file and its several-GB output, and the result is moved into
the audio dir with an EXDEV-safe move. An unusable scratch root logs once and falls back to the audio dir.

**What the owner must provision** (beyond Stage A's and B's):

- **Roles: nothing new, given Stage A's assignment.** The destination write is the VM identity's own (Storage Blob
  Data Contributor on the media account). The SOURCE of a cross-account `Put Block From URL` is authorised by a
  **SAS in the URL**, not by our identity — so the copy mints a 60-minute read SAS on the transit blob, which needs
  `generateUserDelegationKey` on `darthuploads`, and Storage Blob Data Contributor on that account (which the VM has
  had since the chat rollout) contains it. Nothing has to be granted for the copy that is not already true. If
  either assignment is ever narrowed to a container, add `Storage Blob Delegator` at account scope on that account.
- **CORS: not needed.** Every party to the copy is server-side (Azure ↔ Azure), and AssemblyAI fetches the SAS URL
  from its own backend.
- The 6 h SAS is the only credential that leaves the VM on this path, and it goes to AssemblyAI alone.

**Live proof on the VM once the account exists** (the spec's "C" line):

1. `MW_MEDIA_ARCHIVE` on and archiving healthy (`media-archive-status` says CANARY OK), `MW_MINTED_IDS=1`,
   `MW_RECORDINGS_WRITE=1`.
2. `MW_AAI_FROM_BLOB=1`, pm2 restart. Upload a short recording from the WEB dialog (not the tray — the tray takes
   the pull path by design).
3. `pm2 logs meeting-whisperer` shows `[aai-from-blob] <session>: N B copied to <blob> in … ms (server-side)` and
   `[aai-from-blob] <meeting>: job <id> reads <blob>`; it must NOT show an AssemblyAI upload for that row.
4. Watch the VM's outbound bytes while the copy runs (`nload`/`ifstat`): ≈ 0 for the copy, then one DOWNLOAD of the
   recording when the background fetch runs, then — for a moov-last video only — one upload of the remuxed file.
5. `SELECT gmeet_context->'blobFirst' FROM transcripts WHERE assemblyai_id = '<meeting>'` → `landedAt` set within a
   couple of minutes; the file is in `storage/audio/`; `recording_media` has `blob_name` + `sha256` + `bytes`.
6. `scripts/media-archive-status.ts` prints `blob before local : … 0 still waiting`.
7. `pm2 logs meeting-whisperer --lines 2000 | grep -c 'sig='` → `0`.
8. Play the meeting (with Stage B on) and confirm the redirect serves the FASTSTART bytes — i.e. seeking on a phone
   is instant, which is what the re-archive is for.

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

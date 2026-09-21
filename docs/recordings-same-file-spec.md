# The same file is never transcribed twice by accident — build spec (Phase 2c)

Status: **server + tray + web client BUILT**, 2026-09-22 (the web dialog UI is still to come —
see *The contract the dialog builds against* at the end). Needs Phase 1 (`MW_RECORDINGS_WRITE`,
migration 044). Flag: `MW_SAME_FILE_CHECK`.

## Why
Prod has 18 (filename, owner) groups uploaded 2–4 times, and the 2026-09-17 podcast that was sent to AssemblyAI
twice (9,649 s billed for 4,182 s of audio). Nothing compares bytes today: `upload_sessions.fingerprint` only
de-duplicates an *open* session.

## Rule
At upload time, if the **same owner** already has a live (not permanently deleted) recording with the same bytes,
say so before spending anything, and let them decide. Never automatic refusal, never silent.

**Privacy (absolute): the lookup is owner-scoped.** A match against another user's recording must be
indistinguishable from "no match" — the hash of a file is a fingerprint of its content, and "someone else already
uploaded this" is a leak. Shared meetings do not widen it.

## Where the hash comes from
- Blob-transit uploads (tray, large web uploads, darth-cli): the client already sends `sha256` at open and the pull
  verifies it. Known BEFORE any bytes move → the check runs at **open**.
- Chunk-path uploads: no whole-file hash exists. Compute it while finalizing (stream the temp file once;
  ~1 s/GB on the VM) → the check runs at **complete**, before the AssemblyAI hand-off — the bytes are already on the
  VM, so what is saved is the transcription, not the upload. The web client may additionally send a `sha256` at
  open when the file is small enough to hash in the browser quickly (≤ 200 MB, `crypto.subtle`), which moves the
  check to open for the common case.
- Multi-part groups (tray share flips, stitched uploads): each part has its own hash; the recording's identity is
  `sha256(part hashes joined by '\n', in order)` — store it as the recording's `sha256` and each part's on its
  `recording_media` row (`kind='part'`). A group matches when that combined hash matches.

## Storage
`recordings.sha256` (exists, 044) — written at ingest from the verified upload hash.
`gmeet_context.upload.sha256` on the meeting row as the dual-write mirror while the row is the source of truth.
The recording-graph sync treats `sha256` as not-derived (it already never overwrites it).
~~and later confirmed by the media archive, which computes the same value for single files~~ — **wrong, see
*As built* below**: the archive hashes the file as it is on disk, which a faststart remux has already rewritten.
It may only fill a NULL.

## Wire
`POST /api/uploads` (open) and `POST /api/uploads/:id/complete` gain one possible answer, **HTTP 200**:
```json
{ "duplicate": { "meetingId": "…", "title": "…", "when": "2026-09-17T01:55:00Z", "status": "completed",
                 "durationSec": 4182, "trashed": false } }
```
with nothing created (open) / the session kept open and nothing submitted (complete). Re-send with `"force": true`
to go ahead. A match whose only meetings are in the trash still reports (with `trashed: true`) — restoring is cheaper
than re-transcribing. A match on a recording whose transcription FAILED does not block (re-sending is the point).
Old clients that do not understand `duplicate`: the tray and darth-cli are version-gated — the server only answers
`duplicate` when the request says it understands it (`"dupAware": true` in the open body); otherwise today's behaviour.

## Clients
- **Web upload dialog**: "You already have this recording — *Title* · Wed 17 Sep · 1h 09m" with **Open it** /
  **Upload anyway**; for a trashed match **Restore it**. No filename-as-title.
- **Tray**: a duplicate at open means the recording is already up — mark it `uploaded` with that meeting id, show the
  normal "Uploaded · Open transcript" card. No prompt.
- **darth-cli** (other repo — report the exact change needed, do not edit): print the match and exit 0 with the
  existing id; `--force` to upload anyway.

## Verification
Unit: combined-hash rule, owner scoping, trashed/failed cases, dupAware gating. Scratch Postgres: same file twice
(blob path → refused at open; chunk path → refused at complete, nothing submitted, stub AssemblyAI never called),
other user same file → no match, force → second meeting on its own recording, group re-upload. `bun test`, `tsc`,
`eslint`, env-less build.

## As built — 2026-09-22

Three gates, all lazy, ALL required, and a fourth on the request itself:
`MW_SAME_FILE_CHECK` + `MW_RECORDINGS_WRITE` + migration 044 present (probed once, cached,
`db-ops/same-file.ts` — the `db-ops/aai-job-id.ts` pattern), and `dupAware: true` in the body.
With any one of them off the upload path is byte-for-byte what it was.

| Piece | File |
|---|---|
| The rules + the wire types (pure: no db, no fs, no `node:`) | `src/lib/same-file.ts` |
| The ONE owner-scoped lookup + the 044 probe | `src/db-ops/same-file.ts` |
| Gates, the check, the temp-file hash, the identity of one part, the stamp | `src/lib/server/same-file.ts` |
| Check at OPEN | `src/app/api/uploads/route.ts` |
| Check at COMPLETE (both byte paths) | `src/app/api/uploads/[id]/complete/route.ts` |
| Part hashes on the group row, the group identity, the stamps | `src/lib/server/upload-pipeline.ts` |
| Browser: `dupAware`, the ≤ 200 MB hash, `force`, the typed outcome | `src/lib/chunked-upload.ts` (`uploadFileChunkedAware`) |
| Tray | `poc/mac-recorder/Sources/darth-tray/Uploader.swift` (0.3.11) |
| Tests | `src/lib/__tests__/same-file.test.ts`, `src/lib/server/__tests__/same-file-gate.test.ts`, `tmp/same-file/` (scratch Postgres, two users, AAI stubbed) |

**Where each upload is checked.** Blob transit (tray, big web uploads, darth-cli): at OPEN, the
hash is in the body. Web uploads ≤ 200 MB: at OPEN too — the client hashes the file in its Web
Worker, or, with no worker, in 2 MiB slices with an `await` between them so the tab keeps
breathing. Everything else: at COMPLETE, from the temp file, before the AssemblyAI hand-off.
Groups: at OPEN of part 1 when the client declared `multi.partSha256` (the tray always does),
otherwise at the LAST part's complete, assembled from `uploadGroup.parts[i].sha256`.

**`recordings.sha256` — who writes it, and why the archive lost the argument.** Two writers
wanted that column and they do NOT compute the same value. The upload pipeline stamps the hash
of the bytes the USER handed us; the media archive hashes the file as it is ON DISK at archive
time, which for a video is the faststart-remuxed copy (`prepareMediaForPlayback` rewrites it in
place) and for a stitched group is an ffmpeg concat. Only the first can ever be reproduced by
the user's own file, so:

- the upload pipeline's value is authoritative (`setRecordingUploadSha256`, overwrites);
- the archive may only FILL a NULL (`setRecordingSha256`, `WHERE sha256 IS NULL`) — that is what
  still gives Meet/Teams imports and backfilled rows a hash;
- a DERIVED canonical (`source_ref.derived = 'concat'`) is skipped by the archive entirely: its
  hash is nobody's file. The group's identity is the combined hash instead, and each part's own
  hash sits on its `recording_media` (`kind='part'`) row — the only record left once the stitch
  has eaten the temp files.
- the per-file, Azure-verified hash keeps living on `recording_media.sha256`, unchanged.

Without that rule de-duplication would silently stop working for every video the moment it was
archived.

**Privacy.** `db-ops/same-file.ts` has exactly one query, it takes the owner id as its first
argument, and `owner_user_id = $owner` is in the WHERE clause, on the partial index
`recordings (owner_user_id, sha256)`. There is no cross-owner variant and there must never be
one. Measured on the scratch cluster (200 interleaved pairs): a hash another user owns and a
hash nobody owns take the same lookup to within 2 % (0.071 ms vs 0.069 ms), and the whole open
call to within 2 % (0.55 ms vs 0.56 ms) — and the 201 reply is field-for-field identical.

## The contract the dialog builds against

```ts
import { uploadFileChunkedAware, type UploadOutcome } from '@/lib/chunked-upload';
import type { DuplicateMatch } from '@/lib/same-file';

const out = await uploadFileChunkedAware(file, params, hooks);
if (out.kind === 'duplicate') {
  // NOTHING was created: no row in the listing, no session, no bytes moved.
  const m: DuplicateMatch = out.duplicate;
  // m.meetingId  → /transcript/<id> ("Open it"), /m/<uuid> works too
  // m.title      → the meeting's title; may be null — never fall back to the filename
  // m.when       → ISO, recorded_at else created_at ("Wed 17 Sep")
  // m.status     → 'completed' | 'processing' | 'queued' | …
  // m.durationSec→ number | null ("1h 09m")
  // m.trashed    → true ⇒ offer "Restore it" instead of "Open it"
} else {
  out.transcript; // exactly what uploadFileChunked has always returned
}
// "Upload anyway" = call again with { ...params, force: true }.
```

`uploadFileChunked` (the old entry point) never sends `dupAware`, so it can never receive a
duplicate and needs no change; components keep working untouched. A multi-file stitch upload may
pass `params.multi.partSha256` (every part, in order, on index 1) to be answered before any byte
moves — optional, and without it the group is answered at the last part's complete.

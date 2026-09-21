# darth uploads in meetings — Azure Blob transit for big uploads

Lifted from `../chat` (E8c-7, chat SPEC §20.23 (b) / §20.27, shipped there
2026-09-17) into meetings on 2026-09-18. Chat's `docs/darth-uploads.md` is
the account-level reference (access model, provisioning, the seam); this
page is what meetings did with it and where it deviates.

## Why

Every user reaches .6 through the Singapore Tailscale subnet router. Phones
are relay-only, one WireGuard stream over ~170 ms RTT, and a multi-hundred-MB
body through nginx + Next is one stall away from a 408. On 2026-09-18 Alok's
own Darth Recorder tray hit exactly that on the laptop: a 1.3 GB Meet
recording and a 638 MB Teams recording failed with HTTP 408 on every retry
for hours — nginx allows 900 s per body on this site, the bytes simply did
not arrive fast enough through the tunnel.

The fix takes Tailscale and nginx out of the byte path: the browser uploads
straight to Azure Blob (account `darthuploads`, container `meetings`,
southeastasia = the VM's region) in parallel 4 MiB blocks with a per-blob
user-delegation SAS the app mints, natively resumable from the uncommitted
block list Azure keeps; then .6 pulls the committed blob ONCE over the Azure
backbone into the same temp file the chunk path writes, and the shared
finalize tail (`upload-pipeline.ts`) runs unchanged.

## What meetings built (the deviation from chat)

Chat added a separate ticket route family. Meetings already had a resumable
chunked-upload SESSION (`upload_sessions`, migration 037: same user + same
fingerprint → the same open session), so here the blob transit is a
**byte-delivery mode of that session** — `upload_sessions.via = 'blob'`
(migration 043) — not a second state machine:

| Step | chunks (unchanged) | blob |
|---|---|---|
| open `POST /api/uploads` | placeholder row + empty temp file + chunk plan | placeholder row + a **blob ticket** `{sasUrl, blobName, blockBytes, parallel, expiresAt}`; the client asked with `via: 'blob'` + `sha256` (whole file) + `coarse?` |
| bytes | `PUT /api/uploads/:id/chunks/:idx` through nginx | `Put Block` × N straight to the SAS URL, `Put Block List` to commit (`src/lib/blob-blocks.ts`) |
| resume | re-open → `received[]` from `upload_chunks` | re-open → the SAME blob (name `<userId>/<sessionId>/<name>`) with a fresh SAS; the client asks Azure for the uncommitted block list |
| complete `POST /api/uploads/:id/complete` | all chunks in → finalize | blob committed? (else 409 `{notCommitted}`) → claim → **pull** into the temp file, sha256 + size verified → delete the blob → the same finalize |
| abort `DELETE /api/uploads/:id` | temp file + placeholder | + the blob |
| sweeper (24 h idle) | temp file + placeholder + session | + the blob |

Rules:

- The server decides. `via: 'blob'` is granted only when the host has
  `DARTH_UPLOADS_ACCOUNT` set **and** the file is ≥ `UPLOAD_BLOB_MIN_BYTES`
  (8 MiB). Otherwise the reply says `via: 'chunks'` and the client takes the
  chunk path — no 503 dance, no client-side memory of availability.
- The whole-file **sha256 is required** for a blob session (the browser
  hashes in a Web Worker before opening — `src/lib/sha256.ts`, "Preparing —
  reading the file… N%"). The VM verifies it during the pull; a mismatch
  deletes the blob, abandons the placeholder and answers 410 — the client
  starts over. A browser without workers silently takes the chunk path.
- A resumed blob session must present the same sha256 (a different file
  under the same fingerprint retires the old session, as before).
- Chunk PUTs against a blob session are 409 `{via:'blob'}`.
- The pull's transient failures (Azure hiccup) answer 503 and REOPEN the
  session; the client repeats the complete after a pause. Size mismatch,
  hash mismatch and a host that lost its store config are terminal (410).
- Progress: block acks (4 MiB granularity) drive the bar; the pull writes the
  placeholder's byte progress every 1.5 s so the listing keeps moving and the
  stale-upload sweeper stays off the row.
- `recorderRecordingId` (the caller's own Darth Recorder registry row) is
  accepted on the open call too now, so the tray / darth-cli can move to this
  path without the one-shot route's header.

## Files

| Piece | File |
|---|---|
| Shared constants + pure Blob REST helpers (client + server) | `src/lib/darth-uploads-shared.ts` |
| Streaming SHA-256 worker (lifted verbatim) | `src/lib/sha256.ts` |
| Azure store, tickets, hash-verified pull (lifted verbatim; only the imports + the session-keyed blob name differ) | `src/lib/server/darth-uploads.ts` |
| REST fake store for an E2E on the laptop (`DARTH_UPLOADS_FAKE_URL`, loopback only) | `src/lib/server/darth-uploads-rest.ts` |
| The process-wide store singleton, ticket minting, pull-to-temp | `src/lib/server/darth-uploads-store.ts` |
| Browser block uploader with resume (fetch-only, bun-testable) | `src/lib/blob-blocks.ts` |
| The one browser entry point, chunk OR blob | `src/lib/chunked-upload.ts` (`uploadFileChunked`) |
| Routes | `src/app/api/uploads/route.ts`, `[id]/route.ts`, `[id]/complete/route.ts`, `[id]/chunks/[idx]/route.ts` |
| Migration | `migrations/043_upload_blob_transit.sql` |
| Tests | `src/lib/__tests__/{darth-uploads-shared,sha256,blob-blocks}.test.ts`, `src/lib/server/__tests__/darth-uploads.test.ts` (+ `helpers/fake-blob*.ts`) |
| Live E2E (real account, kill/resume) | `tmp/e2e-blob-upload.ts` |

## Config (names only, never a key)

`.env.local` on the VM:

```
DARTH_UPLOADS_ACCOUNT=darthuploads
DARTH_UPLOADS_CONTAINER=meetings
```

The account has `allowSharedKeyAccess=false` and no public access; the VM
`darth-p01`'s managed identity holds Storage Blob Data Contributor on the
whole account (the SAS is signed with a user-delegation key from an IMDS
token). CORS for `https://meetings.darth-internal.trames.io` is set on the
account (management-plane PUT, done during the chat rollout). Blobs live
≤ 1 day by the lifecycle rule; the app deletes each one right after the pull.

Unset on a laptop → the chunk path for every size, as before.

## Still on the chunk path

- **darth-cli** `meetings upload` (one-shot `POST /api/transcripts`).
- **Darth Recorder tray** (one-shot too — the client that actually 408'd).
  Both should move to `POST /api/uploads` with `via: 'blob'`; the server side
  is ready (the hash is a one-liner in Node and Swift).

## As built 2026-09-21 — one meeting, one row, and honest progress

Server half of `docs/recorder-upload-ux.md` (§1 P1/P2, §2.1–2.3). Nothing here
is Recorder-only: every client of `POST /api/uploads` gets it.

- **Auto-link at open (P1).** `recorderRecordingId` with no `linkedEvent` /
  `eventRef`: the route reads the caller's own registry row and, when
  `recorderMatchIsConfident(matched)` (`event_key` present, `score ≥ 0.6`,
  `overlap ≥ 0.5` — the ONE threshold, `src/lib/server/upload-pipeline.ts`),
  resolves it with `resolveLinkedEventRef` and opens the placeholder linked:
  title, date, attendees, auto-share, and the calendar row folds from the
  first byte. Logged `[uploads] auto-linked <id> → <event_key> (score …,
  overlap …)`. A resolver failure warns and continues unlinked — never a 4xx.
  Only part 1 of a group asks (later parts land on its row).
- **`multi.groupBytes`** (optional, integer, ≥ this part's size): the whole
  recording's size, declared once. Stored as `uploadGroup.bytesTotal` and as
  the group row's `upload_bytes_total`. Present-but-invalid is a 400.
- **`gmeet_context.recorder = { recordingId }`** is stamped on the placeholder
  at open whenever `recorderRecordingId` was given.
- **Group-relative progress (P2).** Every `upload_bytes_received` write for a
  group session is Σ bytes of the parts already landed + the part in flight
  (`groupBytesBefore` / `groupProgressBytes`, `groupProgressAdder` for the
  byte-delivery routes): chunk PUT, the blob pull's `onProgress`, and the
  part-landed write in `finalizeUpload`. Once every part has landed the value
  IS the declared total, so the row flips to "upload received — handing
  off…". Older clients (no `groupBytes`) keep whatever total they had.
  A part's own byte count is stamped on `uploadGroup.parts[i].bytes`
  atomically (`setUploadPartBytesForUser` — parts finalize in parallel).
  Single-file uploads are byte-for-byte unchanged.
- **Listing v2 only** (`?v=2`; the legacy shape stays byte-compatible for
  darth-cli): `upload_parts_done`, `upload_parts_total`,
  `recorder_recording_id`, straight off `gmeet_context` inside the
  materialized base CTE.
- Tests: `src/lib/server/__tests__/upload-group-progress.test.ts`.

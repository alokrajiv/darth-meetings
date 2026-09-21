# The same file is never transcribed twice by accident — build spec (Phase 2c)

Status: **build brief**, 2026-09-22. Needs Phase 1 (`MW_RECORDINGS_WRITE`, migration 044). Flag: `MW_SAME_FILE_CHECK`.

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
`recordings.sha256` (exists, 044) — written at ingest from the verified upload hash (and later confirmed by the media
archive, which computes the same value for single files). `gmeet_context.upload.sha256` on the meeting row as the
dual-write mirror while the row is the source of truth. The recording-graph sync treats `sha256` as not-derived
(it already never overwrites it).

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

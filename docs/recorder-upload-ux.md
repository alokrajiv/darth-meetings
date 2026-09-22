# Darth Recorder uploads — the experience, designed (2026-09-21)

Status: **design + build brief.** Written against main `bc58e59` after the 2026-09-21 11:47 SGT upload
(recording `d6064761`, transcript `3cac32fd`). Every number below comes from `recorder_recordings`,
`upload_sessions`, `transcripts` (read-only, `meeting_whisperer_prod`, 12:10 SGT) or `~/Library/Logs/DarthRecorder/tray.log`.

## 0. What Alok saw, and why

| Time (SGT) | What happened | What the UI said |
|---|---|---|
| 11:02:54 → 11:47:26 | Recorded the Meet "Alok <> Paola - Post SG - PPT Review": 44 m 31 s, 696 MB, **6 segments** (the share detector rolls a new segment on every share start/stop: Meet window → display → PowerPoint window → Meet → PowerPoint → Meet). Matched to the calendar event with score **1.0** at the first PATCH. | Recording pill. |
| 11:47:26 | Auto-upload: 6 sessions via blob, 100 s wall clock (part 2 = 238 MB in 11 s; part 6 took 57 s because `complete` stitches + hands off to AAI). | Tray: "Recording saved (44m 31s, 6 parts) — Uploading to Darth Meetings…" for **12 s**, then nothing. Menu: nothing. |
| 11:47:26 → 11:49:06 | Placeholder row `up-16164df6` titled by **part 1's filename**; `upload_bytes_total` = part 1's size (16.2 MB); `upload_bytes_received` overwritten by each later part. | Listing: "uploading — 77% · 12.1 MB of 15 MB" for a 696 MB upload. |
| 11:49:06 | Transcript `3cac32fd` created **unlinked**: auto-upload never sends `linkedEvent`, and the server ignores `recorder_recordings.matched` at open. | Listing: TWO rows for one meeting — the calendar row ("Recorded on your Mac (44m 31s) · uploaded · Open transcript" + Check…) and the upload row ("2026-09-21 11.02.54 meet part1.mp4", chip "6", "transcribing…"). |
| — | To upload for a calendar event whose row shows Check…, the only path is the hover-only gear → "Upload a recording for this meeting…" (`canUpload` requires `!canCheck`). | "I have to click a settings icon." |
| — | The upload dialog's "…or from Darth Recorder on this Mac" mounts `RecorderRecordings` with `limit=0` inside a `DialogContent` with no max-height: all 50 registry rows, oldest first, uploaded ones included. | "A huge list appears and it is not scrollable." |

Fixed by hand at 12:05 SGT: `darth-cli meetings link 3cac32fd… "1skk87fohtb2hnr607lq51rekj|2026-09-21T11:00:00+08:00"` — the two rows are one now (title, date, attendees, speaker re-guess).

## 1. Principles

- **P1 One meeting, one row, from the first byte.** The server already knows which event a Recorder recording belongs to (`matched`, scored on every write). A confident match (score ≥ 0.6 and overlap ≥ 0.5) is applied at upload open: the placeholder is born with the event's title, date, attendees and auto-shares — the calendar row folds immediately. Weak matches stay unlinked and keep today's "link the calendar event" path. Server-side, so the tray, darth-cli and older trays all get it; the tray does not carry a second threshold.
- **P2 Progress is about the recording, never a session.** A multi-part upload declares its total bytes once (`multi.groupBytes`); every progress write is "bytes of the whole recording received". The listing line is "part 3 of 6 · 298 MB of 696 MB". The web never renders a number it cannot explain.
- **P3 The tray owns the bytes, so the tray shows the state.** Menu-bar icon (uploading badge), a live menu line, and the saved card as a live progress card that ends in **Open** (the transcript URL) or **Retry now**. Nothing auto-hides while bytes are moving; the card is dismissible, the menu line is not.
- **P4 Every terminal state reaches the server AND the person.** (Server half is already a rule from 0.3.7.)
- **P5 The upload picker is for uploading.** Newest first, uploaded rows folded away behind a count, the row that matches the dialog's event pinned on top, and the list scrolls inside the dialog.

## 2. Contracts

### 2.1 `POST /api/uploads` (open)
- `recorderRecordingId` present, no `linkedEvent` / `eventRef` → server reads the caller's own recorder row; if `matched.score ≥ 0.6 && matched.overlap ≥ 0.5 && matched.event_key` → `resolveLinkedEventRef(userId, matched.event_key)` becomes the linked event (full attendees). Logged `[uploads] auto-linked <recorderId> → <event_key> (score …)`. Resolver failure → unlinked, never a 4xx.
- `multi.groupBytes` (optional int, sum of all parts' sizes, ≥ size): on index 1 stored as `uploadGroup.bytesTotal` and as the placeholder's `upload_bytes_total`.
- The placeholder's `gmeet_context.recorder = { recordingId }` when `recorderRecordingId` was given (both single-file and group branches).

### 2.2 Progress writes
`upload_bytes_received` for a group row = Σ bytes of parts already landed (`uploadGroup.parts[].bytes`) + bytes of the part in flight. Applies to the chunk PUT path, the blob pull (`complete` route `onProgress`) and the part-landed write in `finalizeUpload`. A single-file upload is unchanged.

### 2.3 Listing v2 rows (`?v=2` only — the legacy shape is byte-compat for darth-cli and must not change)
`upload_parts_done` (parts landed), `upload_parts_total`, `recorder_recording_id` — see `TranscriptListRow` in `src/lib/format.ts`.

### 2.4 Companion websocket (`upload_progress`, tray 0.3.9+)
`{type:"upload_progress", recording_id, segment, segments_total, bytes_sent, bytes_total, pct, title?}` — throttled to ≥ 500 ms between broadcasts per recording (the 0.2.x tray sent ~40 in 3 s). `upload_done` gains `bytes_total`, `seconds`; `upload_failed` unchanged. Older trays omit the new fields; the web treats them as unknown.

## 3. Tray 0.3.9 — what the person sees

| Moment | Icon | Menu (line under the status line) | Banner |
|---|---|---|---|
| Upload starts | waveform + small up-arrow badge (discreet → plain) | `Uploading “Alok <> Paola – Post SG…” · 0% · 0 B of 696 MB · part 1 of 6` (disabled) | "Recording saved (44m 31s, 6 parts)" / "Uploading to Darth Meetings — 0% · 0 B of 696 MB" — **no auto-hide**; buttons **Show file** / **OK** (OK hides the card only) |
| Progress | same | same line, updated ≤ 2×/s | sub line updates in place |
| Done | plain | `Uploaded “…” — transcribing · Open transcript` (enabled → `PWA_URL/transcript/<id>`), kept for 10 min or until the next upload | "Uploaded — transcribing now" / "“Alok <> Paola – Post SG – PPT Review” · 44m 31s · 696 MB in 1m 40s"; **Open** / OK; auto-hide 20 s |
| Failed | plain | `Upload failed “…” — Retry now` (enabled → `uploader.upload`) | "Upload failed — retrying in 30 min" / the error; **Retry now** / OK; no auto-hide |
| Not signed in | — | unchanged | unchanged (sign-in card) |

Title = `matched.title` → `call.title` → the started-at date. Several uploads at once: the line shows the newest; the others stay in the registry ("Upload N recordings now" is unchanged).

## 4. Web — what changes

- **Listing row (uploading):** `uploading from your Mac — part 3 of 6 · 298 MB of 696 MB` when `recorder_recording_id` is set (else `uploading — 43% · … of …` as today, but with the group totals so the numbers are true). When the companion socket holds live progress for that `recorder_recording_id`, the live numbers win (`… · 43% live`). "6" recordings chip on a Recorder upload: tooltip says "6 segments of one recording (the recorder rolled a segment on every screen-share change)".
- **Calendar row (No recording layer):** `Upload…` is visible whenever the row has an `eventId`, next to `Check…` — the gear keeps its copy.
- **Upload dialog picker:** newest first; uploaded/deleted rows hidden behind "Show N uploaded"; the row whose `matched.event_id` equals the dialog's event is pinned first with a "this meeting" chip; `max-h-[40vh] overflow-y-auto`; first 8 rows + "Show all"; `DialogContent` gets `max-h-[88vh] overflow-y-auto` as a belt. Settings › Darth Recorder keeps its 6-row list but sorts the same way.
- **Companion client:** `CompanionUploadState` gains `bytesSent`, `bytesTotal`, `segmentsTotal`; `recordingStatusLabel` renders "Uploading 43% · 298 MB of 696 MB · part 3 of 6".

## 5. Not in this pass (written down so it is not lost)

- **D-B** in `docs/recordings-first-class-design.md` (Recorder uploads land as bare recordings, no AAI until claimed) — Alok's decision, untouched; P1 is compatible with it.
- Live progress PATCHed to the server so a *phone* sees percentages during a blob upload (the server only sees bytes at `complete`); today it sees "part N of M".
- Fewer segments per share flip (a re-share of the same window within seconds could reuse the segment).

## 6. Mixed parts in one group — the stitch (added 2026-09-22)

Tray 0.3.15 lets a person give an audio-only recording a video source mid-call, so a group's parts
are no longer all of one kind: `part1.m4a · part2.mp4 · part3.m4a · part4.mp4` is a normal upload now.

What that costs the server side: `concatMediaSmart` sees the differing stream signatures, skips the
`-c copy` fast path (right) and re-encodes — and the re-encode branch used to decide `v=0`/`v=1` on
`allVideo`, so ONE audio-only part made the whole stitch audio-only, named `.m4a`. ffmpeg exited 0,
the log printed the usual "(re-encoded — mixed codecs)", the transcript was correct (track 0 is the
live mix) and the screen the person had deliberately added never reached the meeting. Found
2026-09-22 19:05 SGT by the tray builder, verified end to end.

`src/lib/server/media-concat.ts` now decides on `anyVideo`:

- **Audio-only spans get black video.** `-f lavfi -t <probed duration> -i color=c=black:s=WxH:r=FPS`
  per audio-only part, W×H×FPS taken from the first video part; every video leg is normalised
  (`scale`+`pad`+`setsar=1`+`fps`) so the concat filter accepts the segments. Output is `.mp4`.
  One log line: `[concat] mixed parts: N audio-only, M video — black video synthesised for the
  audio-only span(s)`. If an audio-only part's duration is unreadable the picture still has to go,
  and that now says so loudly instead of hiding in the generic line.
- **Every audio track is carried, in order.** The old graph mapped `[i:a:0]` only — it dropped the
  mic track of any file whose mix is not track 0. Each part's track *t* stays track *t* of the
  output (what `tracks.mixFirst` and `normalizeMultiTrack` both depend on); a part with fewer
  tracks than the widest one is padded with silence rather than shortening the set. Legs go through
  `aresample=48000` + `aformat=…:channel_layouts=stereo`, so the mix stays the widest-and-first
  track that ffmpeg's automatic selection picks.
- **The fast path names its container from the SET**, not from `filenames[0]`: an audio-first group
  whose later parts carry a window is `.mp4`, not `.m4a`.

Covered by `src/lib/server/__tests__/media-concat-mixed.test.ts` — real ffmpeg on 2 s lavfi inputs,
skipped when ffmpeg is not on PATH.

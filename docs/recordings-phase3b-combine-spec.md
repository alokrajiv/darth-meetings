# First-class recordings — Phase 3b: several recordings, one meeting

Status: **build brief**, 2026-09-22. Needs Phase 3a (clips, `MW_CLIPS`) and everything under it. Flag: `MW_COMBINE`.
Decisions: `docs/recordings-first-class-design.md` §2.4/§2.5 (overlap policies, the offset guesser), §5 D-E/D-F, §7.

## What this is for
Two DIFFERENT captures of one meeting: the SI-BL day (Teams video with a dead-audio stretch + two phone clips —
merged by hand in `tmp/sibl-merge/`), a laptop recording plus a phone that caught the corridor conversation, a
Meet recording that stopped and a tray recording that ran on. The recordings stay what they are (own file, own
transcription, own speaker space — DEC-1); the MEETING lists more than one clip, each on a different recording, placed
on one timeline. No file is cut or concatenated (DEC-2). This is the only case where speaker labels get the
`<recordingId>:<label>` prefix that `resolveClips()` already implements.

Not this phase: transcribing a recording that has none (that is an ordinary upload or "Transcribe again").

## Model (nothing new in the tables)
`meeting_clips` already carries `recording_id`, `offset_ms`, `text_policy`. Combine = add a clip
`(R2, from, to, offset, policy)` to a meeting that already has a clip on R1. `materialiseMeeting` (3a) writes the
merged payload: timeline order, prefixed labels, `include` / `gap_fill` / `exclude` per `resolveClips`. Speaker
names: `speaker_mappings` rows are per meeting and keyed by label, so the prefixed labels get their own entries;
voiceprint suggestions run per recording and land under the prefixed label (the same person on two mics becomes one
name after the user confirms both — a later "same person" merge is out of scope).
`recordings.sha256` etc. untouched. `local_audio_path` stays R1's canonical (the player's default part); the
resolver's `media[]` already lists every recording's file as a part with its `offsetMs`.

## The offset — never guessed silently
`POST /api/recordings/:id/align { against: <recordingId>, nominalOffsetMs?, searchWindowMs? }` → `{ offsetMs,
confidence, driftPpm, method }`. Implementation = the envelope cross-correlation from `tmp/sibl-merge/analyze.py`
(100 Hz log-RMS envelopes of the audio-only derivatives, FFT cross-correlation, ±120 s around the nominal), run as a
job in the voiceprint sidecar (port 3004, same deployment shape, python already there) on the VM's audio-only
files; nominal from `recordings.started_at` when both are known (tray `started_at`, Meet recording start, phone
`creation_time − duration`), else the caller's number, else 0 with a ±30 min window. Caller-scoped: both recordings
must be reachable through a meeting the caller can EDIT. The result is shown, never applied: the UI draws the two
envelopes overlaid at the proposed offset with a nudge control; "Use this offset" is the person's click.
Confidence < 0.4 says "could not line these up — set the offset by ear".

## API
- `POST /api/transcripts/:id/clips` `{ recordingId | uploadSessionId?, fromMs?, toMs?, offsetMs, textPolicy }` →
  `201 ClipsResponse`. The recording comes from (a) another meeting the caller can EDIT (its canonical recording),
  (b) an unlinked recording of the caller's (Recordings tab), (c) a fresh upload made with `?attachTo=<meeting id>`
  — the upload runs as today (own recording, own transcription) and, on completion, is added as a clip with the
  offset the user set in the upload dialog (stored on the placeholder). Refusals: recording not transcribed yet
  (`processing`) unless policy is `exclude` (playable now, text later — materialise again on completion), same
  recording twice, a recording whose owner is not the meeting's owner AND who did not explicitly share it (see
  privacy), > 6 clips.
- `PATCH /api/transcripts/:id/clips/:ord` `{ offsetMs?, textPolicy?, fromMs?, toMs? }` and `DELETE …/clips/:ord`
  (never the last clip; deleting a clip does not delete the recording — it just stops being in this meeting).
- `POST /api/recordings/:id/align` as above.
- `ClipsResponse` (3a) already lists clips with recording ids; add per clip `{ transcribed, durationMs,
  sourceLabel }` ("Teams recording", "Recorded on Atira's phone", "Upload · corridor.m4a" — the recording-strip
  vocabulary, never a bare filename as a title).

## Privacy
A recording's bytes belong to its owner. Adding someone ELSE's recording to a meeting is allowed only when that
recording's owner is an editor of the meeting AND performs the add themselves (they are giving the bytes to this
meeting's readers). An editor may add their own recordings freely. The clip list names the recording's owner.
Every list of candidate recordings is caller-scoped (own unlinked recordings; recordings of meetings the caller can
edit). `scopeMediaToRow` (Phase 1) currently gives a row no media unless it has its own `local_audio_path` — extend
it: media of a clip's recording is served when the CLIP exists on the meeting (the add is the consent).

## Reader and writer changes
- `materialiseMeeting`: already handles several recordings (prefixing, policies). Verify `words[]` and `text`.
- Notes/report prompts: the "Sources" block from the clip list (replaces `buildUploadedPartsContext`).
- Voiceprints / speaker-ID pass: per recording, per its own file, results keyed by prefixed label; the People card
  shows the recording's source label beside each voice ("Speaker A · phone").
- Player (3a's windowed player + the existing part switcher): parts = clips, labelled by source; the scrubber is
  the meeting span; switching part keeps the meeting time; `t:` chips pick the part that has audio at that time
  (prefer `include` clips, then `gap_fill`, then `exclude`).
- Offline plan: every clip's media as parts (already the shape).
- Permanent delete: the 3a rule already protects a recording clipped by another meeting.
- Un-combine = `DELETE …/clips/:ord`. The recording keeps existing (Recordings tab, or its own meeting).

## UI
- Recording card: "2 recordings — Teams (4h 55m) · Atira's phone (1h 55m from 1:50:00) · Edit…" → a sheet listing
  clips with source, offset (`h:mm:ss`, editable), policy (Text / Fill gaps only / Audio only), remove, and **Add a
  recording…** (from: another meeting I can edit · my unlinked recordings · upload a file). Adding opens the align
  step: "Line them up" with the overlaid envelopes, Guess (calls align), nudge, "Use this offset".
- Transcript: utterances from a non-primary recording carry a small source tag; `gap_fill` text is visually quiet.
- Listing strip: "2 recordings · 4h 58m".

## darth-cli (spec only)
`meetings clips add <id> --recording <rid>|--from-meeting <mid>|--file <path> --offset 1:50:00 [--policy gap-fill]`,
`meetings clips rm <id> <ord>`, `meetings clips set <id> <ord> --offset … --policy …`, `meetings align <rid> --against <rid>`.

## Verification
Pure: prefixing + policies on real payload shapes (exists), timeline/part selection for chips. Scratch Postgres:
combine two synthetic recordings (tone + speech-like noise with a known offset) → align finds the offset within
100 ms → clip added → materialised payload interleaves with prefixed labels → gap_fill only fills silence →
People card labels per recording → delete one meeting keeps the recording → privacy: an editor cannot add a
recording they do not own and were not given. Browser pass of the sheet, align step, player part switching,
390 px. `TZ=UTC bun test`, `tsc`, `eslint`, env-less build. Acceptance on prod (Alok): rebuild SI-BL row 548 from its
three recordings with this instead of the hand merge and compare the text.

---

## As built — source (c), the upload that joins a meeting (2026-09-22)

The third source in §API — "a fresh upload made with `?attachTo=<meeting id>`" — is built, behind the same
`MW_COMBINE` gate as the rest. Sources (a) and (b) were already done; this is the hook the Phase 3b server
commit (b540e8a) left as a note, and it replaces that route's `upload-deferred` 501 for every real case.

**An upload names its meeting when it STARTS.** `POST /api/uploads` takes `attachTo: { meetingId, offsetMs?,
textPolicy? }` in the body; the one-shot `POST /api/transcripts` takes `?attachTo=<meeting id>` with
`?attach_offset=` (`mm:ss` / `h:mm:ss` / ms) and `?attach_policy=`. Both resolve it **immediately, before a byte
moves** (`resolveAttachTarget`), because a person who may not add to that meeting has to hear so before they
spend twenty minutes uploading. The refusal table is the meeting half of `addPrecondition`, in the same
sentences the sheet greys out with: 404 (a meeting the caller cannot open — the SAME sentence as one that does
not exist, so this is not an existence oracle), 403 `read-only`, 409 `no-clip` / `too-many-clips` / `disabled`
(flag off, or the meeting is in the trash), 400 `offset-invalid`. Nothing about the RECORDING is checked — it
does not exist yet, so neither `already-clipped` nor `not-transcribed` can apply.

What survives is the MARKER, `gmeet_context.attachTo` on the placeholder: `{ meetingId, offsetMs, textPolicy,
at, by }`. It lives on the ROW, not only on the upload session, because the two byte-delivery routes are
different code paths, a chunked session is resumed hours later, and the completion hook that acts on it runs
from a poll that knows nothing about either. `by` is the uploader's email, frozen: there is no users table, and
access is re-checked AS THEM at the end (a share can be withdrawn while a 4 GB file is in flight). It survives
`promoteUploadingRow` (which never touches `gmeet_context`), a multi-part group (it is stamped beside the group
marker, not through `contextExtra`, which groups drop) and the fresh-insert fallback (it rides `UploadSpec` into
the ingest options for the one path where the placeholder was reaped).

**The clip is added at completion**, from `onTranscriptCompleted`, beside the `rematerialiseCombinedMeetings`
block and under the same `combineFlagOn()` gate: resolve this upload's own recording (`meetingRecordingRef`,
running the dual-write once if it has not landed yet), re-check access, and call the ordinary `addClip` — same
code path, same privacy rule, same materialise-and-roll-back. The whole upload, `fromMs: 0`, `toMs: null`, at
the stored offset and policy; a window of it is a later edit in the sheet, never a guess here. On success the
marker is cleared (it is an instruction, not a record — the clip list is the record), and so it is on
`already-clipped`, which is what a re-entry after a crash between the add and the clear looks like. **No new
DM**: the ordinary "Transcript ready" one has already gone.

**A refusal is not a failure of the upload.** If `addClip` says no (the meeting filled up while the file was
uploading, the share was withdrawn, the recording is not set up), the uploaded meeting stays a perfectly
ordinary standalone meeting — own recording, own text, fully readable — and the marker keeps `error` +
`errorCode` + `failedAt` so the card can say "could not attach: …". A marker with an error is no longer
*pending*, so nothing retries it.

**The target meeting's card knows.** `GET /api/transcripts/:id/clips` grew `pendingAttach: PendingAttach[]` —
`{ sourceLabel, offsetMs, textPolicy, state: 'uploading' | 'transcribing' | 'failed', mine, since }` — the
uploads that named THIS meeting and have not landed yet. Caller-scoped in SQL (`listPendingAttachments`: the
caller's own row or one shared with them) and **filename-free by construction**: the meeting's readers have not
been given those bytes yet — the clip is what consents to that — so the label is `clipSourceLabel` with no
filename ("Upload", "Recorded on your Mac").

**`POST …/clips` with `uploadSessionId` deliberately stays 501.** Stamping a marker on an in-flight session
would be a race with no winner: a session that finishes between the lookup and the stamp would never see it and
the meeting would silently stay standalone — and once it HAS finished, its recording exists and that route's
ordinary `recordingId` form is the answer. The `upload-deferred` sentence now says exactly that.

### Files

| | |
|---|---|
| `src/lib/clips.ts` | `AttachToRequest` / `AttachToMarker` / `PendingAttach`, `parseAttachTo`, `attachOffsetMs`, `attachMarker`, `attachMarkerOf`, `pendingAttachOf`; `ClipsResponse.pendingAttach`; the reworded `upload-deferred` sentence. Pure. |
| `src/lib/server/clip-attach.ts` | `resolveAttachTarget` (open), `runPendingAttach` (completion), `pendingAttachFor` (the card's line). |
| `src/db-ops/clips.ts` | `listPendingAttachments` — caller-scoped in SQL. |
| `src/lib/format.ts` | `GmeetContext.attachTo`. |
| `src/lib/server/upload-pipeline.ts` | `OpenUploadInput.attachTo` / `UploadSpec.attachTo`; stamped beside the group and recorder markers; carried into the ingest context for the fresh-insert fallback. |
| routes | `POST /api/uploads` (body `attachTo`), `POST /api/transcripts` (`?attachTo=`, `?attach_offset=`, `?attach_policy=`), `GET …/clips` (`pendingAttach`). |
| `src/lib/server/post-completion.ts` | the call, beside `rematerialiseCombinedMeetings`. |

### Verification

`src/lib/__tests__/clips-attach.test.ts` (committed, pure — 21 checks) and the scratch-Postgres integration
check in `tmp/recordings-attach/` (18 checks, own cluster on 55941, AssemblyAI never called): open → marker on
the placeholder → survives promotion → completion adds the clip at 1:50 as `gap_fill` → the target materialises
two recordings with namespaced labels while the upload stays standalone; the five open-time refusals; and a
completion whose `addClip` refuses leaving a standalone meeting with `attachTo.error`. `TZ=UTC bun test`
1043 pass / 0 fail, `tsc`, `eslint`, env-less build all clean.

### Left for the UI

`pendingAttach` is served but nothing renders it yet, and no upload dialog offers "add this to an existing
meeting" — both belong to the Phase 3b UI. A meeting's free slots are counted from its CLIPS only, so N
uploads attaching to one meeting at once can overshoot `MAX_CLIPS_PER_MEETING`; the last ones are refused at
completion with `too-many-clips` and stay standalone, which is the documented failure path rather than a
silent one. Reserving slots at open would need a counter nothing else reads — not worth it until someone
actually does it.

---

## As built — the three loose ends of the UI pass (2026-09-22)

**1. `ClipEntry.mediaPart` / `mediaParts` — the player stops guessing.** The `?part=N` numbering walks playable
FILES, not recordings (`mediaForRecordings`): a Meet recording that stopped and restarted holds two of them, so
anything placed after it is one number further along. `playerParts` used to count recordings and take a
`primaryExtraFiles` hint for the one multi-file case the page could see (`gmeet_context.videoParts` on the
PRIMARY); a non-primary recording with two files was invisible to it and sent the next chip at the wrong file.
So the number is now SERVED. `mediaFromGraph` / `resolveMeetingMedia` / `mediaPartsByRecording`
(lib/server/recordings.ts) are the media half of the content resolver — the same walk, the same
`scopeMediaToRow`, without paying for `resolveClips` over every payload — and `combineState` takes the resolved
list as an option, filled by the two readers a player is built from (`combineView` for the GET, `mutationBody`
for what a sheet edit hands back) and by nothing else. A clip whose recording has no playable file (bytes not
held, or the scope withheld them) gets `mediaPart: null` and NO chip, rather than a number that 404s.
`primaryExtraFiles` is gone. The one fallback kept: an entry list where nothing carries a `mediaPart` — a
response the service worker cached from an older build — falls back to the old one-file-per-recording
derivation.

**2. `sourceKind` + `shortLabel` — the short tag comes from the facts.** `shortSourceTag` re-read
`clipSourceLabel`'s sentence to get "Teams" out of "Atira's Teams recording"; a name containing " · " or ending
in " recording" would have been mis-split. `clipShortLabel` (lib/clips.ts) shortens the SAME facts the sentence
is built from, `clipSourceKindOf` narrows `recordings.source_kind`, and both ride on every `ClipEntry`.
`sourceTagOfEntry` in combine-ui.ts prefers the served `shortLabel`; `shortSourceTag` stays as its fallback (and
for `ClipCandidate`, which has no short form). `sourceLabel` is unchanged.

**3. The speaker dialog tags its turns.** `SpeakerPreviewDialog` shows surrounding turns from EVERY recording at
once, where two bare "Speaker A" badges read as one person — and on a combined meeting they are two different
people, because each recording is diarized on its own. It now takes the `sourceTagOf` the People card already
had and puts the same chip the transcript body uses beside the speaker selector and beside every turn. Invisible
for a one-recording meeting, which is every meeting on prod.

Checks: `src/lib/server/__tests__/clip-combine-media.test.ts` (the numbering, over graphs — a non-primary
recording with two files, a reserved number for bytes not held, timeline order, the withheld recording),
`src/lib/__tests__/combine-ui.test.ts` (`playerParts` off the served number, the no-chip and cached-response
paths, `clipShortLabel` against `clipSourceLabel` for all six kinds), and `tmp/recordings-combine/mediapart.check.ts`
(scratch Postgres, the real `clipsView`: 1/2 → primary gains a file → 1/3 → the phone gains one → [1,2] and
[3,4], and the phone's own meeting still numbers from 1).

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

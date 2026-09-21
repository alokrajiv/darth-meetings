# First-class recordings — Phase 3a: clips (one recording, several meetings)

Status: **build brief**, 2026-09-22. Needs Phase 1 (044, `MW_RECORDINGS_WRITE`, backfilled graph), 1b (045) and
Phase 2 (046). Flag: `MW_CLIPS`. Decisions: `docs/recordings-first-class-design.md` §5 D-A/C/D and §7 DEC-1/DEC-2.

## What Alok asked for
One recording often covers more than one thing: a podcast and then a 1:1, a stand-up that ran into a customer call,
a day-long workshop. He wants to say — in the UI, or to an AI/darth-cli session — "from when Paola joined until she
left is its own meeting", and get a second meeting **without re-transcribing anything and without cutting a file**
(DEC-2). The window is chosen AFTER the single transcription (DEC-1).

Out of scope here (Phase 3b): putting two different recordings into one meeting (the SI-BL phone + Teams case).

## Model

A **clip** = `meeting_clips` row: `(transcript_id, ord, recording_id, from_ms, to_ms, offset_ms)`.
- **Split** takes a window `[from, to)` of meeting M (which sits on recording R) and makes meeting N:
  - N: one clip `(R, from, to, offset 0)` — N's timeline starts at 0.
  - M (default, D-D "shrink"): its clip `(R, 0, end, 0)` becomes two: `(R, 0, from, 0)` and `(R, to, end, offset to)`.
    **M keeps its original timeline** (a hole where the window was), so every `t:<ms>` / `frame:<ms>` citation in M's
    notes still points at the right moment. With `keepInBoth: true` M is left untouched.
- The meeting row stays what every reader reads (Phase 1 rule), so a clip meeting's `imported_content` is the
  **materialised** result of its clips: `resolveClips()` output, with speaker labels left UNPREFIXED while every
  clip of the meeting is on the same recording (one diarization space — DEC-1; prefixing starts only in 3b).
  Materialise in ONE function, `materialiseMeeting(transcriptId)`, called by split, by un-split, and by
  `activate()` of a new transcription version on R — a version swap re-materialises EVERY meeting that has a clip on
  R (their windows stay, their text updates; edits/names are parked per version exactly as Phase 2 does, per meeting).
- `duration` of a clip meeting = its window; `recorded_at`/anchor = R.started_at + from.

## What moves with a split
| Thing | Rule |
|---|---|
| Utterance edits (index-keyed) | edits on utterances inside the window move to N re-keyed from 0; M's remaining edits are re-keyed to M's new utterance list. One pure function, exhaustively tested (landmine #2). |
| Speaker names + suggestions | copied to N (same labels, same recording). |
| Summary / report / auto segments | N starts with none. M gets the `notesStale`-style marker with a reason: "Part of this meeting was split off on 22 Sep". Never auto-regenerate. |
| Title / event link | N: the title given, or the linked event's; linking N to a calendar event uses the existing link-event resolver (auto-shares to invitees exactly as an upload linked to that event would). M unchanged. |
| Shares | NOT copied. N is visible to the owner, plus whoever the event link brings in. (Copying shares would expose a window of a recording to people who were shared a different meeting.) |
| Labels, series | not copied; series auto-attach runs for N if it is linked to an event. |
| Temporary flag (D-A) | N inherits `scratch`; linking N to an event clears it on N only. |
| `/m` link (D-C) | M keeps its uuid. N mints its own via `ensureMeeting`; when N is linked to an occurrence that already has a pre-import uuid, that uuid is adopted. |
| Attachments, activity | stay on M; N's activity starts with a `split_from` entry, M gets `split_off`. |
| Owner | N's owner = M's owner. Editors of M may split; N still belongs to M's owner. |

## Media and the window
- `ResolvedMedia` gains `windowFromMs` / `windowToMs` (null = whole file). `/audio` serves the recording's file as
  today (no cutting); the **player** clamps to the window: displayed time = file time − from, seeking maps back,
  playback stops at `to`. Video, the audio-only variant, the waveform/scrubber, `t:` chips, frame grabs
  (`frame:<ms>` in N means window-relative → file ms = from + ms; `frameSourceFor` is the single seam) and voiceprint
  snippet cutting (`localMsIn`) all go through the same mapping.
- The Phase 1 privacy guard (`scopeMediaToRow`: no media unless the row has its own `local_audio_path`) stays. N gets
  `local_audio_path` = R's canonical filename so N plays — and therefore **file deletion must stop walking the row**:
  permanent delete removes files only when no OTHER meeting (live or trashed) has a clip on the recording
  (`liveMeetingsForRecording` semantics incl. trash). This is the change that makes shared bytes safe; test it hard.
- Offline pins: N pins the same media URL shape under its own id (bytes are duplicated in the SW cache for now —
  note it, do not solve it here).
- M with a hole: the player skips the hole (it is not M's content any more); with `keepInBoth` nothing changes.

## Un-split
`DELETE` of N when N has exactly one clip and M still has the matching hole offers "put it back": M's two clips merge
back, M's edits re-key, N's edits move back in. Plain trash of N leaves the hole (the text is recoverable by
restoring N). Keep it simple: implement "put it back" only from N's page menu, only while N has no notes of its own.

## API (all caller-scoped through `resolveAccess` on the meeting; writes = editors)
- `POST /api/transcripts/:id/split` `{ fromMs, toMs, title?, eventRef?, keepInBoth? }` → `201 { meeting: {id, url},
  moved: {edits, speakerNames}, source: {clips} }`. Refuses: window < 10 s, window covering (almost) everything,
  window crossing an existing hole, meeting not `completed`, meeting whose transcription is mid re-run, non-compat
  multi-RECORDING meetings, legacy two-owner job.
- `GET  /api/transcripts/:id/clips` → the meeting's clips + sibling meetings on the same recording that the CALLER
  can access ("also from this recording: …" — never reveal a sibling the caller cannot open).
- `POST /api/transcripts/:id/clips/propose` `{ instruction? }` → **proposals only, nothing written**:
  `[{ fromMs, toMs, title, reason, eventRef? , confidence }]`. Inputs the proposer may use: utterances with speaker
  names, speaker first/last-heard times ("when Paola came in / left"), silences ≥ 45 s, topic shifts, and the
  owner's calendar events overlapping R's wall-clock span (`started_at` + duration) via the existing calendar cache.
  Deterministic candidates first (speaker entry/exit, long silences, calendar boundaries) → then ONE headless agent
  call (same runner, model and cost accounting as auto-notes, `ai_runs` row kind `clip_proposal`) to pick and
  name them; with no instruction and no strong deterministic boundary, answer an empty list rather than invent one.
- `POST /api/transcripts/:id/unsplit` (from N).

## UI (transcript page)
- ⋯ menu → **Split off a part…**: a range on the player timeline (two handles, snap to utterance boundaries, live
  "12:40 – 41:05 · 28m 25s · 3 voices"), a title field, optional "Link to a calendar event" (existing picker,
  pre-filtered to events overlapping the recording), "Keep it in this meeting too" checkbox (off), and a
  **Suggest** button that calls `propose` and lists the proposals as one-click presets with their reason.
- After a split: go to N; N's Recording card says "Part of a longer recording — 12:40 to 41:05 of *M's title* ↗";
  M's says "A part of this recording is its own meeting: *N's title* ↗" and the transcript shows a quiet divider at
  the hole. Both only name siblings the viewer can open.
- Listing: N is an ordinary row; its recording strip reads "Part of a longer recording · 28m 25s".

## darth-cli (other repo — deliver the exact verb spec + a server that supports it; do not edit the CLI)
`meetings clips <id>` · `meetings propose-clips <id> [--instruction "…"] --json` · `meetings split <id> --from 12:40
--to 41:05 [--title …] [--event <ref>] [--keep-in-both]` · `meetings unsplit <id>`. Timestamps accept `mm:ss`,
`h:mm:ss` or ms. This is what lets an independent AI session do "split when Paola joined" end to end.

## Verification
Pure: window/hole arithmetic, edit re-keying both ways, proposal candidate extraction. Scratch Postgres + stubbed
AssemblyAI/agent: split → both meetings read right through every reader (content, edits, speakers, audio window,
offline plan), the recording graph + `recordings-verify` clean, a version swap on R re-materialises both, permanent
delete of either keeps the other playing and deletes files only with the last one, unsplit restores M byte-for-byte,
sibling visibility is caller-scoped (a user shared only N never learns M exists). Browser pass of the split dialog,
the windowed player (seek, end-of-window stop, chips, video), light/dark/390 px. `TZ=UTC bun test`, `tsc`, `eslint`,
env-less build.

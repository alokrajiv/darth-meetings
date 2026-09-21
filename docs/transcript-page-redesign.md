# Transcript page — redesign (2026-09-21)

Status: **designed + built, not yet deployed.** Written the evening after `docs/listing-ui-redesign.md`
shipped, against main `f415f8d`, from Alok's verdict on the Hypercare row (`591b102e…`, DB id 920): *"look
at the entire page design and reconsider how it should be done right — also guessed names of people disappear
if I click the edit icon of the speakers — there are some issues not yet thought through properly."*
Mockup: `docs/mockups/transcript-redesign.html` (follows the OS theme, has a toggle, phone breakpoint).
Companion docs: `recorder-upload-ux.md` (how a Recorder recording reaches this page),
`eval-aai-code-switching-2026-09-21.md` (why the transcription block says what it says),
`recordings-first-class-design.md` (the target model this page is designed against).

## 1. What was wrong

The page answered its questions in the wrong order and with the wrong words:

- **The "how" leaked into the "what".** The header row wore an `Upload` chip, a `56m 45s` mono chip, `6
  speakers`, and a bare `ID` — the language code, read by everyone as an identifier. The About card then
  repeated the source as `Uploaded video (2026-09-21 16.36.41 teams part1.mp4)`: the recorder's own segment
  filename presented as a fact about the meeting. The Sources card said the same thing a third way
  ("Recorded in 8 segments by Darth Recorder"). Three places, none of them the sentence a reader wants:
  *recorded on Atira's Mac with Darth Recorder · 8 segments · 618 MB · video.*
- **Filler rows.** `AUDIO Available` and `VIDEO Available — use the player's video toggle` said nothing the
  player did not already show. They existed so the *absence* states could be said out loud — but the
  absence states are the only rows worth a line.
- **People were not people.** INVITED mixed `Ivan Seow` with `atira.sarat@trames.sg`; SPEAKERS listed
  `mixed` — a label someone typed for a shared room mic — as a person, and the Sources card offered
  `mixed 85%` as a voiceprint match; the voice count (`6 voices heard`) counted it.
- **Two clocks.** `4:30–5:30 PM` here, `16:30` in the listing.
- **Language without its nuance.** `LANGUAGE Indonesian` while the Sources card, correctly, explained that
  AssemblyAI fell back to Universal-2 and that English stretches may read as translations.
- **The speaker edit lost the guess.** The Speakers panel shows *Atira Sarat?* with a Confirm button; the
  pencil on the same row opens a dialog that says *Set a name*. The guess is not carried into the form, so
  the natural gesture ("that's right, let me confirm/adjust it") starts from a blank field. Same in the
  transcript's inline speaker editor.

## 2. Principles (carried over from the listing, plus three)

1. **Answer in order.** What meeting is this (title, when, who was there, who spoke) → what was said
   (summary → detailed report → transcript) → how it was made (recording, transcription, sources, advanced).
   Nothing from the third group appears above the second.
2. **A filename is never a fact.** It lives in a tooltip and in the segments disclosure — never in a
   sentence.
3. **People are people.** `PersonChip` wherever a person appears: organizer, invitees, speakers, "Edited
   by". An e-mail is a tooltip.
4. **A voice is not always a person.** A speaker label such as `mixed`, `room mic`, `several people` is a
   *group* label: shown as what it is ("Several voices · shared mic"), never counted as a person, never
   enrolled as a voiceprint, never suggested as a name. The rule is one pure function (§5).
5. **The recording is an object.** One Recording block replaces SOURCE / AUDIO / VIDEO / "Recorded in 8
   segments": source, who recorded it, segments, duration, size, what media exists, where the bytes are —
   and the one recovery action when something is missing.
6. **Language belongs with the transcription.** The plain sentence, the calm amber nuance when a language
   was forced or a model fell back, the facts behind a disclosure. It does not get a row of its own.
7. **One calm action per state; depth behind a disclosure.** 24-hour times everywhere. Phone width works:
   the rail is a drawer (kept).
8. **A guess is a first draft, not a blank.** Every edit surface for a speaker opens pre-filled with the
   best name we have, labelled with where it came from, and confirming it is one click.

## 3. Page anatomy

```
┌ header bar ──────────────────────────────────────────────────────────────────────────────┐
│ Darth Meetings › Archive › Hypercare…      [Shared — Editor] [Offline: audio] Raw|Edited Share ⋯ │
├ identity block ──────────────────────────────────────────────────────────────────────────┤
│ Hypercare - PGLS Trames Go Live Support OKI - Perawang                                      │
│ Mon 21 Sep 2026 · 16:30–17:30 · 56m 45s   (⟳ series) (● label) (+ Label)      Edited by (AT) Atira · 2 h │
│ (AH) Antonius (organizer) · 37 invited · 6 voices                                            │
├ main column ───────────────────────────────┬ rail (sticky; phone: drawer) ────────────────┤
│ ▶ player (sticky) · Show video · Video 1|2 │ OUTLINE                                       │
│ ✦ Summary  [Detailed report | Summary]     │ RECORDING                                     │
│ 📝 Notes                                   │   💻 Recorded on Atira's Mac with Darth Recorder │
│ 👥 People                                   │   8 segments · 56m 45s · 618 MB · video        │
│   Voices (6)              [Guess names]    │   ▸ Segments                                  │
│   ● Atira Sarat · 78 lines            ✎    │ SOURCES  (transcription + what the AI used)   │
│   ● Anton · 41 lines                  ✎    │   Voice-level diarization                     │
│   ● Yan-Simon Saragih? ✦ Confirm      ✎    │   Voiceprint: 4 matched (…)                   │
│   ● Several voices · shared mic       ✎    │   Transcribed in Indonesian (auto-detected)…  │
│   ● Speaker E  [Name…]                ✎    │   ⚠ Mixed-language calls…                     │
│   Invited (37)  (AH) Antonius · (IS) Ivan… │   Advanced details ▾                          │
│ 🎧 Transcript                               │ ATTACHMENTS                                   │
│   Atira Sarat  0:15  Ok, jadi kita mulai…  │ QUICK ACTIONS                                 │
└────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

### 3.1 Header bar — unchanged
Breadcrumb, Shared/Editor badge, offline pin, Raw/Edited, Share, ⋯. Keyboard shortcuts unchanged.

### 3.2 Identity block (was: title + chip row)
| Slot | Content | Today's field(s) |
|---|---|---|
| title | inline-editable, unchanged; a filename-shaped title renders through `meetingTitleOf()` | `title`, `original_filename` |
| when | `Mon 21 Sep 2026 · 16:30–17:30 · 56m 45s` — the calendar range when the event is linked and on the same day as the curated date, else the curated date + time; click to edit (kept); tooltip = relative time + "from the calendar invite" | `gmeet_context.startTime/endTime`, `recorded_at`, `duration` |
| chips | AutoProvenance, series badge, labels + `+ Label` — unchanged | |
| who | organizer `PersonChip` + *organizer* tag when the event carries one; `37 invited` (scrolls to People); `6 voices` (scrolls to People); `Not linked to a calendar event · Link…` when there is no event (was a row in About) | `organizerEmail`, `attendees[]`, `speaker_count`, `eventId` |
| activity | `Edited by …` ActivityBar, unchanged | |

Removed from the header: the `Upload / Google Meet / Teams / Import` source chip (→ Recording), the mono
duration chip (→ "when"), `6 speakers` (→ "who"), the language code (`ID`, → Sources).

### 3.3 Player — unchanged
Sticky `<audio>`/`<video>` with the Show-video toggle and the Video 1/2 parts switcher.

### 3.4 Reading — unchanged
Summary card with Detailed report / Summary tabs, `t:` / `frame:` / attachment / person chips, Notes,
Transcript with editable utterances and segment headings.

### 3.5 People (was: Speakers panel + About's INVITED / SPEAKERS)
One card, `id="speakers"` kept for the outline anchor. Two sections:

**Voices** — one row per diarized speaker, rendered from `speakerNameState()` (§4). Colour dot, name in its
state's style, `· N lines`, hover pencil. `Guess names` (voiceprints, no AI) stays in the header for editors.

**Invited** — `PersonChip` per attendee, organizer first with an *organizer* tag, capped at 10 with
`+27 more` / `show fewer`. A person who also spoke (a confirmed speaker name that matches an invitee's
display name) gets a small mic dot. Only rendered when the row has a calendar event.

### 3.6 How it was made — the rail
Order: **Outline → Recording → Sources → Attachments → Quick actions.** The outline is navigation and
stays on top; the rest is depth. On phones the same stack is the drawer (kept).

**Recording** (`src/components/recording-card.tsx`, model in `src/lib/recording-facts.ts`) — replaces About's
SOURCE / AUDIO / VIDEO rows and the Sources card's "Recorded in 8 segments" / "Stitched from N files" items:

| Line | Content | Today's field(s) |
|---|---|---|
| source sentence | `Recorded on Atira's Mac with Darth Recorder` (Laptop glyph; "your Mac" for the owner) / `Recorded in Google Meet` / `Recorded in Microsoft Teams` / `Uploaded recording` / `Pasted transcript` (no media) | `gmeet_context.recorder`, `provider`, `assemblyai_id` prefix, `source`, row `access` + `owner_email/name` |
| facts | `8 segments · 56m 45s · 618 MB · video` — each fact only when known | `uploadedParts.length` / `combinedParts` / `videoParts`, `duration`, `upload_bytes_total`, `local_audio_path` extension |
| Segments ▾ | disclosure: `1 · 0:00 · 7m 12s`, per-segment comment when the uploader wrote one; the recorder/uploader filename in the tooltip only; one sentence under it — the recorder rolls a segment on every screen-share change, joined in order before transcription, the AI is told where the joins are | `uploadedParts[]` |
| video parts | `2 videos — the recording was stopped and restarted; switch in the player` + fetching / preparing lines | `videoParts`, `recordingPending`, `actuals.recordings` |
| recovery | only when something is missing: `On Google Drive, not saved here yet · Fetch`, `Google is still preparing the video…`, `No audio available`, `The video never appeared on Drive…`, `Got the recording? Add it here…` (the `?source_id=` upload-and-redo, moved verbatim) | as MeetingInfoCard |
| held vs added | `held 4 Aug, imported 11 Aug` when the days differ | `recorded_at` vs `created_at` |

Filler is gone: a stored recording with audio and video says nothing beyond the facts line.

**Sources** (`transcript-sources-card.tsx`, content kept) — the diarization source, sidecar cross-check,
voiceprint / Meet-timeline matches (group labels filtered out), the transcription sentence + amber nuance +
Advanced details, and the re-transcribe / combine actions. The recorder-segments and stitched-files items
moved to Recording. Language lives here and only here.

### 3.7 What moved where
| Was | Now |
|---|---|
| header `Upload` / Meet / Teams chip | Recording source sentence |
| header `56m 45s` mono chip | "when" line |
| header `6 speakers` | "who" line (`6 voices`, scrolls to People) |
| header `ID` (language code) | Sources: "Transcribed in Indonesian (auto-detected)…" |
| About · WHEN `4:30–5:30 PM` | "when" line, `16:30–17:30` |
| About · CALENDAR `From calendar invite` / `Not linked · Link…` | tooltip on "when" when linked; `Not linked · Link…` on the "who" line when not |
| About · SOURCE `Uploaded video (…part1.mp4)` | Recording source sentence; filename in the Segments tooltip |
| About · AUDIO / VIDEO | Recording facts line (`video`) + recovery lines only when something is missing |
| About · INVITED (names + e-mails) | People › Invited (`PersonChip`s) |
| About · SPEAKERS `6 voices heard — …mixed…` | People › Voices (state-aware; group labels shown as such) |
| About · LANGUAGE `Indonesian` | Sources (already there, with the nuance) |
| Sources · `Recorded in 8 segments by Darth Recorder` / `Stitched from N files` | Recording › Segments |
| Sources · `Voiceprint: … mixed 85%` | filtered by the group-label rule |

## 4. Speaker naming — the state table

`src/lib/speaker-name-state.ts` — `speakerNameState(speaker, labels, suggestions)` is the ONE merge every
surface reads (People rows, the Identify-speakers dialog, the inline badge editor, the review gate).

| State | Data | Read view (People row) | Edit view (dialog / inline) |
|---|---|---|---|
| **confirmed** | `speaker_labels[sp].customName` is a person's name | name, medium weight · `N lines` | input pre-filled; caption *confirmed* |
| **guess** (unconfirmed) | no label; `suggestions[sp]` present and a person's name | `Yan-Simon Saragih?` in primary + ✦ + **Confirm** (+ *+ Person* for unknown context names) | input pre-filled with the guess; caption *guessed — voice match 85% / from the transcript: "…"*; **Confirm guess** button; typing replaces it |
| **unknown** | no label, no usable suggestion | `Speaker E` italic + **Name…** | empty input, placeholder *Name…*; caption *no guess — name them if you can* |
| **group** (non-person label) | label is a group word (`mixed`, `room mic`, `several people`…) | `Several voices · shared mic`, muted, mic-off glyph; not counted in "6 voices"; not listed as a person anywhere | input pre-filled with the label; caption *a shared mic, not a person — will not be enrolled as a voiceprint* |
| **group guess** | no label; the suggestion's name is a group word | treated as **unknown** — a "mixed 85 %" match is not a name | as unknown |
| identifying | `speaker_id_status = 'running'` | row caption *guessing…* (existing shimmer) | as today |

Confirming a guess writes the same `PUT /speakers` as typing the name; the row moves to **confirmed** and
the voiceprint enrols — unless the name is a group word, which the server now skips.

### The bug, in two sentences
`SpeakerSummaryPanel` renders the guess from `suggestions` but hands the edit dialog
(`SpeakerPreviewDialog`) only `speakerLabels`, whose name draft is seeded from
`mapping?.customName ?? ''` — a speaker with a guess and no confirmed label therefore opens as *Set a
name*. The transcript's inline `SpeakerBadgeEditor` seeds its picker the same way
(`initialValue={mapping?.customName ?? ''}`), so the guess vanished there too.

**Fix:** both editors (and the People rows) read `speakerNameState()`; the dialog seeds its draft from
`state.name`, shows the source caption, and offers **Confirm guess** (one click → `onSave(sp, {customName})`).
Unit tests: `src/lib/__tests__/speaker-name-state.test.ts`.

## 5. The "not a person" rule

`src/lib/speaker-name-kind.ts` — `speakerNameKind(name)` → `'person' | 'group' | 'empty'`. A name is a
**group** label when, lower-cased and trimmed, it is one of a small vocabulary — `mixed`, `multiple`,
`several`, `group`, `room`, `crowd`, `everyone`, `audience`, `crosstalk`, `overlap`, `background`, `noise`,
`music`, `unknown`, `unclear`, `inaudible`, `n/a`, `tbd`, `?` — alone or with a qualifier (`mixed voices`,
`room mic`, `shared mic`, `several people`, `multiple speakers`, `unknown speaker`), or a default label
(`Speaker C`). It is **not** "a single lower-case word": `pratiksha`, `rick`, `laz` are people whose names
were typed in lower case (41 such enrolments exist).

Where it applies: People rows (§4), the Sources voiceprint list, the review dialog's pre-fill, the
`6 voices` count, and — server side — `enrollFromTranscript` (skips group labels) and
`suggestSpeakersForTranscript` (ignores enrolled voiceprints whose name is a group word). Under the
first-class model (`recordings-first-class-design.md`) this becomes a `kind` on the label; the function is
where that column's default will be computed.

### The "mixed" enrolment (read-only lookup, 2026-09-21 ~19:00 SGT, `meeting_whisperer_prod`)
`voiceprints` id **206**, `name = 'mixed'`, `sample_count = 5`, created **2026-09-14 16:22 SGT**, last
updated **2026-09-21 17:38 SGT**. It was born when **Alok** saved speaker C of *KAAA* (`b8b938d1…`,
14 Sep 16:21–16:22 SGT, six `edit_speakers` saves) as `mixed`; every later save of that label enrolled
another sample: *AI - Daily* (`716fee9a…`, 16 Sep), then **Atira** on *Hypercare* (`337925f7…`) and
*Regroup on import shipment* (`ded727fc…`) on 17 Sep 17:51–17:57 SGT, and *Hypercare* (`591b102e…`,
this page) on 21 Sep 17:38 SGT — where speaker D is **confirmed** as `mixed` (label saved by Atira) and
the voiceprint pass had suggested `mixed 85 %`. Eight `speaker_mappings` rows now carry a `mixed`
suggestion. Not deleted; with the rule above it is inert (never suggested, never re-enrolled). Deleting
row 206 is Alok's call.

## 6. Time
`src/lib/when.ts` — `clock24()`, `dayLabel()`, `whenLine()`: `Mon 21 Sep 2026 · 16:30–17:30`, always
24-hour, day-of-week first, the year always (a page opened from a Slack link is read out of context). The
listing formats through the browser locale (24 h in en-SG); this helper is deterministic and is what the
identity block uses.

## 7. Mapping to the first-class model
| UI concept | Today | `recordings-first-class-design.md` |
|---|---|---|
| Recording block | `gmeet_context.recorder / uploadedParts / videoParts / combinedParts`, `upload_bytes_total`, `local_audio_path` | one `recordings` row (+ `recording_media`), `transcript_segments` for the joins |
| segments disclosure | `uploadedParts[]` (offsetSec, durationSec, comment, originalFilename) | `transcript_segments` over the document timeline |
| who recorded it | row owner (`access` + `owner_email/name`, now returned by `GET /api/transcripts/:id`) | `recordings.owner_user_id` |
| voices | `speaker_labels` + `suggestions` on `speaker_mappings` | same, plus `kind` |
| invited | `gmeet_context.attendees` | unchanged |

No schema change. One server change: the detail GET now fills `owner_email` / `owner_name` for shared rows
(the listing already did), so "Atira's Mac" can be said.

## 8. What a browser pass must still cover
The build, lint, type-check and unit tests are green; the mockup was screenshotted. Not yet seen in a real
browser: the People card at phone width with 37 invitees expanded; the Identify-speakers dialog with a
guess pre-filled on a row whose AI pass is still running (late suggestion landing while the dialog is
open); the outline anchors after the rail reorder; the Recording card's recovery states on a Meet row
whose video is still on Drive.

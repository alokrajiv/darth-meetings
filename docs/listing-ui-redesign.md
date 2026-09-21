# Meetings listing — redesign (2026-09-21)

Status: **designed + built, not yet deployed.** Written against main `a861750` after Alok looked at the
listing and said it "looks ridiculous". Mockup: `docs/mockups/listing-redesign.html` (open it in a browser —
it follows the OS theme and has a toggle). Companion docs: `recorder-upload-ux.md` (P1–P5, the upload
pipeline) and `recordings-first-class-design.md` (the target data model, D-A…D-H).

## 1. What was wrong

The screenshot of 21 Sept showed a list that was assembled, not designed:

- Calendar rows carried `Check…` with `Upload…` **wrapped under it** as a second line — two outline buttons
  fighting for a 72 px cell.
- A meeting's **filename** was its subtitle ("2026-09-21 11.02.54 meet part1.mp4"); a Meet import's subtitle
  was a Drive filename ("Data scrum - 2026/09/21 11:30 IST - Recording"); one row's **title** was a filename.
- A "6" film chip meant "six recorder segments" — six *what* was anyone's guess.
- Every row wore up to eight glyphs (green dot, camera, calendar tick, series pill, blue dot, film chip,
  hourglass, trash, chevron) with no hierarchy. Completed rows looked as busy as broken ones.
- Owner was a truncated e-mail. Labels mostly empty. Two rows for one meeting while a recorder upload ran.

## 2. Principles

1. **A row is a meeting.** Title, when, who, how long, series, labels. Never a file, never a job.
2. **A recording is a thing a meeting has.** It has a source (Mac recorder, Meet cloud, Teams cloud, uploaded
   file, pasted text), a state, a duration, segments and an owner. It renders as one **recording strip**
   under the title, with the one action that matters in its state. Segments are "one recording, 6 segments" —
   never six recordings.
3. **Silence is the default.** A transcribed single-recording meeting shows *nothing* extra: no green dot, no
   camera, no calendar tick. Indicators appear only when something is happening or wrong.
4. **One source glyph, one status, one action.** The source glyph identifies the provider; status is text in
   the strip (with a pulse while busy); the action is a real control, never a wrapped outline button.
5. **A recording with no meeting lives somewhere else.** The **Recordings** tab holds recordings that are not
   attached to a meeting yet (on a Mac and not uploaded; uploaded but unlinked and unnamed). The archive
   never shows a row whose title is a filename.
6. **People are people.** Owner/organizer is an initials avatar + first name, "You" for yourself.
7. **Everything else is on hover or in the row menu (⋯).** Temporary, Link to a calendar event, Trash, Hide.

## 3. Row anatomy (archive / meeting row)

```
 15:15 │ [src] Title of the meeting  (⟳ Series) [Review speakers]      │ labels │ (JS) Juhi │ 30m 0s │ 3 │ ⋯ ›
       │       ↳ recording strip: state · N segments · 44m 32s  [Action]│
```

| Slot | Content | Today's field(s) |
|---|---|---|
| time | HH:MM in the lead column (day bucket names the day) | `recorded_at ?? created_at` |
| src | ONE glyph: Meet / Teams / Laptop (Mac) / FileAudio (uploaded file) / FileText (pasted text). Tooltip = provenance incl. "auto-imported from a series" | `provider`, `recorder_recording_id`, `source`, `auto_state` |
| title | never a filename. A bare upload with no title is NOT here (Recordings tab); if it slips through, it renders as "Recording · Sat 20 Sept 22:00" | `title`, `original_filename` → `meetingTitleOf()` |
| chips | series chip (unchanged), phone-width labels (unchanged), **Review speakers** when `auto_state='gated'`, Temporary pill on the Temporary tab | `series_*`, `labels`, `auto_state`, `scratch` |
| strip | see §4; omitted when there is nothing to say (transcribed, single recording, not from a Mac) | `status`, `recording_count`, `recorder_recording_id`, `upload_*`, companion `uploads[id]` |
| description | shown INSTEAD of the strip when the strip is empty and the user wrote one (column-chooser toggle kept) | `description` |
| owner | `PersonChip`: initials avatar + first name, or "You"; Editor/Read badge kept for shared rows | `owner_name`, `owner_email`, `access` |
| ⋯ | hover menu: Link to a calendar event…, Move to temporary / Keep, Retry transcription (failed rows), Move to trash / Restore / Delete forever | existing handlers |
| › | chevron, row click opens the transcript (unchanged) | |

Removed from the row: green/amber/blue status dots, the camera/calendar glyph pair, the film-count chip,
the hourglass + trash icon buttons (now in ⋯), the filename subtitle, the monospace progress line.

## 4. The recording strip

Rendered by `src/components/recording-strip.tsx` from a pure model built in `src/lib/recording-strip.ts`
(`stripForArchiveRow`, `stripForRecorderRef`, `stripForCalendarRow` — unit-tested). The strip is one line:
`[glyph] text  ·  [progress bar when uploading]  [Action]`, `text-[11px]`, tone-coloured.

| State | Glyph | Copy (examples) | Action | Tone |
|---|---|---|---|---|
| `recording` | Laptop + red pulse | Recording on your Mac now… | — | busy |
| `on-mac` (mine) | Laptop | On your Mac · 44m 31s · not uploaded yet | **Upload** (tray connected) / *Open Darth Recorder* (not) | warn |
| `on-mac` (theirs) | Laptop | On Kawen's Mac · 58m 12s | **Ask Kawen to upload** → "asked 14:02" | warn |
| `on-mac` (stale) | Laptop | Recording on your Mac never finished | — | muted |
| `uploading` (Mac) | Laptop + bar | Uploading from your Mac · part 3 of 6 · 298 MB of 696 MB (live numbers win) | — | busy |
| `uploading` (file) | FileAudio + bar | Uploading · 43% · 120 MB of 280 MB | — | busy |
| `received` | source | Upload received · handing off to transcription… | — | busy |
| `transcribing` | source + pulse | Transcribing… · 6 segments · 44m 32s | — | busy |
| `waiting` | Meet/Teams | Google is still preparing the video · import runs itself | — | warn |
| `transcribed` (Mac) | Laptop | Recorded on your Mac · 6 segments · 44m 32s | — | muted |
| `transcribed` (multi) | Meet | Meet recording · 2 parts | — | muted |
| `transcribed` (plain) | — | *(no strip)* | — | — |
| `failed` | source | Upload failed — AssemblyAI balance negative | **Retry** (`POST …/retry-ingest`, or the tray for a Mac upload) | err |
| `cloud-available` | Meet/Teams | Recording at Google · 16m 13s · Transcript (badges stay clickable → Drive/Docs) | **Import…** (or the ⚡ auto-sync chip) | ok |
| `cloud-preparing` | Meet/Teams | Google is still preparing the recording | — | warn |
| `none` | — | Nothing at Google (checked 14:10) / Teams chat: Held 1h 02m · not recorded | **Add recording ▾** | muted |

`data-status` / `data-recorder-recording` / `data-recorder-mine` attributes are kept on the strip for the
Playwright scripts.

## 5. Calendar rows (Not imported / No recording layers)

- Title row: provider glyph (or a muted VideoOff when the event has no conferencing link), title, series chip.
- Strip: the cloud state (§4) — artifact badges, Teams-chat verdict, recorder line, "Connect Microsoft" hint
  all live on this line now, never wrapped into the title.
- Action cell, **one control**:
  - unimported → **Import…** (or the ⚡ auto-sync chip), plus ⋯ (hover) for Hide.
  - no recording, a recorder recording matched → the strip's action is the action; ⋯ holds Check /
    Upload a file… / Hide.
  - no recording, nothing known → **Add recording ▾**: a small outline button that opens a menu titled
    "Where is the recording?" with three answers — *At Google/Microsoft — check* (runs the live probe, shows
    the last verdict), *In a file — upload…* (opens the upload dialog pre-linked), *On this Mac — Darth
    Recorder…* (only when the tray is connected) — and a Hide section underneath.
  The old hover-only gear is gone; the ⋯ menu is the same idiom as archive rows.

## 6. The Recordings tab

A tab next to Temporary (`All · Mine · Shared · Temporary · Recordings 2 · Trash`). Its badge counts
recordings that have no meeting yet. Two sections, cards not table rows:

1. **On your Macs** — the caller's own registry rows (`GET /api/recorder/recordings?mine=1`) in
   `recording | local | uploading | upload_failed`. Card: title (call title or "Recording · Fri 19 Sept 17:12"),
   meta (duration · size · N segments · which Mac), the best calendar match when the matcher has one
   ("Looks like *Data scrum* · 14:00 · 82 %"), the strip, and **Upload** / **Retry** (when the connected tray
   holds the file — otherwise "Open Darth Recorder on that Mac") + **Delete from this Mac**.
2. **Uploaded, not linked to a meeting** — archive rows that are *bare*: `!has_event` and the title is empty,
   equals the filename, or looks like one (`looksLikeFilename`). Card: derived title ("Recording from your
   Mac", "Uploaded file", "Pasted transcript") + date, meta, the strip (transcribing / transcribed / failed),
   the registry's suggested match with a one-click **Link to "Data scrum"** (`POST …/link-event {eventKey}`),
   and **Link to a meeting…** (LinkEventDialog), **Name…** (inline rename → `PATCH {title}`), **Open**,
   **Trash**. Linking or naming promotes the row into the archive; it leaves this tab on the next refresh.

The archive (All / Mine / Shared, merged or not) filters bare rows out of the day buckets and shows one
strip at the top: "2 recordings aren't linked to a meeting yet · Recordings". While a search is active bare
rows are shown (a filename search must find them), rendered with the derived title and the filename as the
match line. Temporary and Trash are untouched — a temporary transcript is a deliberate one-off.

## 7. Mapping to today's fields and to the first-class model

| UI concept | Today | First-class model (`recordings-first-class-design.md`) |
|---|---|---|
| meeting row | `transcripts` row (or a calendar occurrence) | `transcripts` = the document; unchanged |
| recording source | `recorder_recording_id` → Mac; `provider` → Meet/Teams; `source='uploaded'` → file; else text | `recordings.source_kind` |
| segments | `recording_count` (= `GREATEST(1+videoParts, uploadedParts, combinedParts)`) | `count(transcript_segments)` |
| recording state | `status` + `upload_bytes_*` + `upload_parts_*` + companion `uploads[id]` | `recording_results.status` + upload session |
| bare recording | `!has_event && title ∈ {null, filename, filename-like}` | a `recordings` row with no `transcript_segments` (D-B) |
| Recordings tab, Mac section | `recorder_recordings` (`?mine=1`) | same table, `recorder_recording_id` FK |
| suggested match | `recorder_recordings.matched` (`event_key`, `score`) | same |
| link | `POST /api/transcripts/:id/link-event` | same (creates the segment) |
| owner | `owner_email` / `owner_name` / `organizerEmail` | `recordings.owner_user_id` |

No server change was needed for this pass; the design reads the v2 listing, the calendar-meetings view
and the recorder registry as they are. When D-B lands, `isBareRecording` becomes "has no segment" and the
Recordings tab's second section reads `recordings` instead of filtering transcripts — the components do not
change.

## 8. What moved where

| Was | Now |
|---|---|
| `Check…` + `Upload…` buttons (norec rows) | `Add recording ▾` menu (Check / Upload / Recorder) |
| hover gear (hide occurrence / series, upload) | `⋯` row menu |
| `RECORDER · Recorded on your Mac (44m 31s) · Upload` inline text | recording strip with a real button |
| film chip "6" | strip text "6 segments" |
| green / amber / blue dots, calendar tick, camera | gone; the strip says it when it matters; `Review speakers` chip for gated rows |
| hourglass + trash icons | `⋯` menu items |
| filename subtitle | never shown; filename in the source-glyph tooltip |
| e-mail in Owner | `PersonChip` |
| bare uploads in the timeline | Recordings tab + a one-line strip above the list |

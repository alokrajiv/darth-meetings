# CLI ↔ web UI parity audit — `darth-cli meetings`

As of 2026-10-27, branch `cli-parity` at `b73c017`. Read from `src/app/**`, `src/components/**`,
`src/hooks/**`, `src/lib/chunked-upload.ts`, `src/lib/companion/companion-client.ts`, the
`src/app/api/**/route.ts` handlers, and `cli-subcommand-src/index.ts` + `README.md` in this folder.

Each row is one thing a user can do in the web UI. It gives the API route + method the UI calls,
the request fields it sends (field names only), the CLI verb that does the same today, and a status:

- `covered`: an existing verb does it.
- `partial`: a verb exists but lacks something the UI has. The row says what.
- `MISSING`: the route exists but no verb calls it. A proposed verb follows.
- `NO-ROUTE`: the UI does it client-side, through a page route, or through something that is not
  `/api` (Google APIs straight from the browser, the Mac tray's loopback socket, a URL scheme).
  The row names the mechanism, and a proposal follows.

"Proposed" lines use the existing style (`meetings <verb> <args> [--flags]`). The subcommand's
old design rule ("no AI commands": the CLI never starts a service-side AI run) was RETIRED in
task 05 (Alok, 2026-10-27: "the CLI should do everything the UI can") — `generate` is the
dialog's run as a verb, plan-first unless `--yes`. Rows the task built are marked `covered`
with the verb; the two the README keeps web-only ON PURPOSE (permanent delete, ownership
transfer) and the ones that need a server change are left as proposals for the coordinator.

Example values (where needed) are invented: `Meeting X`, `test-a@example.com`.

---

## Detail page (`src/app/transcript/[id]/page.tsx` + its inline components)

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| Header | Edit the title inline | `PATCH /api/transcripts/:id` | `title` | `set-title <id> <title>` | covered |
| Header | Edit the description inline | `PATCH /api/transcripts/:id` | `description` | `set-description <id> --file <md or ->` | covered |
| Header | Edit the meeting date/time (date chip → Save) | `PATCH /api/transcripts/:id` | `recordedAt` | `set-date <id> <when>` | covered |
| Quick actions | Keep (make permanent), on a temporary row | `PATCH /api/transcripts/:id` | `scratch` (= false) | `keep <id>` | covered |
| Quick actions | Move to trash | `DELETE /api/transcripts/:id` | — | `trash <id>` | covered |
| Trashed page | Restore | `POST /api/transcripts/:id/restore` | — | `restore <id>` | covered |
| Trashed page | Delete forever | `DELETE /api/transcripts/:id?permanent=1` | `permanent=1` | — (web-only by design, see `trash` in README) | MISSING |
| Summary card | Retry a failed run ("Generation failed · Retry") | `POST /api/transcripts/:id/report` | `useVideo` (default true), no instructions | `generate <id> --yes` | covered |
| Summary card | Cancel a queued (waiting for the video) or scheduled report | `DELETE /api/transcripts/:id/report` | — | `generate <id> --cancel` | covered |
| Summary card | Hold ("don't write the summary on your own") | `POST /api/transcripts/:id/notes/hold` | — | `hold <id>` | covered |
| Quick actions / People card | Guess speaker names (voiceprint match, no AI call) | `POST /api/transcripts/:id/speakers/suggest` | — | `speakers <id> --guess` | covered |
| People card | Confirm a guessed speaker (✓ Confirm; a guess naming exactly one invitee or directory person saves that person) | `PUT /api/transcripts/:id/speakers` | `speakerLabels[]{originalSpeaker, customName, description, email?}` | `set-speakers <id> A="Name <email>"` / `set-speakers <id> --from-invite --yes` | covered |
| People card / badge editor | Rename a speaker (type a name, or pick a directory person) | `PUT /api/transcripts/:id/speakers` (picker reads `GET /api/users/search?q&limit`) | `speakerLabels[]{originalSpeaker, customName, description, email?}` | `set-speakers <id> A=<Name or email>` | covered |
| Speaker preview dialog | Edit a speaker's context description | `PUT /api/transcripts/:id/speakers` | `speakerLabels[].description` | `set-speakers` (keeps the stored description, cannot set it) | partial — no way to set `description` |
| People card | + Person (add the guessed speaker to the people directory, then confirm) | `POST /api/people`, then `PUT …/speakers` | `name`, `email` (409 → `person` = "already registered, use existing") | `add-person "<Name>" <email>` (409 → prints the existing record, exit 0), then `set-speakers <id> A=<email>` | covered |
| Speaker naming | "Give access?" prompt after picking a Trames colleague as a speaker | `POST /api/transcripts/:id/shares` | `email`, `name`, `pplId`, `access` (= edit) | `share <id> --add <email>` | covered |
| Transcript | Edit one transcript line | `PATCH /api/transcripts/:id/edits` | `utteranceIndex`, `text` | `edit-line <id> <n> --text "…"` (addresses from `text <id> --index`) | covered |
| Find & replace | Replace current match | `PATCH /api/transcripts/:id/edits` | `utteranceIndex`, `text` | `edit-line <id> <n> --text "…"` | covered |
| Find & replace | Replace all | `PUT /api/transcripts/:id/edits` | `edits` (whole map `{"<index>": {text?, speaker?}}`) | `replace <id> <find> <with> [--case] [--dry-run]` | covered |
| Quick actions | Download → Edited markdown / Raw markdown | none: assembled in the browser from `GET …/content`, `GET …/edits`, `GET …/speakers` | — | `text <id>` (edited text, as lines) | NO-ROUTE |
| Quick actions | Link / Re-link calendar event (pick from the day's events) | `POST /api/transcripts/:id/link-event`; event list read browser-side from the Google Calendar API with the user's token | `accessToken`, `mode?`, `event{id, title, startTime, endTime, meetingCode, teamsUrl, attendees[]{email, name, responseStatus}}` | `link <id> <meeting-code or event-key> [--separate]` (sends `meetingCode` or `eventKey`, `mode`; the server resolves from the calendar cache) | covered |
| Link flow | "Join that meeting or keep separate?" choice shown before the link | `GET /api/transcripts/:id/link-candidates` | `eventId`, `startTime`, `meetingCode` or `event` (= key) | `link` (server default = join; `--separate`) | partial — no preview of the candidate meeting before the write |
| Suggested-event strip | Link the suggested event | `POST /api/transcripts/:id/link-event` | `eventKey`, `mode?` | `link <id> <event-key>` | covered |
| Suggested-event strip | Dismiss the suggestion | `PATCH /api/transcripts/:id` | `dismissSuggestedEvent` (= true) | `link <id> --dismiss` | covered |
| Quick actions | Unlink from event (shares the link created come off) | `PATCH /api/transcripts/:id` | `unlinkEvent` (= true) → reply `sharesRemoved[]` | `unlink <id>` (prints `sharesRemoved`) | covered |
| Recording card | Fetch the video from Drive / Microsoft 365 (automatic once per visit, plus a manual button) | `POST /api/transcripts/:id/fetch-audio` | `{}` | `fetch-recording <id>` | covered |
| Recording card | Add a recording file to this meeting (transcribed from scratch, inherits title/language/date/names) | `POST /api/transcripts?source_id=<id>` (raw file body) | `source_id`, headers `x-filename`, `content-type` | `upload <file>` (no source) | partial — no `source_id` |
| Ingest failure note | Retry transcription | `POST /api/transcripts/:id/retry-ingest` | — | `retry <id>` | covered |
| Sources card | "Re-transcribe with the newer model" (legacy one-click, new row) | `POST /api/transcripts/:id/retranscribe` | (no body) → `newId` | `transcribe-again <id>` (prints `newId` on the legacy path) | covered |
| Sources card | Re-transcribe from video (Meet rows; downloads the video first if needed) | `POST …/fetch-audio`, then `POST /api/gmeet/import` | `mode` (video or both), `sourceTranscriptId`, `force`, `event{id, title, startTime, endTime, meetingCode, attendees}` | — | MISSING |
| Sources card | Combine all videos and re-transcribe the full meeting | `POST /api/gmeet/import` | same as above | — | MISSING |
| Quick actions | Voice-level speaker separation (Rerun diarization, `gmeet-` rows) | `POST /api/gmeet/import` | `mode` (= both), `sourceTranscriptId`, `videoFileId`, `force`, `event{…}` | — | MISSING |
| Versions list | Switch to another transcription version | `POST /api/transcripts/:id/transcriptions/:tid/activate` | — | `use-transcription <id> <tid>` | covered |
| Versions list | See the versions (+ running, notesStale) | `GET /api/transcripts/:id/transcriptions` | — | `transcriptions <id>` | covered |
| ⋯ menu | Put a split part back ("Put it back into …") | `POST /api/transcripts/:id/unsplit` | — | `unsplit <split-off-id>` | covered |
| Labels | Add a label (picker) | `POST /api/transcripts/:id/labels` | `labelId` | `label <id> <label>` | covered |
| Labels | Create a new label from the picker, then add it | `POST /api/labels`, then `POST …/labels` | `path` | `label <id> <new/path>` (creates missing segments) | covered |
| Labels | Remove a label chip | `DELETE /api/transcripts/:id/labels/:labelId` | — | `unlabel <id> <label>` | covered |
| Series badge | Add this meeting to a series | `POST /api/series/:id/members` | `transcriptId` | `series attach <sid> <id>` | covered |
| Series badge | "Not this series" (leave and never be pulled back) | `DELETE /api/series/:id/members?transcriptId&remember=1` | `transcriptId`, `remember` | `series detach <sid> <id> --remember` | covered |
| Series badge | New series from this meeting | `POST /api/series` | `title`, `fromTranscriptId` | `series create --title T --from <id>` | covered |
| Series badge | See which series this meeting is in | `GET /api/transcripts/:id/series` | — | `series` / `series <sid>` (members), not per meeting | partial — `get <id>` prints no series line |
| Activity bar | Open the activity feed (who viewed / edited / generated) | `GET /api/transcripts/:id/activity?limit=200` | `limit` | `activity <id> [--limit N]` | covered |
| Summary card | Open "AI runs" (kind, when, who, duration, cost) | `GET /api/transcripts/:id/ai-runs` | — | `ai-runs <id>` | covered |
| Attachments | List attached files | `GET /api/transcripts/:id/attachments` | — | `attachments <id>` | covered |
| Attachments | Download one | `GET /api/transcripts/:id/attachments/:attId/download` | — | `attachment-get <id> <attId>` | covered |
| Attachments | Attach a file | `POST /api/transcripts/:id/attachments` (raw file body) | headers `x-filename`, `x-title`, `content-type` | `attach <id> <file> [--title …]` | covered |
| Attachments | Attach pasted text | `POST /api/transcripts/:id/attachments` (JSON) | `kind` (= text), `title?`, `text` | `attach <id> --text <file or -> [--title …]` | covered |
| Attachments | Remove one | `DELETE /api/transcripts/:id/attachments/:attId` | — | `attachment-rm <id> <attId>` | covered |

## Dialogs

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| Generate dialog | Generate summary + report (one run writes both tiers; the summary distills from the report session) | `POST /api/transcripts/:id/report` | `instructions?` (≤ 2000 chars), `useVideo` (false = text only), `runAt?` (ISO; "tonight" = next 02:00 local, or a custom time; ≤ 30 days out; answer `status` = running, queued or scheduled) | `generate <id> [--instructions …] [--no-video] [--run-at <iso or tonight>] --yes` (plan without `--yes`) | covered |
| Generate dialog | Regenerate ("Tell the AI what changed", "Regenerate…" on stale context or a previous transcription) | `POST /api/transcripts/:id/report` | same as above | `regenerate <id> … --yes` (alias; says REGENERATE when notes exist) | covered |
| Speaker review dialog | "Confirm N & generate" (save names, then the run the upload asked for) | `PUT /api/transcripts/:id/speakers`, then `POST …/report` per `gmeet_context.uploadPrefs.report` (`later` = no run) | `speakerLabels[]{…, email?}`; then `useVideo` (= pref is detailed-video) | `set-speakers <id> …` then `generate <id> --yes [--no-video]` (two verbs; the pref is the caller's choice) | covered |
| Speaker review dialog | Skip (no names, run per the upload pref) | `POST /api/transcripts/:id/report` | `useVideo` | `generate <id> --yes [--no-video]` | covered |
| Add-person dialog | Create a person (name + email), or "use existing" on 409 | `POST /api/people` | `name`, `email` | `add-person "<Name>" <email>` | covered |
| Share dialog | See who has access | `GET /api/transcripts/:id/shares` | — | `share <id>` | covered |
| Share dialog | Add a person (directory picker, edit or read) | `POST /api/transcripts/:id/shares` | `email`, `name`, `pplId`, `access` | `share <id> --add <email> [--access edit or read]` | covered |
| Share dialog | Change someone's access (edit ↔ read) | `PATCH /api/transcripts/:id/shares` | `email`, `access` | `share <id> --add <email> --access <level>` | covered |
| Share dialog | Remove someone | `DELETE /api/transcripts/:id/shares` | `email` | `share <id> --remove <email>` | covered |
| Share dialog | Make owner (transfer ownership) | `PATCH /api/transcripts/:id/shares` | `email`, `access` (= owner) | — (README: "web dialog only") | MISSING |
| Share dialog | See suggestions (people from the meeting not shared yet; badge count on Share) | `GET /api/transcripts/:id/share-suggestions` | — | `share <id> --suggestions` | covered |
| Share dialog | Add one suggestion | `POST /api/transcripts/:id/shares` | `email`, `name`, `pplId` (= 0), `access` | `share <id> --suggestions`, then `share <id> --add <email>` (directory check still applies) | covered |
| Share dialog | "Share with all N" suggestions (read) | `POST /api/transcripts/:id/shares` × N | `email`, `name`, `access` (= read) | `share <id> --add-suggested --access read` | covered |
| Link-event dialog | Choose a day, pick an event, join or keep separate | see detail-page link rows | — | `calendar --view all --from D --to D`, then `link` | covered (see the partial preview row) |
| Split dialog | Split off a part (range, title, optional event, keep in both) | `POST /api/transcripts/:id/split` | `fromMs`, `toMs`, `title?`, `eventRef?` (event key), `keepInBoth?` | `split <id> --from T --to T [--title] [--event] [--keep-in-both]` | covered |
| Split dialog | Suggest parts | `POST /api/transcripts/:id/clips/propose` | `instruction?` | `segments propose <id> [--instruction]` | covered |
| Split dialog | List events overlapping the part | `GET /api/calendar/events?from&to&sync=0` | `from`, `to`, `sync` | `calendar --view all --from D --to D --cached` | covered |
| Recordings sheet | See the meeting's segments | `GET /api/transcripts/:id/clips` | — | `segments <id>` | covered |
| Recordings sheet | List recordings that could be added | `GET /api/transcripts/:id/clips/candidates` | — | `segments candidates <id>` | covered |
| Recordings sheet | Measure the offset against the primary recording | `POST /api/recordings/:rid/align` | `against`, `nominalOffsetMs` or `searchWindowMs` | `segments align <rid> --against <rid2> [--near] [--window]` | covered |
| Recordings sheet | Add another recording at an offset with a text policy | `POST /api/transcripts/:id/clips` | `recordingId`, `offsetMs`, `textPolicy` | `segments add <id> <rid> --at T --text …` | covered |
| Recordings sheet | Change a segment's offset | `PATCH /api/transcripts/:id/clips/:ord` | `offsetMs` | `segments edit <id> <n> --at T` | covered |
| Recordings sheet | Change a segment's text policy | `PATCH /api/transcripts/:id/clips/:ord` | `textPolicy` | `segments edit <id> <n> --text …` | covered |
| Recordings sheet | Remove a segment | `DELETE /api/transcripts/:id/clips/:ord` | — | `segments rm <id> <n>` | covered |
| Transcribe-again dialog | Transcribe again (language, model, reason; confirm on same settings) | `POST /api/transcripts/:id/retranscribe` | `speechModel`, `languageCode`, `reason?`, `force?` | `transcribe-again <id> [--language] [--model] [--reason] [--force]` | covered |

## Listing (`src/components/transcript-table.tsx`, `listing-toolbar.tsx`, `label-rail.tsx`, `bulk-label-bar.tsx`, `calendar-meeting-rows.tsx`, home `src/app/page.tsx`)

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| Toolbar | Tabs All / Mine / Shared / Trash | `GET /api/transcripts?v=2&tab=…` | `tab`, `tz`, `days`, `minRows`, `cursor` | `list [FILTERS]` (always `tab=all`), `list --scratch` | partial — no `mine`, `shared` or `trash` tab |
| Toolbar | Search box (2+ chars) | `GET /api/transcripts?v=2` | `q` | `list --q` / `search <q>` | covered |
| Filter popover | Time range | `GET /api/transcripts?v=2` | `from`, `to`, `tz` | `list --from --to` | covered |
| Filter popover | People / provider filters | `GET /api/transcripts?v=2` | `participant`, `organizer`, `provider`, `speaker` | `list --participant --organizer --provider --speaker` | covered |
| Label rail | Filter by label (including sub-labels / exactly this label / unlabelled) | `GET /api/transcripts?v=2` | `label`, `exact` | `list --label <label or none> [--exact]` | covered |
| Filter popover | Layers: calendar rows that were recorded but never imported, or left nothing | `GET /api/calendar-meetings?view=…` | `view`, `tz`, filters | `calendar --view unimported` / `--view norec` | covered |
| Row ⋯ | Link to a calendar event… | `POST /api/transcripts/:id/link-event` | see detail-page link row | `link <id> <ref>` | covered |
| Row ⋯ | Keep (a grandfathered temporary row) | `PATCH /api/transcripts/:id` | `scratch` (= false) | `keep <id>` | covered |
| Row ⋯ | Retry transcription (status error) | `POST /api/transcripts/:id/retry-ingest` | — | `retry <id>` | covered |
| Row ⋯ | Move to trash | `DELETE /api/transcripts/:id` | — | `trash <id>` | covered |
| Row ⋯ | Cancel queued import (status waiting; the server deletes the placeholder) | `DELETE /api/transcripts/:id` | — | `trash <id> --cancel-queued` | covered |
| Trash tab row | Restore | `POST /api/transcripts/:id/restore` | — | `restore <id>` | covered |
| Trash tab row | Delete forever | `DELETE /api/transcripts/:id?permanent=1` | `permanent=1` | — (web-only by design) | MISSING |
| Row label chip | Add / remove a label on one row | `POST /api/transcripts/:id/labels` / `DELETE …/labels/:labelId` | `labelId` | `label` / `unlabel` | covered |
| Bulk bar | Add / remove a label on N selected rows | `POST /api/labels/bulk` | `transcriptIds[]`, `add[]`, `remove[]` | `label` / `unlabel` one id per call | partial — no multi-id form, the bulk route is unused |
| Bulk bar | Keep N selected temporary rows | `PATCH /api/transcripts/:id` × N | `scratch` (= false) | `keep <id>,<id>,…` | covered |
| Row badge | Summary badge action ("Review speakers & generate", "Generate", …) | none: navigates to `/transcript/<id>?do=<intent>`, which opens the review or generate dialog | `do` | — | NO-ROUTE |
| Label rail | New label / new sub-label | `POST /api/labels` | `path`, or `name` + `parentId` | `label-create <path> [--color]` | covered |
| Label rail | Rename a label | `PATCH /api/labels/:id` | `name` | `label-rename <label> <newName>` | covered |
| Label rail | Move a label (or to top level) | `PATCH /api/labels/:id` | `parentId` (number or null) | `label-mv <label> <newParent or />` | covered |
| Label rail | Change a label's color | `PATCH /api/labels/:id` | `color` | `label-color <label> <#rrggbb or none>` | covered |
| Label rail | Delete a label (with sub-labels) | `DELETE /api/labels/:id[?cascade=1]` | `cascade` | `label-rm <label> [--cascade]` | covered |
| Hidden calendar rows | See the hidden list ("Hidden (n)") | `GET /api/calendar-mutes` | — | `calendar hidden` | covered |
| Calendar row ⋯ | Hide this occurrence | `POST /api/calendar-mutes` | `kind` (= occurrence), `value` (event key), `title` | `calendar hide <event-key>` | covered |
| Calendar row ⋯ | Hide all occurrences + future ones | `POST /api/calendar-mutes` | `kind` (= series), `value` (recurring event id), `title` | `calendar hide <event-key> --series` | covered |
| Hidden calendar rows | Unhide | `DELETE /api/calendar-mutes?kind&value` | `kind`, `value` | `calendar unhide <event-key or value> [--series]` | covered |
| Calendar layers | Sync now (one poller sweep for the caller) | `POST /api/calendar/sync` | — → `lastPollAt` | `calendar --view all` re-reads its window live (no sweep) | partial — no sweep trigger, the unimported/norec layers are not refreshed |
| Calendar row ⋯ | "At Google Meet / Teams — check" for a recording or transcript | `POST /api/meet/evidence` or `POST /api/teams/evidence` | Meet: `meetingCode`, `startTime`, `event{id, recurringEventId}`; Teams: `meetingCode`, `eventId`, `startTime`, `endTime`, `event{recurringEventId, organizerEmail}` | `calendar check <event-key> [--teams]` | covered |
| Calendar row ⋯ | "In a file — upload…" for this event | media uploader opened with the event prefilled | see Upload row | `upload <file> --event <key>` | covered |
| Calendar row ⋯ | "On this Mac — Darth Recorder…" | loopback WebSocket to the tray (`ws://127.0.0.1:47800`, `upload` command) | — | — | NO-ROUTE |
| Import dialog | Import a Meet occurrence (transcript / video / both; queues when not ready) | `POST /api/gmeet/import` (browser Google token); Teams: `POST /api/teams/import` | `accessToken`, `mode`, `videoFileId`, `transcriptDocId`, `conferenceRecordName`, `force`, `defer`, `background`, `event{id, title, startTime, endTime, meetingCode, recurringEventId, iCalUID, organizerEmail, attendees[]}` | `import <meeting-code or event-key> [--mode] [--wait]` (via `POST /api/meetings/import {meetingCode or eventKey, mode}`, server-minted token) | covered |
| Import dialog | Import again over an existing import ("force") | `POST /api/gmeet/import` / `POST /api/teams/import` | `force` (= true) | `import` | partial — no `--force` |
| Import dialog | Join a colleague's existing import instead of cloning it | `POST /api/gmeet/join` / `POST /api/teams/join` | Meet: `meetingCode`, `startTime`, `accessToken`; Teams: invite-list proof checked server-side | — | MISSING |
| Import dialog | Bulk quick-import (transcript only, one after another) | `POST /api/gmeet/import` × N | `mode` (= transcript), … | `import` once per ref (scriptable) | partial — no batch form |
| Import dialog | Skip / unskip an event in the import list | `POST /api/gmeet/skips` / `DELETE /api/gmeet/skips?eventKey` | `eventKey`, `title` | — | MISSING |
| Import dialog | Mark everything up to now as synced | `POST /api/gmeet/sync-state` | — | — | MISSING |
| Import dialog | Re-check a row at Google / Teams | `POST /api/meet/evidence` / `POST /api/teams/evidence` | as the calendar-row check | `calendar check <event-key> [--teams]` | covered |
| Home reminders card | See "recorded but not imported" reminders | `GET /api/gmeet/reminders` | — | `reminders` (ids, when, provider, why, title) | covered |
| Home reminders card | Dismiss / Mute a reminder | `PATCH /api/gmeet/reminders` | `id`, `action` (dismiss or mute), `meetingCode`, `title`, `eventStart` | `reminders dismiss <id>` / `reminders mute <id>` | covered |
| Uploader | Upload media (language, calendar event, temporary, report pref, several files into one meeting, same-file check) | `POST /api/transcripts` (raw body, ≤ 8 MiB) or `POST /api/uploads` → `PUT …/chunks/:idx` or Blob → `POST …/complete` | `language_code`, `event` / `linkedEvent`, `scratch`, `report_pref`, `link_mode`, `multi_group`, `multi_index`, `multi_total`, `sha256`, `dupAware`, `force` | `upload <file> [--event] [--separate] [--language] [--scratch] [--title] [--wait]` | partial — no several-files-into-one-meeting (`multi_*`), no same-file duplicate check (`dupAware`/`force`); `report_pref` left out by design |
| Uploader | Same file found in the trash → Restore it | `POST /api/transcripts/:id/restore` | — | `restore <id>` | covered |
| Import-transcript dialog | Import a transcript file (.vtt .srt .txt .docx .pdf …) | `POST /api/transcripts/import-text` (raw body) | headers `x-filename`, `content-type` | `upload <file.vtt>` (text docs go to the text importer) | covered |
| Import-transcript dialog / uploader | Paste transcript text | `POST /api/transcripts/import-text` (JSON) | `text`, `title?`, `linkedEvent?`, `scratch?` | `upload <saved file>` | partial — no stdin / paste form |

## Recordings (`src/app/recordings/page.tsx`, `src/components/recordings-surface.tsx`, `src/app/recording/[id]/page.tsx`)

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| List | Sections (All / On your Macs / Uploaded / Temporary / Linked) + search | `GET /api/recordings` | `mine`, `tz`, `section`, `q`, `limit`, `cursor` | `recordings list [--section] [--q] [--all]` | covered |
| Detail | Open a recording (text + audio) | `GET /api/recordings/:id`, `…/content`, `…/audio` | — | `recordings get / text / audio <rid>` | covered |
| Row / detail | Make a meeting (title) | `POST /api/recordings/:id/make-meeting` | `title` | `recordings make-meeting <rid> --title T` | covered |
| Row / detail | Link the suggested event | `POST /api/recordings/:id/link` | `eventKey` | `recordings link <rid> <event-key>` | covered |
| Row / detail | Link via the event picker (+ join-or-separate choice) | `GET /api/recordings/:id/link-candidates`, then `POST /api/recordings/:id/link` | `accessToken`, `mode?`, `event{…}` | `recordings link <rid> <ref> [--separate]` | partial — no candidate preview (same as the meeting link row) |
| Row / detail | Dismiss the suggested event | `PATCH /api/recordings/:id` | `dismissSuggestedEvent` (= true) | `recordings dismiss <rid>` | covered |
| Row / detail | Keep (temporary → no expiry) | `PATCH /api/recordings/:id` | `keep` (= true) | `recordings keep <rid>` | covered |
| Row / detail | Delete for good | `DELETE /api/recordings/:id` | — | `recordings rm <rid>` | covered |
| Mac rows | Upload from this Mac / delete from this Mac / auto-upload switch | loopback WebSocket to the Darth Recorder tray (`upload`, `deleteRecording`, `setAutoUpload`) | — | — (`recordings list` shows the registry rows) | NO-ROUTE |
| Legacy meeting rows | Name it (becomes a meeting; a temporary one stops being temporary) | `PATCH /api/transcripts/:id` | `title`, `scratch` (= false) | `set-title <id> <title>` then `keep <id>` | covered |
| Legacy meeting rows | Keep | `PATCH /api/transcripts/:id` | `scratch` (= false) | `keep <id>` | covered |
| Legacy meeting rows | Link the confident tray match | `POST /api/transcripts/:id/link-event` | `eventKey` | `link <id> <event-key>` | covered |
| Legacy meeting rows | Trash / cancel upload | `DELETE /api/transcripts/:id` | — | `trash <id>` (placeholders refused, see "Cancel queued import") | covered |
| Legacy meeting rows | Retry | `POST /api/transcripts/:id/retry-ingest` | — | `retry <id>` | covered |

## Series (`src/app/series/page.tsx`, `series-dialog.tsx`, `series-definition.tsx`, `series-badge.tsx`)

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| Series page | List series | `GET /api/series` | — | `series` | covered |
| Series dialog | Open one series | `GET /api/series/:id` | — | `series <id>` | covered |
| Series page | Create a series | `POST /api/series` | `title`, `description`, `patterns[]`, `priority`, `labels[]` | `series create --title [--description] [--pattern]… [--label]… [--priority]` | covered |
| Definition editor | Preview what the patterns catch | `POST /api/series/preview` | `patterns[]`, `seriesId?` | `series preview --pattern … [--series <id>]` | covered |
| Definition editor | Save title / description / labels / patterns / priority | `PATCH /api/series/:id` | `title`, `description`, `labels`, `patterns?`, `priority?` | `series set <id> [--title] [--description] [--label]… [--pattern]… [--priority]` | covered |
| Series dialog | Auto-import on/off, mode, report flavour | `PATCH /api/series/:id` | `autoImport{enabled, mode, report}` | `series set <id> --auto-import on/off --mode … --report …` | covered |
| Series dialog | Delete the series | `DELETE /api/series/:id` | — | `series delete <id>` | covered |
| Definition editor | Add / remove an editor | `POST /api/series/:id/editors` / `DELETE …/editors?email` | `email`, `name` | `series editors add / rm <id> <email> [--name]` | covered |
| Definition editor | Transfer the series | `POST /api/series/:id/transfer` | `email`, `name` | `series transfer <id> <email>` | covered |
| Definition editor | Add / remove a follower | `POST /api/series/:id/followers` / `DELETE …/followers?email` | `email`, `name` | `series follow / unfollow <id> <email> [--name]` | covered |
| Series dialog | Remove a meeting ("not this series") | `DELETE /api/series/:id/members?transcriptId&remember=1` | `transcriptId`, `remember` | `series detach <id> <transcript-id> --remember` | covered |
| Series dialog | See past / upcoming occurrences (with Refresh) | `GET /api/series/:id/occurrences[?refresh=1]` | `refresh` | `series occurrences <id> [--refresh]` | covered |
| Series dialog | Import one occurrence | `POST /api/gmeet/import` / `POST /api/teams/import` | `mode` (transcript or video), `event{…}`, … | `import <meeting-code or event-key> [--mode]` | covered |

## Settings (`src/app/settings/page.tsx` and its cards, `setup-review-dialog.tsx`)

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| Google card | Connect / reconnect / manage Google | browser navigation to the darth-auth connections page; status from `GET /api/google/status` | — | (`auto-sync` prints `google: NOT connected`) | NO-ROUTE |
| Microsoft card | Connect / manage Microsoft | browser navigation to darth-auth connections; status from `GET /api/ms/status` | — | — | NO-ROUTE |
| Auto-sync card | Scope off / mine / all | `PUT /api/auto-sync` | `scope` | `auto-sync off/mine/all --consent …` | covered |
| Auto-sync card | Import mode | `PUT /api/auto-sync` | `mode` | `auto-sync <scope> --mode …` | covered |
| Auto-sync card | Report flavour | `PUT /api/auto-sync` | `report` | `auto-sync <scope> --report …` | covered |
| Auto-sync card | Providers (Meet / Teams) | `PUT /api/auto-sync` | `providers{gmeet}` / `providers{teams}` | `auto-sync <scope> --gmeet on/off --teams on/off` | covered |
| Notify card | Flip a Slack DM kind | `PUT /api/notify-prefs` | `prefs{<kind>: bool}` | `notify <kind> on/off --consent …` | covered |
| Setup review dialog | First-run review of notify + auto-sync | `PUT /api/notify-prefs`, `PUT /api/auto-sync` | as above | `notify`, `auto-sync` | covered |
| Vocabulary | Edit my vocabulary | `GET` / `PUT /api/vocab/user` | `vocab` | `vocab` / `vocab --set --file <path or ->` (consent-gated write) | covered |
| Vocabulary | Edit the org vocabulary | `GET` / `PUT /api/vocab/org` | `vocab` | `vocab --org` / `vocab --org --set --file …` (consent-gated write) | covered |
| Recorder card | Open / download / update Darth Recorder | `darth-recorder://open` URL scheme + a static DMG link | — | — | NO-ROUTE |

## Other pages and shell

| Area | Action (as the user sees it) | API route + method | Request body / params the UI sends | CLI verb today | Status |
| --- | --- | --- | --- | --- | --- |
| `/m/<uuid>` | Open a permanent meeting link | page route `src/app/m/[id]/route.ts` (redirect) | — | any `<id>` argument (`GET /api/meetings/resolve?m=`) | covered |
| Shell search band | Search meetings | `GET /api/search?q` | `q` | `search <q>` (`GET /api/transcripts/search`, a different route) | covered |
| Account menu | Who am I | `GET /api/whoami` | — | `whoami` | covered |
| `/login`, `/logout` | Sign in / out | page routes (SSO redirects) | — | — (`darth-cli login`) | NO-ROUTE |

---

## Proposals for every MISSING row

Several rows share one proposal. Grouped by proposed verb.

| Proposed verb | Covers (route) | Note |
| --- | --- | --- |
| `meetings set-description <id> --file <md or ->` | `PATCH /api/transcripts/:id {description}` | **BUILT (task 05)** — same shape as `set-notes` |
| `meetings keep <id>[,<id>…]` | `PATCH /api/transcripts/:id {scratch:false}` (detail, row ⋯, bulk bar, legacy recordings rows) | **BUILT (task 05)** — the meeting twin of `recordings keep` |
| `meetings purge <id> --yes` | `DELETE /api/transcripts/:id?permanent=1` (trash page and Trash-tab row) | today "web-only by design". Only do it on a row already in the trash, and require `--yes` |
| `meetings trash <id> --cancel-queued` | `DELETE /api/transcripts/:id` on a `waiting` placeholder | **BUILT (task 05)** — today `trash` refuses on purpose. A flag makes the hard delete explicit |
| `meetings generate <id> [--instructions …] [--no-video] [--run-at <ISO or tonight>] --yes` | `POST /api/transcripts/:id/report {instructions, useVideo, runAt}` (generate dialog, regenerate, retry, review Skip, review Confirm's second half) | **BUILT (task 05)** — the "no AI commands" rule was retired for it; plan-first unless `--yes`. `--no-video` → `useVideo:false`. Prints `status` (running, queued or scheduled) |
| `meetings generate <id> --cancel` | `DELETE /api/transcripts/:id/report` | **BUILT** — only clears the queued/scheduled marker. A run in flight is untouched (server doc) |
| `meetings hold <id>` | `POST /api/transcripts/:id/notes/hold` | **BUILT** — 409 with the server's reason once it already ran; pressing twice is a 200 |
| `meetings add-person "<Name>" <email>` | `POST /api/people {name, email}` | **BUILT** — 409 `exists` prints the existing record as the answer (exit 0) |
| `meetings speakers <id> --guess` | `POST /api/transcripts/:id/speakers/suggest` | **BUILT (task 05)** — voiceprint match, no LLM call. Then print `speakers` |
| `meetings edit-line <id> <n> --text "…"` | `PATCH /api/transcripts/:id/edits {utteranceIndex, text}` | **BUILT (task 05)** — needs `text <id> --index` (or `--json`) to show utterance indexes |
| `meetings replace <id> <find> <with> [--case] [--dry-run]` | `PUT /api/transcripts/:id/edits {edits}` | **BUILT (task 05)** — builds the edit map client-side as the find panel does (right-to-left per utterance) |
| `meetings link <id> --dismiss` | `PATCH /api/transcripts/:id {dismissSuggestedEvent:true}` | **BUILT (task 05)** |
| `meetings recordings dismiss <rid>` | `PATCH /api/recordings/:id {dismissSuggestedEvent:true}` | **BUILT (task 05)** |
| `meetings unlink <id>` | `PATCH /api/transcripts/:id {unlinkEvent:true}` | **BUILT (task 05)** — print `sharesRemoved[]` — the people who lose access |
| `meetings fetch-recording <id>` | `POST /api/transcripts/:id/fetch-audio` | **BUILT (task 05)** — pulls the Drive / Graph video (backend token) |
| `meetings retry <id>` | `POST /api/transcripts/:id/retry-ingest` | **BUILT (task 05)** — listing row, ingest note, legacy recordings rows |
| `meetings reimport <id> [--mode video or both] [--combine]` | `POST /api/gmeet/import {sourceTranscriptId, force, mode, videoFileId?, event}` (re-transcribe from video, combine videos, rerun diarization) | the route needs a browser token today. Either give it a server-minted-token path like `/api/meetings/import`, or add `sourceTranscriptId`/`force` to `/api/meetings/import` |
| `meetings activity <id> [--limit N]` | `GET /api/transcripts/:id/activity` | **BUILT (task 05)** — read-only |
| `meetings ai-runs <id>` | `GET /api/transcripts/:id/ai-runs` | **BUILT (task 05)** — read-only: kind, when, who, duration, cost |
| `meetings attach <id> <file> [--title T]` | `POST /api/transcripts/:id/attachments` (raw body, `x-filename`, `x-title`) | **BUILT (task 05)** |
| `meetings attach <id> --text <file or -> [--title T]` | `POST /api/transcripts/:id/attachments {kind:'text', title, text}` | **BUILT (task 05)** |
| `meetings attachment-rm <id> <attId>` | `DELETE /api/transcripts/:id/attachments/:attId` | **BUILT (task 05)** |
| `meetings share <id> --make-owner <email> --yes` | `PATCH /api/transcripts/:id/shares {email, access:'owner'}` | the README keeps this web-only on purpose. Building it means reversing that decision |
| `meetings share <id> --suggestions [--add-suggested] [--access read]` | `GET /api/transcripts/:id/share-suggestions` (+ `POST …/shares` per suggestion) | **BUILT (task 05)** — also covers the "Share with all N" row |
| `meetings label-color <label> <#rrggbb>` | `PATCH /api/labels/:id {color}` | **BUILT (task 05)** |
| `meetings calendar hidden` | `GET /api/calendar-mutes` | **BUILT (task 05)** |
| `meetings calendar hide <event-key> [--series]` | `POST /api/calendar-mutes {kind, value, title}` | **BUILT (task 05)** — `--series` → `kind:'series'`, value = the row's recurring event id |
| `meetings calendar unhide <event-key or recurring-id> [--series]` | `DELETE /api/calendar-mutes?kind&value` | **BUILT (task 05)** |
| `meetings calendar check <event-key>` | `POST /api/meet/evidence` / `POST /api/teams/evidence` | **BUILT (task 05)** — calendar row check and the import dialog's re-check |
| `meetings import <ref> --join` | `POST /api/gmeet/join` / `POST /api/teams/join` | Meet join needs the caller's Google token: a server-minted-token path like `/api/meetings/import` |
| `meetings calendar skip <event-key> [--undo]` | `POST` / `DELETE /api/gmeet/skips` | low value outside the import dialog |
| `meetings calendar mark-synced` | `POST /api/gmeet/sync-state` | low value outside the import dialog — could stay web-only |
| `meetings reminders` / `meetings reminders dismiss or mute <id>` | `GET` / `PATCH /api/gmeet/reminders {id, action, meetingCode, title, eventStart}` | **BUILT (task 05)** |
| `meetings series occurrences <id> [--refresh]` | `GET /api/series/:id/occurrences` | **BUILT (task 05)** |
| `meetings vocab [--org] [--set --file <json or ->]` | `GET` / `PUT /api/vocab/user`, `/api/vocab/org {vocab}` | **BUILT (task 05)** — settings-class write: put it behind the `meetings:settings` `--consent` like `notify` |

### Partial rows: what to add

| Row | Add |
| --- | --- |
| Speaker description | `set-speakers <id> A=… --describe A="…"` (keep the merge rule; send `description`) |
| + Person | `meetings people add "<name>" <email>` → `POST /api/people`. On 409, print the existing person |
| Link candidates (meetings and recordings) | `link <id> <ref> --dry-run` / `recordings link <rid> <ref> --dry-run` → `GET …/link-candidates`, print the meeting it would join |
| Add a recording file to this meeting | `upload <file> --source <id>` → `source_id=` |
| Series membership on detail | `get <id>` prints a `series:` line from `GET /api/transcripts/:id/series` |
| Listing tabs | `list --tab mine, shared or trash` (`trash` = legacy `?trash=1` shape or v2 `tab=trash`) |
| Bulk labels | `label <id,id,…> <label>` / `unlabel <id,id,…> <label>` → one `POST /api/labels/bulk {transcriptIds, add or remove}` |
| Sync now | `calendar sync` → `POST /api/calendar/sync` (prints `lastPollAt`) |
| Import force | `import <ref> --force` (needs `force` accepted by `/api/meetings/import`) |
| Bulk quick-import | `import <ref>,<ref>…` sequential, per-ref result |
| Reminders list | covered by the `reminders` proposal above |
| Upload: several files into one meeting, same-file check | `upload <f1> <f2> … --one-meeting` (`multi_*`); opt in to the `dupAware` answer and add `--force` = "upload anyway" |
| Paste transcript text | `upload - --text [--title T]` → `import-text` JSON `{text, title}` |
| Legacy "name it" | `set-title` also sends `scratch:false` when the row is temporary (or document `keep` + `set-title`) |
| Share suggestion add / share with all | the `share --suggestions --add-suggested` proposal |
| Review Confirm & generate | `set-speakers` + the `generate` proposal (design-rule decision) |

### NO-ROUTE rows: proposals

| Row | Mechanism | Proposal |
| --- | --- | --- |
| Download edited / raw markdown | browser-side render from `/content` + `/edits` + `/speakers` | none needed. `text <id>` is the edited text. Add `text <id> --raw` if raw ASR text is wanted |
| Summary badge action | navigation to `/transcript/<id>?do=<intent>` | none. The `generate` / `set-speakers` verbs are the CLI form |
| Darth Recorder "On this Mac" (calendar row, recordings Mac rows: upload / delete / auto-upload) | loopback WebSocket `ws://127.0.0.1:47800` to the tray | none on the server. Tray-local by design. A CLI on the same Mac could speak the tray protocol, but that belongs to the tray's own tooling |
| Google / Microsoft connect | browser OAuth on the darth-auth connections page | none (needs a browser). A read-only `meetings connections` (`GET /api/google/status`, `GET /api/ms/status`) would be cheap |
| Darth Recorder open / download | `darth-recorder://` URL scheme + static DMG link | none |
| Login / logout | SSO page routes | none (`darth-cli login`) |

---

## Routes and verbs with no UI caller (for the record)

- `POST /api/transcripts/:id/notes` (regenerate the quick summary alone, `instructions`, `fromReport`): **no web caller**. The generate dialog only POSTs `/report`, and the summary distills from that session. A CLI `generate` should target `/report` too, to match.
- `PUT /api/transcripts/:id/notes`, `PUT /api/transcripts/:id/report` (`set-notes` / `set-report`): **CLI-only**. The web UI has no manual notes or report editor. Nothing to mark: there is no UI action.
- `POST …/transcriptions/merge` (`merge-transcriptions`), `GET …/transcriptions/:tid/content` (`text --version`), the `recordings` version verbs, `/api/auto-sync/plan` (`auto-sync explain`), `/api/offline/plan` + `/api/offline/prefs` (`offline …`; the web offline mode was removed and lives in the desktop shell), `/api/transcripts/:id/frames/:frame` (`frame`), `/api/transcripts/:id/audio` (`audio`), `export`, `calendar --view all`, `upload` resumable sessions: CLI or shell only. There is no web-UI action to compare.
- `POST /api/ask` (`AskAiPanel`): the component exists but nothing mounts it, so there is no live UI action. It would be an AI command anyway.
- `POST /api/series/:id/merge`, `POST /api/series/retro-attach`, `GET /api/series/occurrence-counts`, `GET /api/vocab/org/history`, `/api/recorder/*` (tray ↔ server), `/api/admin/recorder/*` (admin), `/api/events` (SSE), `/api/google/token`, `/api/auth/*`, `/api/health`: no user action in the pages audited, or not a meetings-user surface.

## Excluded (pure-view affordances, not rows)

- Video/audio playback and scrubbing (`GET …/audio[?part=N]` streaming), click-to-seek from outline / notes frames / utterances, the raw ↔ edited view toggle (reads `GET …/edits`), section collapse/expand, the mobile outline drawer.
- Column show/hide/reorder and group-by-day (localStorage), the label rail open/closed state, the reminders banner collapse, recent searches.
- Copy link (`/m/<uuid>`), Copy markdown, the ⌘F / keyboard shortcuts, focus handling.
- Background polling and refresh: the live-events SSE stream, the 4 s / 10 s / 15 s status polls, the session keeper, the share-suggestion badge count refresh, the "Refresh" buttons on the listing and recordings pages.
- Auto-fetch of the Drive video on page load (the manual "Fetch video" button is a row).
- Directory search inside pickers (`GET /api/users/search`), which is part of the naming/share actions above, not an action of its own.

## Counts

Recounted after task 05 (2026-10-27; a row's status is the last table cell):

```
actions audited : 159
covered         : 130   (83 before task 05; 47 flipped by the verbs it built)
partial         : 12
MISSING         : 9   (left as proposals — need a decision or a server change, see above)
NO-ROUTE        : 8   (no server route; proposals above)
```

Verbs built in task 05 (26, calendar's four sub-verbs counted once): generate / regenerate [--cancel], hold, add-person, help <verb> [<sub>],
set-description, keep, trash --cancel-queued, unlink, link --dismiss, fetch-recording, retry, activity,
ai-runs, attach, attachment-rm, share --suggestions / --add-suggested, speakers --guess, text --index,
edit-line, replace, recordings dismiss, label-color, calendar hidden / hide / unhide / check,
reminders [dismiss | mute], series occurrences, vocab [--set].

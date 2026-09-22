# Linking a recording to a meeting is a USER action — build brief (2026-09-22)

Status: **build brief**, written 16:20 SGT after the incident below. Two builders: **A** (this repo: server + web),
**B** (`poc/mac-recorder`, the Darth Recorder tray). They share the contract in §3 and must not change it.

## 1. The incident (why)

Row 935 (`4f677f3a-5946-4da0-8126-7d376cf0de4b`): a Darth Recorder recording of a **Slack DM huddle** (tray reported
`call.app = "Slack"`, `call.kind = "slack"`, `call.title = "Swaralee (DM) - …"`, `shares: []`, started 15:48:48 SGT,
8 min) was **auto-linked by the server** to the Google Meet event **"Triton next steps!"** (15:30–16:30, meeting code
`bgs-zqvv-dby`, 9 invitees) because `recorder-match` scored it `0.7` = time overlap `1` × weight `0.7` + title score
`0`, and `recorderMatchIsConfident` accepts ≥ 0.6. The link made the placeholder inherit the event's title, date,
attendees and — the harm — **auto-shared the private call with 8 people (edit access)** the moment it was born.
Repaired by hand at 16:10 SGT (shares deleted, event keys removed from `gmeet_context`, title + `recorded_at` set;
`gmeet_context.unlinkedBy` records it). Nobody but Alok had opened it.

Alok's decision (verbatim intent): *"uploading should be an action from the user — we just pop up and ask to confirm,
or if not, open the recording in the meeting UI to connect the recording to the meeting."*

## 2. Decisions

- D1 **The server never applies a recorder match on its own.** `POST /api/uploads` (route.ts ~line 230) stops turning
  `recorderMatch` into `linkedEvent`. A recording uploaded without an explicit `linkedEvent`/`eventRef` is born
  UNLINKED: title = the call's own title (`call.title` cleaned of the app suffix, e.g. "Swaralee (DM)") or the
  filename, `recorded_at` = `recorder_recordings.started_at`, **no attendees, no auto-share**.
- D2 **The match survives as a suggestion**, not a link: `gmeet_context.suggestedEvent = { key, eventId, title,
  startIso, endIso, provider, meetingCode, score, overlap, titleScore, callKind }` written at upload open (part 1 only),
  cleared when the row is linked (any path) or when the user says "Not this" (`suggestedEvent.dismissedAt`).
- D3 **A provider mismatch vetoes confidence.** In `recorder-match.ts`: when the tray's `call.kind` is known
  (`slack` | `teams` | `meet` | `zoom` | …) and the occurrence's conferencing provider is known and different, the
  candidate's score is capped at `0.3` (still listed as a candidate, never "confident", never the top suggestion over
  a same-provider one). Time overlap alone (title score 0) never reaches `MIN_SCORE` for confidence either: raise the
  bar so `overlap 1 + title 0` is a suggestion, not a confident match (`recorderMatchIsConfident` = score ≥ 0.6 AND
  (titleScore > 0 OR same provider)). Keep every existing test green; add tests for both rules with the incident's
  numbers.
- D4 **Linking = the user, on either surface.**
  - Tray (B): when a recording ends and `matched` is present, the upload card asks **"Link to 'Triton next steps!'
    (15:30)?" [Link] [Not this]** before/while uploading. Link → upload with `linkedEvent` = that event key (the
    existing explicit path: the server resolves it exactly as the web stepper's link — title, date, attendees,
    invitee auto-share; the human said yes). Not this → upload unlinked and, when the transcript exists, **open
    `https://meetings.darth-internal.trames.io/transcript/<id>?link=1`** so the person connects it in the web UI.
    No answer within the card's life → unlinked, never linked. The dialog copy must show the call's own app + title
    next to the event so a mismatch (Slack call vs Meet event) is obvious.
  - Web (A): a strip on the transcript page (and the listing row's recording strip) when `suggestedEvent` is present
    and undismissed: **"Looks like 'Triton next steps!' · 15:30–16:30 · Google Meet — Link to it · Not this"**.
    "Link to it" runs the existing link flow (the same one darth-cli `meetings link` uses — metadata + share
    SUGGESTIONS, nothing shared until accepted); "Not this" dismisses. `?link=1` on the transcript page opens the
    existing "link the calendar event" picker directly. darth-cli `meetings get` prints `suggested event:` when set
    (CLI repo is another session's — write the two-line spec for it in the as-built notes, do not edit `../cli`).
- D5 **Unlink exists as a first-class action** (web ⋯ menu "Unlink from event…", `PATCH /api/transcripts/:id`
  `{unlinkEvent: true}`): removes the event keys, the attendees and every share that the link created
  (shares whose `shared_at` equals the link write, or better: stamp link-born shares with `origin='event-link'` from
  now on and delete by origin), keeps the recording, title and date as they are, writes `gmeet_context.unlinkedBy`.
  Same for darth-cli later (spec line only).
- D6 **Audio-only recordings say why.** The player's gear menu on a recording with no video says *"This recording has
  no video — the recorder captured audio only"* (and, when `recorder_recordings.call.app` is known, *"… during a
  Slack call; screen shares in Slack are not captured yet"*) instead of a dead end. B investigates whether the tray's
  share watcher (replayd/tccd unified log) sees Slack huddle screen shares at all — the 15:48 SGT call on Alok's Mac
  today is the sample (**read the unified log only; never record, capture or screenshot anything**); if the bundle
  id `com.tinyspeck.slackmacgap` shows up in the log the fix is to add it to the watcher; if it does not, say so and
  stop.

## 3. Contract (both builders)

- `POST /api/uploads` (open) body: unchanged. Response: unchanged shape, **plus** `suggestedEvent` (D2 shape) when
  a recorder match exists and no `linkedEvent` was given. `linkedEvent` in the response is now ONLY ever the caller's
  explicit link.
- The tray keeps sending `recorderRecordingId`; it sends `linkedEvent: { key }` **only after the user tapped Link**.
  Event key spelling is unchanged (`<meetingCode>|<startIso>` or the calendar event key the tray already stores in
  `matched.event_key`).
- `PATCH /api/transcripts/:id` gains `{ unlinkEvent: true }` and `{ dismissSuggestedEvent: true }`.
- Transcript page URL `?link=1` opens the link picker.

## 4. Split

- **A** (repo root, no tray files): D1, D2, D3 (+ tests), D4-web, D5, D6-web copy. Runbook/as-built notes go in
  this file under "As built — A". `bun test`, `bunx tsc --noEmit`, `bunx eslint` on touched files, `bun run build`
  with no env. No deploy, no prod DB, no git push; commit on main with plain subject+body (no attribution lines),
  after `git status -s` + `git diff --cached` (another builder edits `poc/mac-recorder/**` concurrently — never
  `git add` a path you did not touch).
- **B** (`poc/mac-recorder/**` only): D4-tray (dialog, Link/Not this, open the web URL), D6 investigation, bump
  VERSION to 0.3.13, `swift build` clean; **do not run `make-app.sh --release` or `deploy-to-dot6.sh`** (Alok's
  call). As-built notes under "As built — B" here (this is the ONE file both may edit: append only, your own
  section). Commit the same way.

## As built — A

(builder A appends)

## As built — B

(builder B appends)

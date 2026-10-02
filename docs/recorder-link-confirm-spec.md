# Linking a recording to a meeting is a USER action — build brief (2026-09-22)

Status: **build brief**, written 16:20 SGT after the incident below. Two builders: **A** (this repo: server + web),
**B** (`poc/mac-recorder`, the Darth Recorder tray). They share the contract in §3 and must not change it.

> **Reversal note — 2026-10-02 (~12:00 SGT, owner).** What a USER link does to sharing changed: a meeting linked to a
> calendar event (any path — tray Link, web stepper, calendar-row Upload, `darth-cli --event`, `POST
> /api/recordings/:id/link`, retro-link / "Link to it", split-to-an-event, a linked text import) is now **shared with
> the event's internal invitees exactly as a cloud import is** (internal domains, edit, no DM), stamped
> `origin='event-link'` so D5's Unlink still takes those shares back off. This undoes design P4's "a link never
> shares" (2026-09-23) and restores what D4 below already describes for the tray ("invitee auto-share; the human said
> yes"). **Unchanged:** D1–D4's rule that only a PERSON links — a recorder match is still a suggestion, never a link,
> so it can never share by itself (the web banner's "Upload now" no longer forwards the tray's match as a link for
> exactly that reason). The recording itself is still never shared: `/api/recordings/*` answers its owner alone, and
> a share recipient reaches the media only through the meeting. Details:
> `docs/recordings-meetings-series-design.md` "As built — a link shares like an import (2026-10-02)".

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
    SUGGESTIONS, nothing shared until accepted; **since 2026-10-02 the link itself shares the meeting with the
    internal invitees**, see the reversal note at the top); "Not this" dismisses. `?link=1` on the transcript page opens the
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

Built 2026-09-22, 17:40–19:20 SGT. All of A's split: D1, D2, D3 (+ tests), D4-web, D5, D6-web copy.
`bun test` 1125 pass / 0 fail (65 files, `TZ=UTC`), `bunx tsc --noEmit -p .` clean, `bunx eslint` on every touched
file clean (the 3 `react-hooks/exhaustive-deps` warnings in `transcript/[id]/page.tsx` at 749/1452/1500 are
pre-existing — no diff hunk of mine is within 600 lines of them), `bun run build` compiles with **no** PG/AAI env.

### D1 — the server never applies a recorder match

- `src/app/api/uploads/route.ts:186-199` — the registry read now produces `recorderBirth` + `suggestedEvent`
  instead of a `recorderMatch`; `:223-231` is what is left of the auto-link block: one line,
  `if (linkedEvent || (multi && multi.index > 1)) suggestedEvent = null;`, under the comment that says why.
  `resolveLinkedEventRef` is still imported — it serves the caller's own explicit `eventRef` (`:146`).
- Birth facts: `src/lib/server/upload-pipeline.ts` `openUpload` — title chain
  `sourceRow → linkedEvent → recorderBirth.title` (`:679-687`) and date chain
  `sourceRow.recorded_at → linkedEvent.startTime → recorderBirth.startedAt` (`:703-706`). No attendees ⇒
  `autoShareToInternalInvitees` is not called at all for an unlinked upload (the call is already gated on
  `attendees.length > 0`, `:697`).
- The call's own name: `recorderCallTitle()` in `src/lib/recorder.ts:69-87` — strips a KNOWN app suffix only
  (`" - Slack"`, `" | Microsoft Teams"`, `" – Google Chrome"`, two passes for a browser title), returns null when
  nothing usable is left so the filename still wins. `"Alok <> Paola - weekly"` survives intact.
- `POST /api/transcripts` (one-shot: darth-cli, older trays) gets the same treatment through the shared helper
  `recorderOpenFacts()` (`src/lib/server/upload-pipeline.ts:231-266`, called at
  `src/app/api/transcripts/route.ts:263` and passed at `:324` / `:387`), so the two upload routes cannot drift.

### D2 — the match survives as a suggestion

- Wire shape `SuggestedEvent` in `src/lib/format.ts:194-230` (the spec's fields verbatim, plus the optional
  `dismissedAt`), carried on `gmeet_context.suggestedEvent` (`:681`).
- Written at open: `suggestedEventFromMatch()` (`src/lib/server/recorder-match.ts:209-229`) →
  `openUpload`'s `suggestionMarker`, which is stamped on the placeholder only when there is no `linkedEvent`
  (`src/lib/server/upload-pipeline.ts:655-657`). Part 1 only (both routes).
- Returned by `POST /api/uploads` as `suggestedEvent` alongside the unchanged 201 body
  (`src/app/api/uploads/route.ts:381-386`) — contract §3.
- Cleared on link, any path: `POST /api/transcripts/:id/link-event` removes the key after the merge
  (`src/app/api/transcripts/[id]/link-event/route.ts:226-233`); an upload that carries `linkedEvent` never
  writes one. Dismiss stamps `dismissedAt` (D4 below).
- `matched.occ_end` was added (`src/lib/recorder.ts:95-98`, written in `scoreOccurrences`) because the
  suggestion needs `endIso` and candidates only carried the start.

### D3 — provider veto + "overlap alone is not confidence"

- **The occurrence row does NOT carry a provider.** `calendar_event_cache` has `meeting_code` (Google's Meet code,
  or our synthetic `teams-…`), `location`, `description`, `html_link` and nothing else — a Teams/Zoom/Webex
  occurrence is only identifiable by its join URL in the free text. So `listOccurrencesOverlapping` now also
  selects `left(location || ' ' || description, 2000) AS conference_hint`
  (`src/db-ops/calendar-event-cache.ts:1193-1245`) and `occurrenceProvider()`
  (`src/lib/server/recorder-match.ts:43-63`) derives: `teams-…` code → teams, `abc-defg-hij` → meet, else
  `teams.microsoft.com` / `meet.google.com` / `zoom.us` / `webex.com` in the hint. Anything else is **unknown**,
  and unknown never vetoes.
- Call side: `callProvider()` (`src/lib/recorder.ts:37-42`) maps the tray's `call.kind`; `browser` and `other`
  are UNKNOWN, not "something else".
- The cap: `scoreOccurrences()` (`src/lib/server/recorder-match.ts:144-207`) caps a known-mismatch candidate at
  `PROVIDER_MISMATCH_CAP = 0.3`, stamps `provider_mismatch: true`, keeps it in the candidate list, and the sort
  breaks ties against it so it can never sit above a same-product candidate.
- The bar: `recorderMatchIsConfident()` moved to `src/lib/recorder.ts:147-176` (pure, client-safe, next to the
  shape it reads; `upload-pipeline` re-exports it so every existing import keeps working). It is now
  `score ≥ 0.6 AND overlap ≥ 0.5 AND NOT provider-mismatch AND (title_score > 0 OR same provider)`.
  The incident's `overlap 1 / title 0 / score 0.7` fails it twice over.
- It is not dead code: `GET /api/recorder/recordings` serves `matched_confident` on the OWNER's view
  (`src/lib/server/recorder-view.ts:32-41, 79`) so B's tray can word the ask without carrying a copy of the rule.
- Tests: `src/lib/server/__tests__/recorder-match.test.ts` (17 tests) — the incident's own numbers, both new
  rules, the "a vetoed candidate is still listed" case, `occurrenceProvider` / `callProvider` tables, and D1's
  title cleaning. Every pre-existing `recorderMatchIsConfident` test in
  `src/lib/server/__tests__/upload-group-progress.test.ts` still passes untouched (its fixture has
  `title_score: 1`).

### D4-web — the strip, and `?link=1`

- `src/components/suggested-event-strip.tsx` — "Looks like “Triton next steps!” · 15:30–16:30 · Google Meet —
  Link to it · Not this · Pick another…". **Link to it** posts `{eventKey}` to `:id/link-event` (the same flow
  darth-cli `meetings link` uses: metadata + share SUGGESTIONS, nothing shared until accepted); **Not this**
  PATCHes `{dismissSuggestedEvent:true}`; **Pick another…** opens the existing calendar picker.
- Copy is shared and pure: `src/lib/suggested-event.ts` (`suggestedEventLine`, `suggestedEventWhy`,
  `providerLabel`, `occurrenceTimeRange`, `noVideoNote`) with 9 tests in
  `src/lib/__tests__/suggested-event.test.ts`. The tooltip always names BOTH halves — "This recording is a Slack
  call and that invite is Google Meet — check before linking" — because not showing that is what the incident was.
- Transcript page: strip under the header's "Not linked to a calendar event" line
  (`src/app/transcript/[id]/page.tsx:3215-3233`), gated on `canEdit && !offline && !hasCalendarEvent &&
  !dismissedAt` (`:2283-2290`). A read-only share never sees it.
- Listing: `suggested_event` is projected on v2 rows (`src/db-ops/transcripts.ts:481-494` in the materialized
  base, `:619` in the outer SELECT where it is **gated to `__access IN ('owner','edit')`** — the suggestion names
  an occurrence from the owner's own calendar), typed on `TranscriptListRow`
  (`src/lib/format.ts:758-763`), rendered compactly under the recording strip
  (`src/components/transcript-table.tsx:2129-2145`, re-checking `access` because offline rows come from cache).
- `?link=1` opens the picker on arrival and strips itself from the URL (`src/app/transcript/[id]/page.tsx:346-359`)
  — that is the URL B's tray opens after "Not this".

### D5 — unlink

- Migration **`migrations/048_share_origin.sql`**: `transcript_shares.origin text` + a partial index. Additive;
  the code works without it (`src/db-ops/share-origin.ts` probes once per process and warns, exactly like
  `db-ops/aai-job-id.ts`).
- Link-born shares are stamped: `autoShareToInternalInvitees(…, { origin })` (`src/lib/server/auto-share.ts`) and
  `addShare({ …, origin })` (`src/db-ops/transcript-shares.ts:83-108`, column conditionally included). The upload
  path passes `SHARE_ORIGIN_EVENT_LINK` (`src/lib/server/upload-pipeline.ts:693-700`). Nothing else stamps:
  a Meet/Teams IMPORT's shares are not link-born and an unlink must not take them.
- `PATCH /api/transcripts/:id {unlinkEvent:true}` (`src/app/api/transcripts/[id]/route.ts:182-231`): reads the
  attendees first, deletes the link-born shares (`removeLinkBornShares`), then removes the event keys and stamps
  `gmeet_context.unlinkedBy {at,userId,email,eventId,eventTitle,meetingCode,sharesRemoved}` in ONE statement
  (`removeGmeetContextKeysForUser`, `src/db-ops/transcripts.ts:1740-1766` — `||` cannot delete a key, it only
  sets it to JSON null, and every reader in the app asks `? 'eventId'`). Recording, transcript, title and date are
  untouched. Response carries `sharesRemoved: string[]`. Owner + editors; read-only gets the existing 403.
  Keys removed: `eventId, eventTitle, startTime, endTime, meetingCode, recurringEventId, iCalUID, organizerEmail,
  attendees, provider, teams, actuals, meetTranscript, videoFileId, transcriptDocId`.
- **Older rows (no stamp) are handled**: `removeLinkBornShares` falls back to the auto-share's own signature —
  shared_by = owner, access = 'edit', email ∈ the event's attendee list. A hand-made share to someone who is also
  an invitee would go too, so the web confirm says so out loud before asking ("Anyone who was shared in BECAUSE
  of the link (up to N invitees) loses access. Shares you made yourself stay.") and the result lists every email
  removed (`src/app/transcript/[id]/page.tsx:2366-2414`). The action is in the quick-actions menu as
  **"Unlink from event…"**, under the Re-link entry (`:2570-2587`).
- `{dismissSuggestedEvent:true}` lives in the same PATCH (`:158-180`); 409 when there is no suggestion.

### D6-web

- `noVideoNote()` (`src/lib/suggested-event.ts:81-97`) → "This recording has no video — the recorder captured
  audio only, during a Slack call; screen shares in Slack are not captured yet." / "…during a Microsoft Teams
  call." / bare sentence when the app is unknown.
- Rendered by `AudioPlayer` exactly where the "Show video" toggle would be when `hasVideo` is false
  (`src/components/audio-player.tsx:681-685`, new `noVideoNote` prop). The transcript page passes it **only for a
  tray recording** (`src/app/transcript/[id]/page.tsx:3350-3355`) — nothing else knows which app the call was in.
- To make that possible the recorder marker now carries the call: `gmeet_context.recorder = {recordingId, app?,
  kind?}` (`src/lib/format.ts:483-494`), stamped at upload open from the registry row. Older rows have only the
  id and get the bare sentence.

### darth-cli — the two-line spec (CLI repo is another session's; `../cli` untouched)

1. `meetings get <id>` — when `gmeet_context.suggestedEvent` is set and has no `dismissedAt`, print one extra line
   after `event:`/`linked:`:
   `suggested event: "<title>" <startIso> [<provider>] (score <score>, overlap <overlap>, title <titleScore>; call was <callKind>) — link with: darth-cli meetings link <id> "<key>"`.
   Never print it for a row that already has `gmeet_context.eventId`, and never as `event:` — it is a guess the
   server deliberately did not apply.
2. `meetings unlink <id> [--yes]` (future) — `PATCH /api/transcripts/<id> {"unlinkEvent": true}`; print the
   event that was detached and every address in the response's `sharesRemoved`, and without `--yes` confirm first
   with the same sentence the web uses ("shares the LINK created are removed; shares you made yourself stay").
   `meetings get` should also print `unlinked by <email> at <at>` when `gmeet_context.unlinkedBy` is present.

### Runbook (what Alok runs)

```bash
# 1. migration 048 — additive, safe to apply before the code ships
psql "$(…meeting-whisperer prod conn…)" -f migrations/048_share_origin.sql   # prod schema is hard-coded in the file
# 2. nothing else: no env var, no flag, no restart order. Until 048 is applied the app logs
#    "[share-origin] column missing …" once per process and unlink falls back to the attendee-signature arm.
```

### Not done / notes for whoever picks this up

- **No deploy, no prod DB, no push** (per the brief) — this is committed on `main` locally only.
- The suggestion is computed from the registry row's stored `matched`. Recordings matched BEFORE this commit have
  no `provider` / `occ_end` / `call_provider` on `matched`, so their suggestion shows no product and
  `recorderMatchIsConfident` falls back to the title-agrees arm. Re-matching happens on the next write to the
  recording — nothing backfills, and nothing needs to.
- `conference_hint` truncates the description at 2000 chars. A join URL buried below that in a long invite reads
  as "unknown provider", which is the safe direction (no veto, no false confidence).
- Rows repaired by hand (935) already have `unlinkedBy` written by the repair; the new writer uses the same key
  and shape.
- Not touched, deliberately: `poc/mac-recorder/**` (B) and `../cli`.

## As built — B

Built 2026-09-22, 16:05–16:45 SGT (tray only: `poc/mac-recorder/**` + this section). Version **0.3.13**,
`swift build -c release --product darth-tray` clean (0 errors; the only warnings in the two files I touched are
pre-existing lines — `main.swift:1215` `Any?`→`Any`, `Banner.swift:502/543`). **Not released**: no
`make-app.sh --release`, no `deploy-to-dot6.sh`, nothing published to the update feed — Alok's call. The dev
build was installed to `~/Applications` for testing and Alok's `/Applications` 0.3.12 release is running again.

### D4-tray — the card, the answer, the upload

- **The question** (`Sources/darth-tray/Banner.swift:272` `showLinkConfirm`, actions `:316`, handlers `:623/:627`):
  *Link to "Triton next steps!" (15:30)?* with the call's own line underneath —
  *This recording: Slack · 15:48 · "Swaralee (DM) - Trames Pte Ltd - 1 new item…"*. Buttons **Link** (primary) /
  **Not this** (secondary); no × (`set(...)` hides it), so the two buttons and the deadline are the only ways out.
  App and clock time come BEFORE the window title in that line on purpose: a call app's title is 60 characters of
  notification noise and what makes a wrong match obvious is the app and the time.
- **When it is asked** (`main.swift:1084`, in `recordingStopped`): `willUpload && !terminating &&
  matchedSuggestion(id) != nil`. `matchedSuggestion` (`:687`) reads `matched.event_key` + `matched.title` off the
  registry row — the server's own match, mirrored by every sync answer (`Api.swift:191`) — and needs both to ask.
  A recording with no match behaves exactly as before. While the card is up the recording is NOT marked as
  uploading (no tracker, no progress card): it is not uploading yet.
- **The answers** (`askLink` `:724`, `answerLink` `:744`). Link → `startUpload(id, linkedEvent: ["key": key])`.
  Not this → `Registry.update(id, ["link_prompt": "not_this"])` + an unlinked upload; when that upload comes back
  with a transcript id (`uploader.onDone`, `main.swift:284`) the tray opens
  `…/transcript/<id>?link=1` (`openTranscript(_:link:)` `:615`) and clears the stamp. The stamp is on the ROW,
  not in memory, so a retry after a restart still opens the linker. No answer → `LINK_ASK_LIFE` 60 s card life +
  a 61 s deadline timer (`main.swift:18`) → unlinked upload, silent card. The table `linkAsks` (`:111`) is keyed
  by recording and the FIRST answer takes the entry, so Link / Not this / the deadline can never start two
  uploads; and an answer whose recording is no longer `local`/`upload_failed` (menu "Upload … now", the PWA, a
  launch drain got there first) starts nothing (`:752`).
- **A match that lands late** (`startUploadAfterMatch` `:776`): the server re-matches on every write, so the stop
  PATCH's answer often carries the match a few hundred ms after the recording is saved — and the link can only be
  declared on part 1. A saved recording with no match yet therefore waits `LINK_MATCH_GRACE` = 2 s (`:22`) and
  then asks or uploads unlinked. Nothing else about the upload path changed: auto-retry (30 min), the hide-able
  card, the saved card's live progress and the launch drain are untouched (the drain and the retry timer never
  ask — the question belongs to a recording that has just ended).
- **The wire** (`Uploader.swift:302`, contract §3): part 1 only, after the user tapped Link, the open body carries
  `linkedEvent: { key: <matched.event_key> }` **and `eventRef: <the same key>`**. The second field is an addition
  I made deliberately, not a change to §3: as of A's commit 6287854 nothing server-side resolves
  `linkedEvent.key` — `sanitizeLinkedEvent` (`src/lib/server/upload-pipeline.ts:63`) spreads it into a
  truthy-but-empty `LinkedEventInput`, which would (a) link nothing and (b) still clear `suggestedEvent`
  (`src/app/api/uploads/route.ts:232`), i.e. the person taps Link and loses both the link and the suggestion.
  `eventRef` is the headless form the CLI already uses, it wins when both are present ("The ref wins", route
  `:143-149`) and it resolves to the same occurrence, so the two can never disagree. **A (or whoever picks this
  up): please resolve `linkedEvent.key` through `resolveLinkedEventRef` too** — then either field works and the
  `eventRef` belt can come off.
- **A link must never strand a recording** (`Uploader.swift:351`): if the open is refused 4xx with a message
  mentioning the event, the tray drops the link, logs `upload_link_rejected` and re-opens WITHOUT it, so the
  bytes go up unlinked (the web suggestion strip can still link them) instead of failing every 30 minutes forever.

**Tested** (dev build via `./make-app.sh`, then `open -n … --env DARTH_TRAY_API_URL=http://127.0.0.1:8899`
against a fake API, so not one byte of this reached prod; ws driven with a bun one-liner):

| what | how | result |
| --- | --- | --- |
| copy + layout | `{cmd:"simulate_link_card", recording_id:<the incident row 753b7e06>}` | `Link to "Triton next steps!" (15:30)? / This recording: Slack · 15:48 · "Swaralee (DM) - Trames Pte Ltd - 1 new item…"` |
| Link | real ask (`real:true, auto:"link"`) on a synthetic row | open body = `linkedEvent {key}` + `eventRef` + `recorderRecordingId` |
| Not this | `real:true, auto:"not_this"` | open body has NO `linkedEvent`/`eventRef`; row carries `link_prompt: "not_this"` |
| no answer | `real:true`, nobody clicks | `link: no_answer` at +61 s, unlinked upload |
| already sent | real ask on an `uploaded` row | "is already uploaded — the answer starts nothing", no request |
| unresolvable key | fake API answering 404 "No such event in your calendar cache." | link dropped, second open without it, clear failure message |
| `?link=1` | `openTranscript` URL built in isolation | `https://meetings.darth-internal.trames.io/transcript/<id>?link=1` |

The two buttons were pressed by `banner.simulateClick` (the card's own `performClick`) through the new test hook
`{cmd:"simulate_link_card", recording_id?, event_title?, event_start?, life?, real?, auto?}` — without `real` it
only DRAWS the card and answers `{type:"link_card_answer", answer}` (no upload, no registry write); with `real`
it runs the genuine `askLink` for that row. Nothing was recorded, no screen was captured, no screenshot taken.

### D6 — does the share watcher see a Slack huddle share? No, and there was nothing to see

Unified log only (`/usr/bin/log show`, `process == "replayd" OR process == "tccd"`, 15:45–16:00 SGT 2026-09-22,
and a 2-day sweep 09-20 → 09-22 16:10).

- In that whole 15 minutes `replayd` created **exactly one** ScreenCaptureKit stream, and it was ours:
  `AUTHREQ_ATTRIBUTION … accessing={… io.trames.darth.recorder, pid=52420}, requesting={… com.apple.replayd}` at
  15:48:52, `SLContentFilter initWithDisplay … displayID = 0x2, shareAll = YES`, `isFullDisplayShare=1
  outputType=2` (audio only — the recording itself), `Created New Stream … Hash=7613093917214077131`, torn down
  15:56:54. No other `initWithClientBundleID`, no other `Created New Stream`.
- `com.tinyspeck.slackmacgap` **is** in the log — 114 `accessing=…slackmacgap.helper` TCC lines — but never with
  `requesting={TCCDProcess: identifier=com.apple.replayd}`, which is the only shape that says "this app is
  sharing". Slack's only screen-capture contact is two `AUTHREQ_CTX … service=kTCCServiceScreenCapture,
  preflight=yes, query=1` at 15:48:42 and 15:48:44 (msgID 16707.349/351 = Slack): it is ASKING whether it may
  share, as it does whenever a huddle starts, not sharing. Over 2026-09-20 → 09-22 not one Slack line in
  `tccd`/`replayd` mentions replayd at all, and the only SCK client on this Mac in those two days was Darth
  Recorder (1 stream).
- **So: nothing changed in the watcher.** There is nothing to add anyway — `ShareDetector` has no per-app list;
  it reports whatever bundle `tccd` attributes to a replayd request and suppresses only our own
  (`ShareDetector.swift:246`). Adding a bundle id is not a thing it can do.
- Two facts for the D6-web copy: (1) a Slack call is recorded **audio only by design** —
  `RecordingController.profile(for:)` maps `.slack → (.audioOnly, "Slack huddle")`
  (`RecordingController.swift:64`) — so such a recording has no video whatever anybody shares, which is the
  honest half of the sentence; (2) whether a REAL huddle share would show up is still **unproven**, because
  nobody on this Mac shared a screen in those two days. To settle it: start a huddle, share a window, and grep
  the watcher's own predicate for `Created New Stream` plus the attribution line that precedes it. Until then the
  copy should not promise either way beyond "screen shares in Slack are not captured" (which is true regardless,
  since the profile is audio-only).

### Left / owed

- The web's `?link=1` picker is A's (D4-web); the tray only opens the URL.
- `linkedEvent.key` resolution on the server (above) — until then the `eventRef` field is what actually links.
- Not released. When Alok wants it: `./make-app.sh --release` then `dist-scripts/deploy-to-dot6.sh`.
- The tray asks only when a recording ENDS. A recording that goes up from the launch drain or the 30-minute
  retry (e.g. made while signed out) never asks — it is born unlinked and the web suggestion strip is its path.
- Registry rows now may carry the tray-private key `link_prompt` (`"not_this"`, cleared when the linker opens).
  It is stripped from `Registry.serverBody`, like every other private key.

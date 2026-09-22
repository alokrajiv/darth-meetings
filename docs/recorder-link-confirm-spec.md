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

(builder B appends)

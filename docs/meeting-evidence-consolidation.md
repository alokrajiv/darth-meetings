# Meeting evidence: why the listing, the import dialog and the series page disagree — and how to centralize

Analysis date: 2026-08-22 (HEAD 4a50246). Prod numbers queried the same day.

> **STATUS 2026-08-22 (late) — ALL PHASES SHIPPED.** Phase 0+1: c9ba3ae,
> 7fe05dd, b595cb5 (migration 026 + Teams backfill repair). Phase 2+3 +
> D6/D8/D10/D12 + the Recording ×N chip: the commit after a736c24 (see
> "As built" at the end of this doc). D1–D12 all closed. Deployed + prod
> E2E'd (discover / records / evidence routes, series, listing, DB
> write-back). The pre-Phase-2 browser dialog is kept for ONE deploy as
> `gmeet-import-dialog-legacy.tsx` behind `NEXT_PUBLIC_MEET_DIALOG_LEGACY=1`
> / `localStorage mw:legacyMeetDialog=1` / `?meetLegacy=1` — delete it (and
> `useLegacyMeetDialog` in page.tsx) next deploy.

## Trigger

Screenshot pair, 21 Aug: import dialog shows "APP Thru vs Non Thru…" (no Meet link) and
"Data scrum 14:00 · recording · transcript"; the main listing shows no APP-Thru row and shows
Data scrum as **No recording**. Alok: "this kinda happens often … is there a cal last synced
somewhere … if the dialog did a sync is it not centralized … is the entire codebase
disorganized and not solid central?"

## Ground truth for that screenshot (prod DB)

| fact | evidence |
|---|---|
| APP Thru created after the previous poller sweep | `calendar_event_cache.first_seen_at = 06:12:48Z`, event start 05:00Z; it is now in the listing |
| Data scrum 14:00 artifacts captured at 06:50Z (event ended 06:30Z; poller waits 15 min past end, 30 m tick) | `gmeet_meeting_cache nek-dpfy-fbb\|2026-08-21T11:30:00+05:30 captured_at 06:50Z` |
| "my lunch" is hidden because Alok muted the series on 19 Aug | `calendar_event_mutes kind=series value=878ddts1…` = the "Hidden (1)" chip |
| The listing shows NO "as of" timestamp; the header badge "Meet not synced" reads `gmeet_sync_state.last_synced_at`, which only the dialog's manual Sync tab ever writes (4 users total). The real background sync stamp is `google_accounts.last_poll_at` (every 30 m, all 9 accounts) and is shown only on the Settings Google card. | `src/app/page.tsx:125-137,290`, `src/app/api/gmeet/sync-state/route.ts`, `google-account-card.tsx:121` |

So the specific symptom is **cache lag (up to ~45 min) with no freshness indicator**, plus a
header badge that measures the wrong thing. Not a bug in any one query.

## The structural finding

Meeting *discovery/evidence* ("what happened on my calendar, what did Google/Microsoft keep,
is it importable") is implemented as **four parallel stacks** that share only the lowest
transport helpers (`listRecordArtifacts`, `parseTranscriptDocs`, `pickOccurrenceArtifacts`).
There is **no shared "what does this meeting have" model** — no `MeetingEvidence` type, no
`classifyEvidence()` function, no single cache writer set.

| stack | fetches | window | classifier | stores |
|---|---|---|---|---|
| **Poller** `lib/server/gmeet-poller.ts` (30 m, serial across 9 accounts, owner token) | Calendar + Meet API (+Graph) | −7 d → +24 h | own (`transcriptDocIds.length`, `recordings.length`) — **never looks at calendar attachments (Gemini-notes Docs)** | `calendar_event_cache`, `gmeet_meeting_cache`, `gmeet_reminders` — **the only writer of both caches** |
| **Listing** `/api/calendar-meetings` + `db-ops/calendar-event-cache.ts` | nothing live | whatever the poller left | own SQL predicates (WHERE ≠ SELECT, see D3) | reads only |
| **Import dialog** `components/gmeet-import-dialog.tsx` (browser, caller token) | Calendar + Meet API + Drive **from the browser** | one day / 30 d / "since last manual sync" | own (`classifyAttachments`, `recordArtifacts`, 5 different importable predicates in one file) | **writes nothing back** — only reads cache via `/api/gmeet/check` |
| **Series sweep** `lib/server/series-occurrences.ts` (caller token) | Calendar + Meet API + Graph | −12 mo → +45 d | own (`classifyAttachments` v2, `transcriptsListed>0`) | **in-process `globalThis` cache 6 h, no DB** |
| (Import execution / deferred / recording pollers) | Meet + Drive per transcript | per row | own pending rules | `transcripts.gmeet_context` only |

Consequences: the same meeting gets a different answer depending on which screen asks, and
work done by one stack (a browser sweep, a series sweep, an import that found a Gemini Doc)
is thrown away instead of feeding the others.

## Catalogue of concrete disagreements (verified against code; line refs as of HEAD)

- **D1 Gemini-notes-only meeting** — dialog (`classifyAttachments` :259) and series sweep
  (`series-occurrences.ts:189`, fixed in e3ebbc7) say *transcript / importable*; the poller never
  reads attachments → no cache row → listing shows **No recording**.
- **D2 Transcript still generating** — series/dialog/import-core/deferred-poller use
  `transcriptsListed>0` (=pending, importable); poller uses `transcriptDocIds.length>0`
  (`gmeet-poller.ts:556`) → skips the row → listing **No recording** until the Doc exists.
- **D3 WHERE ≠ SELECT in the unimported view** — `unimportedWhere` counts
  `transcript_parseable IS TRUE` (Teams transcript-only rows) but `has_transcript` in the SELECT
  is doc-ids-only (`calendar-event-cache.ts:261` vs `:381`) → row listed under "Not imported"
  but glyph says **No recording**.
- **D4 Never-generated recordings count as recordings** — poller writes
  `recording_count = artifacts.recordings.length` including file-less entries
  (`gmeet-poller.ts:308`); **20 of 138 prod cache rows** have `recording_count>0` and
  `video_file_id IS NULL` → Recording badge with dead Drive link; dialog `hasVideo=true`
  suppresses its own "preparing…" state; recording-poller would call the same record `gone`.
- **D5 Opposite failure policies 40 lines apart** — dialog `listMeetRecords` throws on non-OK
  ("stay permissive"), `recordArtifacts` swallows to `{}` → **"nothing to import"** on a 403/quota.
  Server `tryJson` (`gmeet.ts:364`) also swallows → deferred poller can declare terminal
  "transcript never appeared" on a transient error.
- **D6 "never started" vs importable** — dialog joins records by exact code within the selected
  day only; series sweep lists all records for the code (no time bound) → same meeting is
  "never started" in the dialog and "importable" on /series.
- **D7 Attachment regex drift** — dialog: gemini first, `/transcript/i` anywhere; series:
  `/transcript\s*$/i` anchored, transcript first. "Transcript of X" is a transcript in one, nothing
  in the other.
- **D8 `transcript_parseable=false`** honoured by dialog/listing badges, ignored by series sweep,
  series "Import all" and series auto-import → auto-import knowingly fires known-dead Docs → 422.
- **D9 unimported view has no eventId anti-join** (norec has one) → an upload linked by eventId
  leaves the meeting in "Not imported" forever.
- **D10 `canImport` on norec rows** (`calendar-meeting-rows.tsx:413`) invites a click that the
  dialog answers with "never started".
- **D11 partial multi-segment recording** — dialog `!some(file)` = not pending; import-core and
  recording-poller `some(!file)` = pending.
- **D12 6 h stale series skeleton** — `upcoming` is recomputed live but artifacts are cached, so a
  meeting that just ended flips to `bare` for up to 6 h while the dialog shows "preparing…".
- Three conferenceRecord lookups with three windows (±6/+12 h server, ±6/+12 h re-implemented in
  browser `enrich`, unbounded in series + paste); four calendar windows; `±12h` occurrence window
  re-declared in four modules; bulk import in the dialog (`:1375`) omits `defer/background`
  while single (`:1470`) and series (`series-dialog.tsx:670`) send them.
- Token identity is not uniform: owner's (recording/deferred/video pollers), caller's (series
  sweep, join, link-event, dialog), enabler's for someone else's occurrence (series auto-import),
  triggering user's (auto-notes), caller's into owner's row (`fetch-audio`).

## What is NOT disorganized (fairness)

The import/transcript core is reasonably centralized: `gmeet-import-core.ts` /
`teams-import-core.ts` are the single execution paths used by the dialog, the series dialog, the
deferred poller and auto-import; `ingest*`, `auto-notes`, sharing, soft-delete and the listing
v2 pagination each have one owner module. The rot is specifically in the **evidence/discovery
layer** that grew feature-by-feature (poller → dialog sweep → calendar views → series sweep),
each session adding a sibling instead of a shared core.

## Proposed consolidation (phased, each phase shippable)

### Phase 0 — make the lag visible (small, do first)
1. Listing toolbar: "Calendar synced 12 m ago" from `google_accounts.last_poll_at` (already in
   the `/api/calendar-meetings` response as `sync.lastPollAt`; today only `syncing` is used).
2. Retire the header "Meet not synced" badge's dependency on `gmeet_sync_state.last_synced_at`
   (it is a manual review checkpoint used by 4 users). Keep that column for the dialog's Sync tab
   window only, or drop the tab's "since last sync" semantics.
3. "Sync now" → `POST /api/calendar/sync` that runs `sweepUser(callerAccount)` (the
   `sweepNewAccount` code path already exists) and refetches the calendar layers on completion;
   show a spinner with "syncing…".

### Phase 1 — one evidence model + one classifier
Create `src/lib/meeting-evidence.ts` (isomorphic, pure):
```ts
type MeetingEvidence = {
  provider: 'gmeet'|'teams'; meetingCode: string|null; eventId: string|null;
  recording: { state: 'none'|'generating'|'ready'|'gone'; fileIds: string[]; count: number };
  transcript: { state: 'none'|'generating'|'ready'|'unparseable'; docIds: string[]; source: 'meet'|'gemini'|'calendar'|'teams'|null };
  conferenceRecord: string|null; confStart/End; checkedAt: string; checkError?: string;   // "could not check" ≠ "nothing"
};
classifyEvidence(e): { hasRecording, hasTranscript, pending, importable, label }
classifyAttachments(att[]): { videos, transcriptDoc, geminiDoc }   // ONE regex set
OCCURRENCE_WINDOW_MS, RECORD_LOOKUP_WINDOW                          // ONE declaration
```
Replace the ~15 inline predicates (dialog ×5, series ×4, poller ×3, SQL ×3) with it. In SQL,
store the classified columns at upsert time (`has_recording`, `has_transcript`,
`transcript_source`, `recording_state`, `transcript_state`) so WHERE and SELECT can't drift
and file-less recordings stop counting (fixes D1-D4, D7, D8, D11 at the source).

### Phase 2 — one discovery service, many callers, all write back
`src/lib/server/meeting-discovery.ts`:
- `syncCalendarWindow(userId, token, {from,to})` → normalized events (incl. attachments) →
  `upsertCalendarEvents`. Used by the poller (−7 d), the dialog day view (one day, via a new
  server route — the browser token is already server-minted, so moving the call server-side
  changes nothing about the own-token rule), and the series sweep (−12 mo).
- `probeMeetingEvidence(token, {code,startIso,attachments})` → `MeetingEvidence` and
  **always upserts `gmeet_meeting_cache`** (gap-fill semantics already exist). Used by poller,
  dialog enrich/sweepDay (server route), series sweep, import-core, deferred + recording pollers.
- Series sweep: persist occurrences (or at least the calendar part) instead of the 6 h
  `globalThis` cache; recompute `upcoming/past` and artifacts together (fixes D12).
- Dialog becomes a thin client: `/api/calendar/day?date=` + `/api/meet/evidence` + the
  existing import routes; delete `recordArtifacts`, `listMeetRecords`, `fetchMeetingCode`,
  `classifyAttachments`, the client-side ±6/+12 h `enrich` — ~600 lines of browser Google code.

### Phase 3 — single source of "already imported"
One `findImportedOccurrences()` (SQL, ±12 h, by meetingCode OR eventId OR joinWebUrl OR
videoFileId OR transcriptDocId) used by the SQL views, `/api/gmeet/check`, series
`matchImported` and the poller's reminder reconciliation (fixes D9 and the 4-way window dup).

### Order of work
Phase 0 (½ day) → Phase 1 (1–2 days, mostly mechanical, test the classifier in isolation) →
Phase 2 (2–3 days; dialog shrinkage is the risky part — keep the old client path behind a flag
for one deploy) → Phase 3 (½ day).

## Addendum (2026-08-22): same disease, different organ — auth/401 self-heal

Sibling session (`2026-08-22-122555-image-1-can-we-figure-out-how-to-renew-the-tok.txt`, repo
root) diagnosed the "Retry loop after 24h": the `trames-auth-session` JWT lives 24h but the
cookie 30d; `src/proxy.ts` only checks cookie *presence*, so pages load and every `/api/*` call
401s; nothing in this app ever calls kenoby-sso's `/api/auth/refresh`. Kyloren solves it with a
single-flight axios interceptor against `login.trames.io/api/auth/refresh`; the cross-origin
refresh from `meetings.darth-internal.trames.io` was **proven live with real cookies** (CORS
echo + Set-Cookie on `.trames.io` land fine — same eTLD+1, SameSite=Lax).

Why it belongs in this doc: the enabling condition is the same centralization gap — **118 raw
`fetch(` calls across 28 client files, no shared API client** — so there was no seam to hang a
401 handler on, exactly as there is no seam for a shared evidence classifier.

Agreed design (on hold, ~1h incl. Playwright proof with an expired JWT):
1. **Client:** wrap `window.fetch` once (mounted in `layout.tsx`) for same-origin `/api/` calls:
   on 401 → single-flight `POST https://login.trames.io/api/auth/refresh`
   (`credentials:'include'`, `Accept: application/json`) → replay once; refresh 401 →
   `location.href='/login?returnTo=…'`. Skip `/api/auth/*` and non-replayable body streams
   (the multi-GB upload route).
2. **Server:** `proxy.ts` decodes the JWT payload (no verify; Edge-safe) and redirects
   *navigations* with `exp < now` to `…/api/auth/refresh?returnTo=<url>` — no 401 flash.

Sequencing note: ship this **before / independent of** Phase 2 — the fetch-wrapper is also the
natural seed of a central `apiFetch()` that Phase 2's new dialog routes should use.


## As built — Phase 2 + 3 (2026-08-22)

### Phase 2: `src/lib/server/meeting-discovery.ts` — THE discovery service
| function | does | writes back |
|---|---|---|
| `listCalendarEvents` / `syncCalendarWindow(userId, token, {from,to})` | Calendar API (one `CAL_FIELDS` mask for everyone; `CalendarListError` on a refused first page) | `calendar_event_cache` via `persistCalendarEvents` |
| `probeRecordEvidence(token, recordName, attachments?)` | one record's inventory, classified by `lib/meeting-evidence` | — |
| `persistMeetingEvidence(token, …)` | the poller's old `captureMeetingMeta`, now the single writer: gap-fill (conf times, Drive size/duration, Doc parse) fetched at most once ever; **reuses the existing row within ±12h** (poller's raw-calendar-string key vs a probe's record-ISO start → no second "Not imported" row) | `gmeet_meeting_cache` |
| `probeMeetingEvidence(token, {meetingCode, eventStart, recordName?, attachments?, existing?})` | record lookup (the ONE `RECORD_LOOKUP_BEFORE/AFTER_MS` window, D6) → inventory → folds calendar attachments **and the cached row's known evidence** → verdict; a failed lookup is `checkFailed`, never "never started" (D5) | always, via `persistMeetingEvidence` |
| `discoverWindow(userId, token, {from,to,meetOnly?})` | the dialog's day/sync view: calendar rows + Meet records in the window (space→code, probe each, join by code + lookup window, nearest start), off-calendar extras; attachment-only past Meet events count too | calendar rows synchronously; artifact rows **detached** (after the response) |
| `listMeetRecordRows(token, {fromIso}|{code})` | "Recent 30d" / pasted code — records with their meeting codes, `meet.checked=false` (resolved on pick) | — |

Routes (caller's own **server-minted** token; 404 `{connected:false}` when Google isn't
connected; darth-cli bearers allowed — the token never leaves the server):
`GET /api/calendar/discover?from&to[&meetOnly=1]`, `GET /api/meet/records?days=30|code=`,
`POST /api/meet/evidence {meetingCode,startTime?,recordName?,attachments?,event?}` (also
reads the caller's cached calendar attachments when none are sent, and returns Drive meta +
the cache row's counts). Wire types: `src/lib/meeting-discovery-types.ts`.

Callers moved onto it: the poller (`sweepUser` → `syncCalendarWindow` + `probeMeetingEvidence`;
a refused calendar listing now marks the account `error` and does NOT stamp `last_poll_at`),
the dialog (`gmeet-import-dialog.tsx` is ~2,150 lines of pure UI; `recordArtifacts`,
`listMeetRecords`, `fetchMeetingCode`, `fetchDriveMeta`, `sweepDay`, the browser `enrich`
are gone), the series sweep (Meet-side inventories go through `probeRecordEvidence` and are
persisted; at serve time the skeleton is re-read against the shared cache — D8: a
`transcript_parseable=false` Doc is `emptyTranscript`, so "Import all"/auto-import skip it —
and recently-ended occurrences (<48h, still incomplete) are re-probed live, ≤8 per serve, ≥5 min
apart — D12), and the listing (`Check…` on a No-recording Meet row = one probe; importable →
opens the dialog on it, else says "Nothing at Google" inline — D10; "Recording ×N" = ready
files, not listed entries).

### Phase 3: one "already imported?" rule
`src/lib/imported-occurrence.ts` (`importedOccurrenceMatches`, pure, tested) +
`src/db-ops/imported-occurrences.ts` (`findImportedOccurrences` — one SQL with only the key
arms present so the per-key indexes stay usable; `importedOccurrenceAntiJoin` — the SQL twin
used by both listing views). `findImportedByMeetingCodes`, `findImportedByTeamsMeetings`,
`findImportedByTeamsCallId` are thin adapters; `series-occurrences.matchImported` uses the pure
matcher. Verified row-equivalent against prod data (all callers, both views) before deploy.

### Known quirks (documented, not bugs)
- An event carrying BOTH a Meet link and a Teams link: the dialog rows treat it as Teams
  (explicit link wins — legacy behaviour); the calendar cache keys it as Meet (poller, unchanged).
- `calendar_event_cache` / `gmeet_meeting_cache` still hold tz-duplicate keys for the same
  instant from different users' calendars (`+08:00` vs `+05:30`); the listing dedupes by
  instant and new probes reuse the first row within ±12h.

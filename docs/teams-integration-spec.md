# Microsoft Teams integration — implementation spec

**Status:** infra 100% done + E2E-verified 2026-08-10; code not started (only `config.microsoft` block added, uncommitted).
**Goal:** full Google-Meet parity for Teams meetings — auto-discovery from calendars, auto-fetch of speaker-attributed transcripts and MP4 recordings, same import dialog / reminders / sharing / AI pipeline, Teams icon on rows. Zero per-user Microsoft logins.
**Provenance:** produced by the 2026-08-10 setup session — full transcript (portal steps, PowerShell runs, API probes, codebase-exploration maps) at [`old-session/2. teams-graph-tenant-setup-and-e2e-verification.txt`](../old-session/2.%20teams-graph-tenant-setup-and-e2e-verification.txt); admin/ops runbook in project memory `project_ms_teams_entra_setup.md`.

---

## 1. Context and decisions (user-confirmed)

- Trames runs **Google Workspace for mail/calendar**; the M365 tenant exists for Teams (14× Business Standard seats). Consequence: **Exchange calendars are empty** — Teams meetings are scheduled from Google Calendar via the Teams add-on (`launchAgent=GSuiteAddOn` in join URLs). Both org-side and invitee-side discovery must come from **Google Calendar**, which the app already polls per-user.
- **Full service-account model** (Alok's explicit decision): app-only Graph credentials for calendars *and* artifacts. No per-user Microsoft OAuth connect, ever. (Delegated scopes remain granted on the app but unused.)
- The manual path being replaced: colleagues export VTT from Teams recap and drag into import-text (example: transcript row 219, `ext-eaced482-…`, "LP-Global<>Trames Weekly Catch Up", VTT-only, no media).
- External-tenant organizers stay manual — see §4.5.

## 2. Verified infrastructure (do not redo)

| Item | Value |
|---|---|
| Entra app | **Darth Meetings**, client `0f32542d-086d-4d75-89c3-a89e04e12173`, single-tenant |
| Tenant | Trames Pte Ltd `9dd6657a-80c2-4122-9091-258f264d23a0` (`trames.sg`) |
| App-only permissions (admin-consented) | `Calendars.Read`, `OnlineMeetings.Read.All`, `OnlineMeetingRecording.Read.All`, `OnlineMeetingTranscript.Read.All` (+ delegated `Calendars.Read`/`offline_access`/`User.Read`, unused) |
| Access policy | `MeetingWhisperer-Access` granted **`-Global`** (all users incl. future) |
| Tenant transcript gate | `EnableGraphTranscriptAccess=$true`, `EnableAttributedTranscripts=$true` (was default-off since MS enforcement 2026-07-29; flipped 2026-08-10) |
| Secret | `meeting-whisperer-server`, expires **2028-08-09**, in local + VM `.env.local` as `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` |
| Redirect URIs (unused for app-only, registered anyway) | `https://meetings.darth-internal.trames.io/api/ms/callback`, `http://localhost:3002/api/ms/callback` |

**E2E proof run (2026-08-10):** client-credentials token → join-URL resolution under Swaralee (`8c05d801-9c1c-484c-9501-d5450d6eafa5`) → **11 transcripts + 11 recordings** listed for the LP-Global recurring series (retroactive, incl. pre-toggle) → VTT content downloaded (speaker-attributed `<v Name>` tags, 29 KB) → MP4 content honors `Range` (206, ISO Media header). Teams meeting APIs are **no longer metered** (free since 2025-08-25).

## 3. Architecture: two lanes

```
Google Calendar (existing per-user poller, consented)      ← DISCOVERY
        │  event contains teams.microsoft.com/l/meetup-join/… link
        ▼
join URL → { Tid (tenant), Oid (organizer AAD id) }        ← parse, no directory call
        ▼
Graph app-only (client credentials)                        ← ARTIFACTS
  /users/{Oid}/onlineMeetings?$filter=JoinWebUrl eq '…'
  /…/transcripts → /content?$format=text/vtt
  /…/recordings → /content   (ranged/streamable)
```

Delegated tokens can't fetch artifacts of meetings the user didn't organize (organizer-only rule), and `getAllTranscripts` bulk sweep is **useless here** — documented caveat: it skips meetings created via the create-onlineMeeting API that aren't backed by an Exchange calendar event, which is *every* GSuite-add-on meeting. The join-URL lookup is the only reliable path and is fully proven.

## 4. Graph API mechanics (all verified)

### 4.1 Join URL parsing / canonicalization
Raw link from Google Calendar:
```
https://teams.microsoft.com/l/meetup-join/19%3ameeting_MWJi…%40thread.v2/0
  ?context=%7b%22Tid%22%3a%22<tenant-guid>%22%2c%22Oid%22%3a%22<organizer-guid>%22%7d
  &launchAgent=GSuiteAddOn&correlationId=…        ← extra params NOT in Graph's stored JoinWebUrl
```
Canonical form (what Graph stores and what `$filter=JoinWebUrl eq` must match): everything **up to and including the encoded `}` (`%7d`/`%7D`) that closes the `context` param**. Strip anything after. Decode the context JSON to get `Tid` and `Oid` — the organizer's AAD object id is embedded in every join link, so **no directory lookup is ever needed** (we deliberately did not grant `User.Read.All`).

### 4.2 Meeting resolution
`GET /v1.0/users/{Oid}/onlineMeetings?$filter=JoinWebUrl eq '<canonical>'` (URL-encode the whole filter). Returns the meeting: `id`, `subject`, `meetingCode`, `meetingType: "scheduled"`, `startDateTime`/`endDateTime` (of the *first/series* occurrence — see 4.3), `recordAutomatically`, `allowTranscription`.

### 4.3 Recurring series = ONE onlineMeeting object
A weekly series created in May has a single meeting `id`; `/transcripts` and `/recordings` return **all occurrences** (LP-Global: 11 each). Each artifact carries `callId`, `contentCorrelationId`, `createdDateTime`, `endDateTime`. **To pick the artifact for a specific occurrence, match `createdDateTime`/`endDateTime` against the Google Calendar event instance's start/end window** (transcript createdDateTime ≈ when transcription started, a few minutes after meeting start; use generous overlap, e.g. artifact window intersects [eventStart − 15 min, eventEnd + 6 h]). A transcript and recording from the same occurrence share the same `callId` — use it to pair them.

### 4.4 Content fetch
- Transcript: `GET …/transcripts/{id}/content?$format=text/vtt` → WebVTT with `<v Speaker Name>text</v>` cues. Attribution works retroactively for pre-toggle transcripts.
- Recording: `GET …/recordings/{id}/content` → MP4, supports `Range` (stream to disk; no size in listing — read `Content-Length`/stream).
- Auth header only; content URLs are Graph URLs (same bearer token works).

### 4.5 External tenants — hard boundary
If join-URL `Tid ≠ config.microsoft.tenantId` (e.g. today's `app.co.id` meetings), artifacts live in the other org's tenant and are unreachable — no admin power on our side changes that. UI treatment is specified in §10.1: the row is still shown, explicitly labeled as external ("not in the Trames tenant, we can't pull it"), and walks the user through downloading the artifacts themselves and uploading — **video preferred, transcript file (docx/vtt) as fallback**. `getAllTranscripts` additionally can't see channel meetings — irrelevant for us since we never use it.

### 4.6 Failure taxonomy (map like `GoogleApiError` → `googleErrorResponse`, gmeet/import route:115)
- 401/`InvalidAuthenticationToken` → refresh app token (cached, see §6.1) and retry once.
- 403 `GraphAccessToTranscriptsDisabled` → tenant toggle regressed; surface actionable error naming `Set-CsTeamsMeetingConfiguration`.
- 403 (other) → access-policy gap (shouldn't happen with `-Global`) — surface as config error, not user error.
- Empty resolution for a Trames-tenant URL → meeting deleted or URL malformed; treat as "no artifacts".
- Transcript list empty but recap shows one → check occurrence-window matching before assuming absence.

## 5. Current codebase seams (from 2026-08-10 exploration; verify line drift before editing)

**Reusable as-is (provider-agnostic):**
- `src/lib/server/import-helpers.ts` — `autoNameSpeakers`, `registerPeopleFromMeeting`, `buildEmailByName` (doc already says "Teams exports").
- `src/lib/server/gmeet.ts:649` `utterancesFromEntries` (same-speaker merge, ≤2000 ms gap, <600 chars) and `:673` `synthesizeTranscriptResponse` — both pure; VTT parser feeds them.
- `src/db-ops/transcripts.ts:290` `createImportedForUser` (+ `ImportedTranscriptInsert`), `src/lib/server/post-completion.ts` `onTranscriptCompleted`, `src/lib/server/auto-share.ts` `autoShareToInternalInvitees`.
- `src/lib/server/audio-storage.ts` (filename = `<assemblyai_id><ext>`, `.bin` fallback), `src/lib/server/video-frames.ts:57` `sniffMediaExtension` + `hasVideoStream` (reuse verbatim after MP4 download), `src/lib/server/ingest.ts` `ingestLocalAudio`.
- `src/lib/format.ts:93` `MeetTranscriptEntry`, `:71` `MeetUtterance`, `gmeet.ts:163` `ParsedMeetTranscript`.

**Needs a Teams twin / extension:**
- `src/lib/server/gmeet-poller.ts` — `listMeetEvents` (line ~79) filters `conferenceSolution.key.type === 'hangoutsMeet'`; extend the same event walk to also catch Teams links (§8).
- `src/app/api/gmeet/import/route.ts` transcript branch `:364-464` and video branch `:466-586` — the ingestion sequence to share (§7).
- `src/app/api/transcripts/import-text/route.ts:159-219` — duplicate of that sequence; both refactor onto `ingestParsedUtterances`.
- Dedupe: `checkCrossUserDuplicate` (gmeet/import:78) keys on `meetingCode`; Teams dedupe keys on Graph meeting id + `callId` (§7.3).
- `gmeet_context` jsonb (type `GmeetContext`, format.ts:129) — **overload, don't add a parallel column**: too many read sites key off it (`videoFileId`, transcript page fetch-audio at `src/app/transcript/[id]/page.tsx:639-683`).

## 6. New server modules

### 6.1 `src/lib/server/ms-graph.ts` (`import 'server-only'`)
```ts
class GraphApiError extends Error { status: number; code?: string }

// module-level app-token cache: { token, expiresAt }; mint via
// POST login.microsoftonline.com/{tenant}/oauth2/v2.0/token
// scope=https://graph.microsoft.com/.default, grant_type=client_credentials;
// refresh when <2 min left (mirror google-oauth.ts tokenCache pattern)
getAppToken(): Promise<string>
isConfigured(): boolean            // non-throwing probe (mirror isClientConfigured)

interface TeamsJoinInfo { joinWebUrl: string; tenantId: string; organizerOid: string }
parseTeamsJoinLink(raw: string): TeamsJoinInfo | null   // §4.1; null if not a meetup-join URL
isOwnTenant(info: TeamsJoinInfo): boolean

resolveMeetingByJoinUrl(oid, joinWebUrl): Promise<GraphOnlineMeeting | null>
listTranscripts(oid, meetingId): Promise<GraphTranscript[]>   // id, callId, createdDateTime, endDateTime
listRecordings(oid, meetingId): Promise<GraphRecording[]>
fetchTranscriptVtt(oid, meetingId, transcriptId): Promise<string>
getRecordingStream(oid, meetingId, recordingId): Promise<Response>  // caller pipes body to temp file
pickOccurrenceArtifacts(transcripts, recordings, eventStartIso, eventEndIso):
  { transcript?: GraphTranscript; recording?: GraphRecording }      // §4.3 window match + callId pairing
```

### 6.2 `src/lib/server/teams-vtt.ts`
```ts
parseTeamsVtt(vtt: string): ParsedMeetTranscript
```
- Parse WEBVTT cues: `HH:MM:SS.mmm --> HH:MM:SS.mmm` + payload lines; multi-line payloads joined with space.
- Speaker from `<v Name>`; strip closing `</v>` and any other tags. Cues without a voice tag (unattributed transcripts, tenant toggle off historically): speaker `"Speaker"`.
- Map cues → `MeetTranscriptEntry[]` (ms) → **reuse `utterancesFromEntries`** for same-speaker merging.
- `attendees` = unique speaker names in order of first appearance. (Real attendee *emails* come from the Google Calendar event, handled by the import route via the existing `LinkedEvent`/`gmeet_context.attendees` shape.)
- Deterministic — **replaces the Claude-normalize pass** for this path (keep import-text's Claude pass for arbitrary pasted formats).
- Unit-test against the real sample: scratchpad `lp-global-today.vtt` (545 lines) — commit a trimmed fixture to `src/lib/server/__tests__/fixtures/teams-sample.vtt` (~20 cues, anonymized if desired).

### 6.3 Shared ingestion: `src/lib/server/ingest-parsed.ts`
Extract the duplicated sequence from gmeet/import `:410-463` and import-text `:159-219` into one function; both routes plus the new Teams route call it:
```ts
ingestParsedUtterances({
  userId, sourceId,            // 'teams-<meetingIdHash>-<callId>' for Teams (see §7.3)
  title, parsed: ParsedMeetTranscript,
  recordedAtIso?, languageCode?,
  gmeetContext?,               // stored as-is
  attendees?: GmeetAttendee[], // drives autoNameSpeakers + auto-share
}): Promise<{ id: number }>
```
Sequence inside: normalize timings → `synthesizeTranscriptResponse` → `createImportedForUser` → `setRecordedAtForUser` → `autoNameSpeakers` → `onTranscriptCompleted` → `autoShareToInternalInvitees` + `registerPeopleFromMeeting` (when attendees present).

## 7. Data model

### 7.1 `gmeet_context` overload (no new columns)
```jsonc
{
  "provider": "teams",              // absent/"gmeet" = Google Meet (backward compat)
  "eventId": "…", "recurringEventId": "…", "iCalUID": "…",   // Google event, as today
  "startTime": "…", "endTime": "…", "attendees": [...],       // as today
  "organizerEmail": "swaralee@trames.sg",
  "teams": {
    "joinWebUrl": "<canonical>",
    "tenantId": "…", "organizerOid": "…",
    "graphMeetingId": "MSo4YzA1…",
    "callId": "3b465b7d-…",          // occurrence key
    "transcriptId": "…", "recordingId": "…"
  }
}
```
`recorded_at` from the transcript's `createdDateTime` (fallback event start), same as Meet actuals.

### 7.2 Source id
`assemblyai_id = 'teams-' + <first 12 hex of sha256(graphMeetingId)> + '-' + <callId first 8>` — unique per occurrence, stable for dedupe/join, fits the `gmeet-…`/`ext-…` convention. Media file: `<assemblyai_id>.mp4` (post-`sniffMediaExtension`).

### 7.3 Dedupe / join-existing
Teams twin of `checkCrossUserDuplicate`: look up visible transcripts where `gmeet_context->'teams'->>'callId'` matches (or same `graphMeetingId` + overlapping occurrence window when callId unknown pre-fetch). **Migration 019**: expression index on `((gmeet_context->'teams'->>'callId'))` mirroring `transcripts_gmeet_meeting_code_idx` (011). Join flow: unlike Meet, there's no per-user artifact access to re-verify (app fetched it); join gate = requester was an attendee of the Google event (attendee email match) OR standard share flow. Keep it simple: reuse `/api/gmeet/join`'s `addShare` shape with the attendee check.

### 7.4 Meeting cache (poller metadata)
Reuse `gmeet_meeting_cache` (017) — key stays `event_key = '<code>|<startIso>'`; for Teams use `meetingCode` from Graph (numeric, e.g. `48820278136147`) or the canonical join URL hash as the code component. Add nothing schema-wise; store Teams facts in `raw` jsonb + set `transcript_parseable=true` when a transcript listing exists for the occurrence. (Poller uses app-only Graph — display-only metadata rule from 017 stays: import re-resolves fresh.)

## 8. Poller extension (`gmeet-poller.ts`)

In `sweepUser`'s event walk (already per-user, already has the user's Google token):
1. Alongside the `hangoutsMeet` filter, detect Teams events: scan `location`, `description`, `conferenceData.entryPoints[].uri` for `teams.microsoft.com/l/meetup-join` (regex from the verified probe: `/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>\\]+/`).
2. `parseTeamsJoinLink` → skip if `!isOwnTenant` (still cache the row flagged external so the dialog can label it).
3. For own-tenant past events: app-only resolve → `pickOccurrenceArtifacts` → upsert cache (has_transcript/has_recording) → `gmeet_reminders` kind `unimported` (reuse identical reminder machinery; event_key per §7.4).
4. Rate care: one resolution per (meeting, occurrence) per sweep; the join-URL filter call is cheap; cache resolved `graphMeetingId` in the cache row's `raw` to skip re-resolution.

## 9. API routes

### 9.1 `POST /api/teams/import`
Body mirrors `ImportBody` of gmeet/import: `{ event | linkedEvent-ish payload, mode: 'video'|'transcript'|'both', reportPref, language }`.
Server flow:
1. `parseTeamsJoinLink` from the event payload; reject external tenant with a typed error the dialog renders as the manual-upload nudge.
2. Resolve meeting → `pickOccurrenceArtifacts` for the event's window.
3. Cross-user dedupe (§7.3) → offer join (same envelope as gmeet check/join).
4. `transcript` mode: `fetchTranscriptVtt` → `parseTeamsVtt` → `ingestParsedUtterances` (with `gmeet_context` §7.1).
5. `video`/`both`: `getRecordingStream` → stream to temp (reuse `saveAudioStreamToTemp`) → `sniffMediaExtension` → `both`: attach parsed VTT as imported content + media file (mirror gmeet/import video branch: placeholder row → `ingestLocalAudio` path with pre-parsed transcript; follow the gmeet route's exact status transitions); `video`-only without transcript: normal AAI pipeline on extracted audio.
6. `maxDuration = 900` (match fetch-audio route; MP4s are hundreds of MB).

### 9.2 `POST /api/teams/check`
Twin of `/api/gmeet/check`: batch { events[] } → per-event { artifacts known?, duplicate?, external? } from cache + dedupe lookup. Keep the dialog's sweep cheap; no Graph calls in the hot path (cache-first, resolve lazily on import).

### 9.3 Fetch-recording-later
Extend `/api/transcripts/[id]/fetch-audio` — if `gmeet_context.provider === 'teams'`, fetch via `getRecordingStream` using stored ids instead of Drive. Same in-flight dedupe map in `recording-fetch.ts`; only the two Drive calls swap.

## 10. UI

### 10.1 Provider identity + external-tenant UX (user-specified, load-bearing)
- **Every meeting row in the import dialog shows its provider**: Meet rows keep the Meet icon, Teams rows get the Teams icon (indigo/purple tile). The two must be visually distinct at a glance in the same day list — never a generic "video call" glyph.
- **Internal Teams rows** (join-URL `Tid` = Trames tenant): full parity — artifact badges, 3 import modes, one-click auto-import.
- **External Teams rows** (`Tid` ≠ Trames): still listed, with the Teams icon visibly muted/greyed + an explicit inline label, e.g. *"Organized outside Trames (LP-Global's tenant) — we can't pull this automatically."* Show the organizer domain when known (from the Google event's organizer email). Clicking the row does NOT dead-end: it opens a guided manual-import panel that tells the user exactly what to do:
  1. **Preferred: download the recording video** from the Teams recap (or ask the organizer for it) and upload it here — full pipeline (speaker ID, frames, video report) works.
  2. **Fallback: download the transcript** (docx or vtt export from recap) and upload that — text-only import, no media features.
  The panel routes video files into the upload stepper (`audio-upload.tsx`, with the event pre-linked so `gmeet_context` comes out right) and transcript files into `transcript-import-dialog.tsx`. Copy should say *why* ("their tenant owns the files"), not just "unavailable".
- Same labeling in the reminders dropdown: external meetings get the muted icon + "manual import" hint instead of the one-click import affordance.

### 10.2 Everything else
- **`gmeet-import-dialog.tsx`**: calendar rows already come from the user's Google calendar — stop filtering Teams events out; `classifyAttachments` equivalent from `/api/teams/check` data. Import options step and 3 modes identical to Meet; "video report" option follows the same `uploadPrefs` protocol.
- **Connect gate**: unchanged — the gate is *Google* connect (discovery source). No Microsoft connect UI anywhere. Settings card: nothing new (no per-user MS state to show).
- **Transcript detail page**: provider icon next to title (reads `gmeet_context.provider`); auto-fetch-recording effect extends to Teams rows (`canFetchVideo` uses `teams.recordingId` presence instead of `videoFileId`).
- **Reminders**: rows render identically; reminder click-through opens the dialog on the meeting's day (existing behavior).
- **Upload stepper / link-event dialog**: `LinkedEvent` already mirrors the Meet payload; when the linked Google event carries a Teams URL, stamp `provider:'teams'` + `teams.joinWebUrl` into the context so fetch-later works.

## 11. Testing plan

1. **Unit** (`bun test`): `parseTeamsJoinLink` (canonicalization incl. `%7D` uppercase, no-context URLs, non-meetup URLs); `parseTeamsVtt` against the committed fixture (cue merge, no-voice-tag fallback, multi-line payloads); `pickOccurrenceArtifacts` (11-artifact series fixture from the verified probe, window edges, callId pairing).
2. **Integration (live, read-only)**: script hitting the real LP-Global series — resolution, listing, VTT fetch; assert ≥11 transcripts and speaker tags present. Run manually, not in CI (needs prod secret).
3. **E2E on prod after deploy**: import today's LP-Global occurrence via the dialog as Alok → expect: transcript matches row 219's content but with precise cue timings; MP4 attached and playable; auto-share to attendees fired; speaker-ID pass ran on frames; delete test row after.
4. **Regression**: Meet import unchanged (`provider` absent path); import-text VTT path still Claude-normalized; `next build` clean with **no** MS_* env set (lazy config).

## 12. Build order (each step deployable)

1. `ms-graph.ts` + `teams-vtt.ts` + unit tests + `config.microsoft` (already in working tree).
2. `ingest-parsed.ts` refactor — gmeet/import + import-text moved onto it (pure refactor, verify Meet import still green).
3. Migration 019 (callId expression index) + `/api/teams/check` + dedupe helper.
4. `/api/teams/import` (transcript mode first, then video/both).
5. Poller extension + reminders.
6. Dialog UI (icons, external labeling) + detail-page provider icon + fetch-audio extension.
7. Live E2E, then announce to the 14 Teams-licensed users.

## 13. Gotchas / non-obvious facts (hard-won today — read before coding)

- `getAllTranscripts`/`getAllRecordings` return **empty** for add-on-created meetings — never use them for discovery; don't "fix" by switching to them later.
- Join-URL `$filter` must use the **canonical** URL (§4.1) — the raw calendar link with `&launchAgent=…` matches nothing.
- One recurring series = one meeting object; artifact→occurrence matching is **time-window based** (§4.3). A naive "latest transcript" grab imports the wrong week.
- Transcript `createdDateTime` lags meeting start by minutes (transcription start), and recap artifacts appear ~3 min after meeting end (OneDrive save observed at +3 min) — poller sweeping a just-ended meeting must tolerate absence and retry next sweep (the Meet-side "preparing…" badge pattern already models this).
- Teams module PowerShell (admin ops): `Get-CsApplicationAccessPolicy -Identity X` throws on not-found despite `-ErrorAction SilentlyContinue`; device-code window is ~2 min (have the user run scripts via `!` for zero lag); pwsh installed from `powershell/tap/powershell` (plain cask is dead).
- Tenant transcript gate (`EnableGraphTranscriptAccess`) is a Microsoft-side kill switch enforced 2026-07-29, default off; if fetches suddenly 403 `GraphAccessToTranscriptsDisabled`, that's the first thing to check.
- VTT extension already in the accept list of `transcript-import-dialog.tsx:134`; keep manual path working as the external-tenant fallback.
- App token: single tenant, cache one token (~1 h expiry), refresh at <2 min like the Google server cache; never store it.
- Secret rotation due **2028-08** — put it in whatever ops calendar exists by then.

## 14. Out of scope (deliberately)

- Graph **change notifications** (webhook "transcript ready") — they key off `getAllTranscripts` semantics, broken for add-on meetings; poller cadence is fine.
- OneDrive `Files.Read.All` side-door — unnecessary now that meeting APIs are unmetered and proven.
- External-tenant federation (their admin consenting to our app) — revisit only if a partner asks.
- Per-user delegated Microsoft OAuth — decided against; the granted delegated scopes are dormant.

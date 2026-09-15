# Darth Recorder beta — plan and contracts (2026-09-15)

Goal: a beta colleagues can run for a few days. Detect the call correctly, record the
right thing with separate audio channels, tell the user what is happening where they are
looking, register every recording with the server, upload automatically, and log
everything to .6 for later analysis. Company laptops, company meetings: logging is not a
privacy concern. Perfection is not the goal; a working loop plus data is.

Three work streams run in parallel against the contracts below. Anything not covered here
is the stream owner's call; write it down in this file when you decide it.

Verified facts this plan relies on (2026-09-15 live tests, see memory
`project_recorder_share_mute_detection.md`):
- Teams keeps the mic device open while muted; it closes only on leave. Mic-based call
  detection is accurate to a few seconds; Teams mute is invisible from outside Teams.
- Teams screen/window shares are visible in the unified log through `replayd`/`tccd`:
  who (tccd `AUTHREQ_ATTRIBUTION … accessing={identifier=<bundle>}`; new Teams appears as
  `com.microsoft.teams2.modulehost`), kind (`isFullDisplayShare=1|0`), target
  (`SLContentFilter initWithDisplay: displayID = N, shareAll = YES` or
  `initWithDesktopIndependentWindow: windowID = 0x…`, ids unredacted), start
  (`SCReporting initWithClientBundleID` + `Created New Stream … Hash=`), end
  (`RPRecordingManager invalidateFilterTimerForStream`). `outputType` on the
  `isFullDisplayShare` line: 0 = picker thumbnail (ignore), 1 = real share, 3 = our own
  recording. `SLContentStream stop:` only fires on explicit Stop sharing — do not key on it.
- The largest Teams window is the main Chat/Calendar window, never the call window.
- `NSScreen.main` for a background app lands on an arbitrary display.

## Stream T — tray (Swift, `poc/mac-recorder`), version 0.2.0

### Detection
- Window pick for a detected call, in order: (1) title patterns per app — Teams: skip
  titles starting with `Chat |`, `Calendar |`, `Activity |`, `Teams |`, `Calls |`,
  `OneDrive |`, `Apps |`, `Copilot |`; prefer titles containing `Meeting`, `Call`, or the
  pattern `<name> | Microsoft Teams` that is not a nav tab; Zoom: `Zoom Meeting`,
  `Zoom Webinar`; Slack: `Huddle`; (2) frontmost window of the app (CGWindowList order,
  not area); never largest-by-area. Re-resolve the window when Record is pressed and every
  5 s while recording. Log every candidate window (id, title, frame, z-index, on-screen)
  at detection and at each re-resolve — this is the data we need from colleagues.
- Share detector: `/usr/bin/log stream --style compact --predicate '…'` subprocess
  started with the tray, parsed line by line. Emit `share_started {app_bundle, kind:
  display|window, display_id?, window_id?, window_owner?, window_title?}` and
  `share_ended`. Rules: ignore `outputType=0`; ignore own bundle
  `io.trames.darth.recorder`; a share by the same app as an active call holds the call
  open; resolve window ids to owner/title with CGWindowList immediately (ids die with the
  window).
- Call end: mic closed for 3 polls (unchanged) AND no active share from that app.
- Log to `~/Library/Logs/DarthRecorder/events.jsonl` (one JSON object per line, `ts`,
  `kind`, payload; rotate at 20 MB, keep 5) in addition to tray.log. Every detection,
  candidate list, share event, banner show/hide/click, user action, recording
  start/stop/segment, upload step, auth step, error.

### Recording
- Video source = the call window: `SCContentFilter(desktopIndependentWindow:)`. If the
  window disappears, fall back to the display that contained it and log it.
- System audio = a second SCK stream on the display containing the call window,
  `capturesAudio = true`, `excludesCurrentProcessAudio = true`, minimal video config
  whose frames are dropped. Written as audio track 1.
- Microphone = `AVAudioEngine` input tap, AAC, written as audio track 2. Request
  Microphone permission the first time a recording starts; if denied, record without
  it and log it. Tracks are never mixed at capture. Track order and titles in the mp4:
  video, `system`, `mic` (set `AVAssetWriterInput` metadata/language tags so ffprobe
  shows which is which).
- Share-aware: when `share_started` arrives for the call's app while recording, finish
  the current segment and start segment N+1 whose video source is the shared window or
  display; on `share_ended` roll back to the call window. Segments are files
  `<base> part<N>.mp4` in `~/Movies/Darth Recorder/<recording-id>/`. Audio streams keep
  running across segments (each segment carries its own audio tracks for that span).
- Stop: on call end while recording, banner "Call ended — stopping in 60 s" with **Stop
  now** and **Keep recording**; auto-stop at 60 s. The manual stop path must not log
  "Failed to stop a stream that is already stopped" — find the double stop and fix it.
- "Record this display" stays in the menu as an explicit choice.

### Banner and icon
- Place on the display containing the call window; fall back to the display under the
  mouse; never `NSScreen.main`.
- Visual: 6 px accent bar on the left (green = call detected, red = recording, amber =
  warning), slide-in from the top edge, light and dark appearance handled explicitly
  (`appearance = NSAppearance(named: .darkAqua)` on the panel so labels are white on the
  HUD material).
- Lifetime: while a call is live the banner stays as a compact pill (icon + "Teams call ·
  Record") until Record, Not now, or call end; recording state stays as a compact pill
  with the clock and Stop. Auto-hide only for transient messages.
- Every banner with a warning about recording carries a Stop button.

### Auth, registry, telemetry, upload
- Sign-in = the darth device flow, same as darth-cli (`~/crp-workspace/darth/cli/src/core/login.ts`
  is the reference: start → open browser URL → poll → `dth_` token). Request scopes
  `meetings=readwrite`. Store `{token, email, expiresAt}` in
  `~/Library/Application Support/DarthRecorder/auth.json` mode 0600. Menu: "Sign in to
  Darth Meetings…" / "Signed in as <email>" / "Sign out". ws `{cmd:"login"}` triggers the
  flow; status carries `signed_in`, `email`.
- Base URL `https://meetings.darth-internal.trames.io` (override
  `DARTH_TRAY_API_URL`). All calls `Authorization: Bearer dth_…`.
- `device_id`: UUID generated once, stored next to auth.json. Heartbeat every 5 min and on
  launch: `POST /api/recorder/heartbeat`.
- Telemetry: batch `events.jsonl` lines not yet shipped to `POST /api/recorder/events`
  every 60 s and at recording stop; keep a shipped-offset file; never block on failure;
  cap batch at 500 events.
- Recordings registry: `POST /api/recorder/recordings` at recording start (status
  `recording`), `PATCH /api/recorder/recordings/:id` on every segment and at stop
  (`local`, bytes, duration, segments, call, shares). Recording id = UUID minted by the
  tray.
- Auto-upload (default ON, menu toggle "Upload recordings automatically"): at stop, for
  each segment in order, upload with the one-shot route the CLI uses
  (`POST /api/transcripts`, see `cli-subcommand-src/index.ts` upload code — read only, that
  file belongs to another session). Multi-segment recordings upload as one multi-file
  stitch group (same wire fields darth-cli/UI use). Pass `recorderRecordingId=<id>` so the
  server links transcript ↔ recording. PATCH status `uploading` → `uploaded`
  (`transcript_id`) or `upload_failed` (error). ws `{cmd:"upload", recording_id}` retries
  or uploads a recording on demand; ws `{cmd:"list_recordings"}` returns the local
  registry (id, files, bytes, duration, started_at, call summary, status, transcript_id).
- Keep local files after upload (colleagues' disks are fine for the beta); menu "Show
  recordings folder" stays.

### Protocol additions (ws, LocalServer)
Status snapshot gains: `signed_in`, `email`, `device_id`, `share` (null or
`{app, kind, target}`), `recordings_pending_upload` (count), `update_available`,
`update_staged` (already there). New event types: `share_started`, `share_ended`,
`segment_started`, `upload_progress {recording_id, segment, pct}`, `upload_done
{recording_id, transcript_id}`, `upload_failed`, `auth_changed`. **Fix**:
`recording_stopped` must keep `recording:false` boolean and put the file info under
`saved: {path, seconds, bytes, call, recording_id}`.

### Release
Bump to 0.2.0, `./make-app.sh --release`, `./dist-scripts/deploy-to-dot6.sh`. Existing
0.1.5 installs self-update within 6 h; verify one does.

## Stream S1 — server (meetings app)

### Migration 041 `recorder`
```
recorder_devices(device_id uuid pk, user_id text, email text, hostname text, os text,
  app_version text, first_seen timestamptz, last_seen timestamptz, last_ip text,
  last_status jsonb)
recorder_events(id bigserial pk, device_id uuid, user_id text, ts timestamptz,
  kind text, payload jsonb, received_at timestamptz default now())
  index (device_id, ts), index (kind, ts)
recorder_recordings(id uuid pk, device_id uuid, user_id text, email text,
  status text  -- recording|local|uploading|uploaded|upload_failed|deleted
  started_at timestamptz, ended_at timestamptz, duration_s int, bytes bigint,
  segments jsonb, call jsonb, shares jsonb, matched jsonb, transcript_id text,
  error text, created_at, updated_at)
  index (user_id, started_at), index (transcript_id)
```

### Routes (all `withAuth`, Bearer dth_ works already through introspect)
- `POST /api/recorder/heartbeat` `{device_id, hostname, os, app_version, status}` →
  upsert device, respond `{ok, server_time, min_app_version}`.
- `POST /api/recorder/events` `{device_id, events:[{ts,kind,payload}…]}` → bulk insert,
  respond `{accepted}`. Cap 500 per call, 413 above.
- `POST /api/recorder/recordings` `{id, device_id, started_at, call, …}` → insert or
  update by id (owner = caller). `PATCH /api/recorder/recordings/:id` → partial update;
  on every insert/update run `matchRecording()` (below) and store `matched`.
- `GET /api/recorder/recordings?mine=1` → caller's recordings; `GET
  /api/recorder/recordings?event=<occurrence key or meeting code>` → recordings of that
  occurrence visible to the caller. **Caller-scoping gate applies**: a caller may see a
  recording's existence + owner email + status only for occurrences they are involved in
  (reuse `callerInvolvedCodes` / the predicates from `feedback_privacy_caller_scoping_gate`).
  Never expose local paths to anyone but the owner.
- `POST /api/recorder/recordings/:id/nudge` → owner gets a Darth DM ("<requester> asked
  you to upload the recording of <meeting> from your Mac — open Darth Recorder or the app")
  via `sendDarthDm`, house style from `dm-copy.ts`; rate-limit one nudge per recording per
  requester per 6 h.
- `POST /api/transcripts` (one-shot) accepts optional `recorderRecordingId`; when the
  upload finalizes, set `recorder_recordings.transcript_id` and status `uploaded`.
  Touch only `upload-pipeline.ts`'s finalize tail for this, not the route files another
  session is editing (`src/app/api/uploads/route.ts`, `…/link-event/route.ts`).

### `matchRecording()`
Given owner user, `started_at`, `ended_at`, `call.title`, `call.kind`: find the owner's
calendar occurrences (existing per-user calendar cache tables) overlapping the interval;
score = overlap ratio + title similarity (Teams title contains the meeting subject; Meet
window title is the meeting name); store `{event_key, meeting_code, title, score,
candidates:[…top 3]}`. No new calendar reads; cache only.

### Listing integration
In the calendar/not-recording views where a Teams-chat row says "recorded elsewhere — not
importable here" or "recorded — not importable here yet" (`src/lib/format.ts` ~899/912 and
`calendar-meeting-rows.tsx`): if `recorder_recordings` has a matched recording for that
occurrence, render instead:
- owner is the caller: `Recorded on your Mac (<duration>) · Upload` → button posts ws
  `{cmd:"upload", recording_id}` through the companion client (falls back to "open Darth
  Recorder" if no tray is connected).
- another user: `Recorded on <first name>'s Mac (<duration>) · Ask to upload` → nudge
  route; after nudge show "asked <time>".
- status `uploaded`: link to the transcript.
Keep the original Teams-chat text in the tooltip.

### Deploy
`./deploy.sh` after `bun run build` passes with no env (rule). Apply migration 041 on the
VM. Before rsync, confirm the VM copy of the other session's in-flight files
(`cli-subcommand-src/*`, `src/app/api/uploads/route.ts`, `src/app/api/transcripts/route.ts`,
`src/app/api/transcripts/import-text/route.ts`, `src/app/api/transcripts/[id]/link-event/route.ts`,
`src/lib/server/linked-event-ref.ts`) already equals the local working tree (`ssh … md5`);
if not, stop and report instead of shipping someone else's half-done work. Guarded
deploy: `pgrep -f 'claude-agent-sd[k]'` on the VM must be empty before restart.

### S1 as-built (2026-09-15, deployed + prod-verified)

Decisions taken while building (per "write it down in this file"):

- **Extra table `recorder_nudges(recording_id, requester_user_id, requester_email,
  sent_at)`** in migration 041 — the 6 h "Ask to upload" rate limit. A notify
  `dedupe_key` suppresses forever, and tomorrow's ask is legitimate. Claim is an
  `INSERT … ON CONFLICT DO UPDATE WHERE sent_at < now() - 6h`, so it is atomic;
  a failed DM releases the claim.
- **`matched` scoring** (`src/lib/server/recorder-match.ts`): `0.7 × overlap +
  0.3 × title`, match declared at `score >= 0.25`; overlap = shared seconds over
  the SHORTER of (recording, event); title = containment of the smaller token set
  (a window title is longer than the subject), stop-worded. Open recordings
  (no `ended_at`) assume 1 h. Stored shape: `{event_key, event_id, meeting_code,
  occ_start, title, overlap, title_score, score, candidates[≤3], matched_at}`.
  Every write re-matches with stored-value fallback (`matchForWrite`), and a null
  result keeps the previous match rather than deleting it.
- **`?event=` accepts three refs**: `<meetingCode>`, `<meetingCode>|<startIso>`
  (the occurrence key the listing rows / auto-sync ledger use) and the calendar
  `<eventId>|<startIso>` key. Uninvolved caller → `{recordings:[]}`, never 403
  (a 403 is an oracle). Non-owner rows are redacted to
  `{id, mine:false, owner_email, status, started_at, duration_s, transcript_id,
  matched:{meeting_code, occ_start, score}, nudged_at}` — no paths, bytes,
  segments, window titles, shares or error strings.
- **`recorderRecordingId`** rides the one-shot route as `?recorderRecordingId=`
  (also `?recorder_recording_id=` / `x-recorder-recording-id`). The link happens
  in `finalizeUpload` right after a real transcript exists (single file and the
  stitched last part of a group), best-effort — a registry hiccup never fails an
  upload. Failure states stay the tray's job to PATCH.
- **Listing**: `CalendarMeetingRow.recorderRecording` (both layers), rendered by
  `RecorderRecordingLine` inside `calendar-meeting-rows.tsx`; copy lives in
  `src/lib/recorder.ts` (`recorderRowCopy`, client-safe). It replaces the
  Teams-chat verdict line and carries that text in its tooltip. Own recording →
  `Upload` (companion `upload(id, linkedEvent)`; no tray → "Open Darth
  Recorder"); someone else's → `Ask to upload` → nudge route → `asked HH:MM`;
  uploaded → `Open transcript`.
- **Auth note for testers**: since the 2026-09-13 darth-auth cutover the old
  `trames-auth-session` jar is useless here — use `Bearer dth_…`
  (`~/.darth/config.json`). Playwright can drive the real UI by setting that
  bearer as an extra HTTP header on the context (the edge gate accepts a bearer
  for document navigations too); `/api/google/*` and `/api/ms/status` still 403
  ("Requires a browser session") on that path, which is expected.

## Stream S2 — PWA (meetings app client)
- `src/lib/companion/companion-client.ts`: new fields/events above; `recording` stays a
  boolean derived from `m.recording === true`; expose `signedIn`, `email`, `share`,
  `recordingsPendingUpload`, `updateAvailable`, and commands `login()`, `upload(id)`,
  `listRecordings()`.
- `recorder-chip.tsx`: fix the post-stop flip; show a small share glyph while
  `share` is set ("sharing PowerPoint window"); show "update available" dot.
- `recorder-card.tsx` (Settings): sign-in state + "Sign in recorder" button (runs
  `login()`), auto-upload toggle mirror, "Recordings on this Mac" list from
  `listRecordings()` with per-row status (local / uploading N% / uploaded → link /
  failed → Retry) and Upload buttons; installed version + update state.
- Upload dialog: a source option "From Darth Recorder on this Mac" listing the same
  recordings; choosing one sends `upload(id)` with the linked event chosen in the dialog
  (ws `{cmd:"upload", recording_id, linked_event}`; tray forwards `linked_event` fields to
  the one-shot route exactly as the web upload does).
- `companion-banner.tsx`: when a `recording_stopped` event arrives and auto-upload is off
  or failed, offer "Upload now" pre-linked to the matched event.
- Files owned by S2: the four files above plus new components under
  `src/components/recorder-*`. Do not edit routes, format.ts, or calendar rows (S1).

## Order of operations
T, S1, S2 run in parallel. S1 deploys first (routes must exist before 0.2.0 ships). T
releases 0.2.0 after S1 is live and verifies heartbeat/events/recordings appear in the VM
DB. S2 deploys after S1 (same repo; coordinate through git — each stream commits only
its own files, `git status -s` + `git diff --cached` before every commit, plain
subject+body, no attribution lines).

## Out of scope for the beta (write down, do not build)
Teams mute mirroring (needs Accessibility API), Windows companion, deleting local files
after upload, pairing token / Origin allow-list on the ws (still TODO), server-side
segment stitching beyond the existing multi-file path.

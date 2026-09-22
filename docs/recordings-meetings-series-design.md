# Recordings, meetings, series — the product model and how to get there

Status: **design proposal, nothing built.** Written 2026-09-22 (evening SGT) by a reviewer with no prior context,
against main `a2e3ea4` (the last of today's four incident commits: 6287854, 34ec859, 6016596, a2e3ea4). Every
file:line below was read at that commit; no prod database, VM or running app was consulted. Where the docs and the
code disagree it is called out. The owner's rules (§0) are settled; this document maps the product onto them and
does not argue with them.

## 0. The owner's rules (2026-09-22, verbatim intent)

1. **Recordings are for that person and never shared across. Only meetings can be.**
2. **Temporary uploads always go against recordings.**
3. **If a recording is linked to a meeting, access through the meetings API is different** — a recording is reachable
   by its owner, or *through* a meeting the caller may see; never by itself to anyone else.
4. **Uploading / linking is an action from the user** — pop up and ask to confirm, or open the recording in the
   meeting UI to connect it. Never auto-link, never auto-share from a machine match.
5. **The UI needs a clear separation: recordings or files — meetings — series.**

Why now: at 15:48 SGT a Darth Recorder capture of a private Slack DM huddle (row 935) was auto-linked by the server to
the unrelated Google Meet "Triton next steps!" on time overlap alone and auto-shared with the invite's 8 internal
people with edit access (`docs/recorder-link-confirm-spec.md` §1). Fixed the same afternoon: the server no longer
links (6287854), a weak match is never offered (6016596), and the calendar fold requires a confident match
(a2e3ea4). At 17:03 SGT the second round: the calendar listing still folded the Slack recording onto a Teams invite
because the fold reads the recorder's stored *match*, not the meeting's *link*. The owner's verdict: the model
underneath is right, the product does not say it.

---

## 1. The model in one page

### 1.1 Three nouns

| Noun | What it is | Owner | Who can see it | Identity today |
|---|---|---|---|---|
| **Recording** | One continuous capture: its bytes (one or more *parts*), one transcription with one speaker space, the machine's guess about which occurrence it might be. Tray recordings, dragged-in files, CLI uploads, phone clips, and the cloud artifacts an import pulls (Meet video, Teams recording) are all recordings. | The person who captured or uploaded it (`recordings.owner_user_id`). Exactly one owner, always. | **Its owner.** Everyone else only *through* a meeting that holds a clip on it and that they can open. There is no share on a recording and never will be. | `recordings.id` (uuid, migration 044) + the tray-side registry row `recorder_recordings.id` (041) for the Mac's copy. |
| **Meeting** | The document a person works with: title, calendar event, people, the transcript text (a materialisation of its clips), notes/report, shares, labels, activity, the stable `/m/<uuid>`. | The person who made it (`transcripts.user_id`); ownership transferable. | Owner, plus everyone in `transcript_shares` (edit / read). **The only shareable object.** | `transcripts.assemblyai_id` (public id) + `transcripts.id` (int, what shares/labels/series/clips key on) + `meetings.id` (the `/m` uuid, exists pre-import for a calendar occurrence — 031/036). |
| **Series** | A recurring call: a title, a bag of provider evidence keys, and its member meetings. Occurrences are computed live from the calendar, never stored. | Org-global row (`series.created_by` is bookkeeping, not an ACL). | Whoever can open a member meeting, or whose own calendar evidences the series (`visibleSeriesIds`, `src/db-ops/series.ts:31-72`). | `series.id`; membership `series_members(transcript_id UNIQUE)`. |

Two words that are *not* nouns: a **part** is a file inside a recording (never reaches the user or AssemblyAI on its
own); a **clip** is a `[from,to]` window of a recording placed on a meeting's timeline — it is the only thing that
connects a recording to a meeting (`meeting_clips`, 044). "Segment" is retired (design §7).

### 1.2 How one becomes / attaches to another

```
 upload (tray · drag · CLI · phone)  ──►  RECORDING (owner = uploader; private; transcribed)
                                              │
                    user's Link / Make a meeting / Keep ──►  MEETING holds a CLIP on the recording
                                              │                 (title, event, people, shares live HERE)
 import of a Meet/Teams artifact  ──►  RECORDING + MEETING in one user action (the invite IS the meeting)
                                              │
                                 strong provider key / user confirm ──►  SERIES member
```

- **Upload → recording.** Every upload path produces a recording owned by the uploader. It is transcribed (§6 Q3 asks
  whether that stays the default for unclaimed tray recordings). It is listed in the owner's *Recordings* surface
  only. Nothing about it — not its existence, duration, state, title or id — is visible to anyone else.
- **Recording → meeting, by the user only.** Three user actions create the clip: *Link to meeting* (a calendar
  occurrence, or an existing meeting → "Add recording to meeting"), *Make a meeting* (a standalone meeting, given a
  name), *Keep* on a temporary recording (§1.3). The server proposes (a confident calendar match, shown to the owner
  as "Looks like …"), the person disposes. The tray asks before uploading only when the match is confident; no
  answer means unlinked. Auto-upload into one's own private Recordings is not a link and needs no ask (§6 Q4).
- **Cloud import → meeting + recording at once.** A Meet/Teams import is the user's (or their opted-in automation's)
  action on an artifact the provider already shows to every invitee; the invite is the meeting's identity, so the
  meeting is born linked and shared to internal invitees (`src/lib/server/auto-share.ts:5-9` gives the rationale).
  This is consistent with the rules because the occurrence identity comes from the provider, not from a match.
- **Meeting ↔ series.** A meeting joins a series by a STRONG provider key at import (`series-attach.ts:24-35`) or by
  the person confirming a suggestion; weak keys only suggest. A recording never touches a series; an unlinked
  recording has no keys to match on.
- **Unlink** reverses the user's link: the event keys and attendees come off the meeting, link-born shares are
  removed (048 `origin='event-link'`), the recording stays the owner's and the meeting keeps its text (built,
  `src/app/api/transcripts/[id]/route.ts:182-231`). Removing a clip from a multi-recording meeting is the same
  idea one level down (`DELETE …/clips/:ord`, phase 3b).

### 1.3 What "temporary" means

A **temporary upload is a recording with an expiry** (rule 2): private, transcribed, playable by its owner, gone after
30 days unless the owner acts. *Keep* removes the expiry (it stays a recording); *Link* / *Make a meeting* turn it
into a meeting like any other recording. A temporary thing has no `/m` link, no shares, no labels and no series
membership, because it is not a meeting. (Today it is the opposite — see §2 F7.)

### 1.4 Invariants, as testable sentences

- **I1** Every recording has exactly one owner and no ACL row anywhere. *Test:* no table other than `recordings` /
  `recorder_recordings` names a recording together with a user; `transcript_shares` keys on `transcript_id` only.
- **I2** For a caller who is not the owner and holds no access to any meeting with a clip on recording R, every
  route and every listing field answers exactly as it would for a recording that does not exist. *Test:* per route
  under `/api/recorder/**`, `/api/recordings/**`, and per field derived from `recorder_recordings` in
  `/api/calendar-meetings` and `/api/transcripts`, a two-user fixture (owner A, invitee B on the same occurrence,
  no share) gives B the empty/404 answer.
- **I3** No server process writes a recording↔meeting link. *Test:* every writer of `meeting_clips`, of
  `gmeet_context.eventId`, and of `transcript_shares` has a user id in its call chain that came from `withAuth`;
  pollers, sweepers, `POST /api/uploads` open and `finalizeUpload` never do (with the one consented exception of
  cloud imports, whose identity is the provider's, not a match).
- **I4** A machine match (`recorder_recordings.matched`, `gmeet_context.suggestedEvent`) changes nothing anyone but
  the owner sees. *Test:* B's calendar rows, listing rows and detail responses are byte-identical whether A's
  recording is matched to B's occurrence or not.
- **I5** Only meetings are shareable. *Test:* `POST …/shares` on a temporary or unclaimed recording is 409; the
  share UI is absent there.
- **I6** A temporary recording expires unless kept or made a meeting; being kept or made a meeting removes the expiry
  in the same write. *Test:* the sweeper never trashes a row that has a clip on a live meeting.
- **I7** A meeting belongs to at most one series; a recording belongs to none. *Test:* `series_members.transcript_id
  UNIQUE` (exists); no series query touches `recordings`.
- **I8** Unlink restores pre-link visibility. *Test:* after link → unlink, `transcript_shares` for the meeting equals
  the set before the link, and the recording's owner and bytes are unchanged.
- **I9** The legacy listing (`GET /api/transcripts` without `v=2`, `?trash=1`, `?scratch=1`) and `GET
  /api/transcripts/:id` do not change shape for existing rows. *Test:* the existing byte-diff harness
  (`docs/recordings-phase1-spec.md` §5) over 13 callers stays at 0 mismatches.

---

## 2. Where today's code agrees, and where it does not

### 2.1 Agrees (keep, and build on)

| Where | What it already says |
|---|---|
| `migrations/044_recordings.sql:15-21` | The privacy rule, verbatim: reachable through a meeting the caller can access, or by its owner; no ACL table on purpose. This IS rule 3. |
| `src/db-ops/recorder.ts:10-16, 184-194, 262, 269-278` | Registry writes are owner-only by construction; `getOwnRecording` / `listOwnRecordings` are owner-scoped; a foreign id on `POST` is 409, on `PATCH` 404 (`src/app/api/recorder/recordings/[id]/route.ts`). |
| `src/db-ops/same-file.ts:14-22, 83-108` | The byte-dedupe lookup is owner-scoped in its one query and the comment forbids ever adding a cross-owner variant. |
| `src/lib/server/clip-combine.ts:60-75, 371-381` | Adding a recording to a meeting requires the caller to OWN it; a recording the caller can neither own nor reach is 404, never 403. `listAddableRecordings` is caller-scoped in SQL. |
| `src/lib/server/recordings.ts:543-566` (`scopeMediaToRow`) | A clip is the consent that lets a meeting's readers play the bytes; a meeting that holds no clip on a recording gets no media from it. |
| `src/db-ops/recordings.ts:1053-1090` | "Also from this recording" siblings are caller-scoped; even a non-zero count is treated as a leak. |
| `src/app/api/uploads/route.ts` (6287854), `src/lib/server/upload-pipeline.ts:655-657, 679-687, 713-720` | The server never turns a match into a link; an unlinked upload is born with the call's own title and date and no attendees; the auto-share is reachable only when a human's link supplied attendees. |
| `src/lib/recorder.ts:147-176`, `src/lib/server/recorder-match.ts` | The confidence rule lives in one place; provider mismatch vetoes; time overlap alone is never confidence. |
| `src/db-ops/transcripts.ts:481-494, 619` | The listing projects `suggested_event` only to `owner`/`edit`. |
| `poc/mac-recorder/Sources/darth-tray/main.swift:687-704, 1075-1125` | The tray asks "Link to …?" only on the server's `confident` bit, before any byte moves; no answer = unlinked. |
| `src/app/api/transcripts/[id]/link-event/route.ts` | A retro-link merges the event and *suggests* shares (`share-suggestions/route.ts`); it shares nothing by itself. |
| `src/app/api/transcripts/[id]/route.ts:182-231`, `migrations/048_share_origin.sql` | Unlink is first-class and takes back exactly the link-born shares. |
| `src/db-ops/series.ts:31-72`, `src/lib/server/series-attach.ts:24-35` | Series are visible only via an accessible member meeting or the caller's own calendar; auto-attach needs a STRONG key and skips temporary rows. |

### 2.2 Disagrees — findings, privacy first

**F1 — The calendar fold shows other people's recordings, keyed on a machine match (rule 1, rule 3, rule 4).**
`src/db-ops/recorder.ts:353-392` (`recordingsForOccurrences`) joins `recorder_recordings` of ANY owner onto the
caller's occurrences by `matched->>'meeting_code'` + `occ_start`; `src/app/api/calendar-meetings/route.ts:376-398`
calls it for every served occurrence and `recorderRefOf` (`:240-258`) hands the caller the recording's id, owner
email, status, start time, duration and **`transcript_id`**. `stripForRecorderRef` (`src/lib/recording-strip.ts:301-
312, 344-360`) then renders "On Kawen's Mac · 58m 12s · Ask Kawen to upload", or — for an uploaded one — "Recorded on
Kawen's Mac · uploaded · **Open transcript**", and `src/components/recording-strip.tsx:241` builds
`/transcript/<transcriptId>` as the href **without checking whether the caller can open that meeting**. Three
problems: (a) it is exposure of a recording outside any meeting, on the strength of a guess — the very signal that
misfired twice today; (b) a2e3ea4's "confident only" narrows it but does not change its nature: a Slack DM titled
"Triton" during the Triton Meet would pass `title_score > 0` and be folded onto every invitee's row; (c) the
transcript id of a private meeting is handed to people who were never shared on it (a 404 on click, but the id and
"it was transcribed" have leaked). **Verdict on a2e3ea4: necessary, not sufficient.** The fold must key on the
*link* (a meeting the caller can open that is linked to this occurrence), never on `matched`.

**F2 — `GET /api/recorder/recordings?event=` and the "Ask to upload" nudge are the same exposure as an API.**
`src/app/api/recorder/recordings/route.ts:41-64` lists recordings of any owner for an occurrence the caller is
involved in; `othersView` (`src/lib/server/recorder-view.ts:96-114`) returns owner email, status, timings,
`transcript_id` and the match's `score`. `src/app/api/recorder/recordings/[id]/nudge/route.ts:34-46` lets an invitee
act on someone else's private recording (a DM) because the *matcher* tied it to their occurrence. The gate
(`callerInvolvedInOccurrence`) is a gate on the *occurrence*, not on the *recording* — rule 3 says the only gate on
a recording is a meeting.

**F3 — The Recordings tab still offers weak matches (rule 4, and 6016596's own intent).**
`src/components/recordings-surface.tsx:299-325` (`MatchHint`) renders `r.matched` / `reg.matched` at `:422` and `:583`
with "Looks like X · 30%" and a one-click **Link to it** using `matched.event_key`, with no `confident` check —
the 17:03 SGT regression ("a Slack DM offered the Hypercare Teams invite at 0.3") is still live on this surface.
Owner-only, so not a leak, but it contradicts the rule the tray and the listing strip now follow. The comment at
`:384-385` ("The server links a confident calendar match at upload open (P1)") is stale since 6287854.

**F4 — The detail API serves the owner's calendar guess and recorder marker to read-only sharers.**
`src/app/api/transcripts/[id]/route.ts:51-79` returns the full `gmeet_context` (only `splitFrom.meetingId` is
redacted) — including `suggestedEvent` (an occurrence title/time from the owner's calendar) and
`recorder.recordingId`. The listing gates `suggested_event` to owner/edit and the page hides the strip for readers
(`page.tsx:2283-2290`), but darth-cli `meetings get` per the as-built spec would print `suggested event:` to anyone
with read access. Small, but it is the class of thing rule 1 forbids.

**F5 — Link-at-upload shares with edit access; retro-link does not (rule 4's "ask to confirm").**
`src/lib/server/upload-pipeline.ts:713-720` → `autoShareToInternalInvitees` (`src/lib/server/auto-share.ts:12-45`,
`access: 'edit'`) runs the moment an upload opens with a linked event — that is the tray's **Link** tap
(`Uploader.swift:302`), the web stepper's pre-link, darth-cli `upload --event`, and the calendar row's **Upload**
button (`src/components/recording-strip.tsx:221-229` passes the event). The tray card says *"Link to 'Triton next
steps!' (15:30)?"* — it does not say *"and give 8 people edit access"*. The retro-link path (`link-event`) suggests
shares and applies none. Same user intent, two outcomes; the incident's harm was the share, not the link.

**F6 — A recording is born as a meeting; "recording without a meeting" is a title heuristic.**
Every upload creates a `transcripts` row (`createUploadingPlaceholder`, `upload-pipeline.ts:690`; `ingest.ts`) — a
meeting with a `/m` uuid, shareable, labelable. The Recordings tab's second section is `isBareRecording`
(`src/lib/meeting-title.ts:60-65`): "no event AND the title looks like a filename" (`looksLikeFilename`, `:19-27`).
So a tray recording titled "harshil, ivan, Swaralee (DM)" (6016596's cleaner) is *not* bare — it lands in the
meetings timeline as a meeting nobody asked for; a meeting someone named "Recording 3" *is* bare and vanishes into
the Recordings tab. The object model does not encode rule 1 for these rows; only the absence of shares does.
Decision D-B (`docs/recordings-first-class-design.md:322`, "recorder uploads land as a bare recording") is still
untouched (`docs/recorder-upload-ux.md:65`). `recorder_recordings.transcript_id` (041) points at a *meeting*, not
at bytes (landmine #8).

**F7 — Temporary is a flag on meetings, and temporary rows are shareable (rule 2).**
`migrations/042_scratch.sql`: `transcripts.scratch` — "sharing, labels and /m/<uuid> links all work on it"; the
Temporary tab lists "owned + shared" scratch rows (`src/db-ops/transcripts.ts:583`); `POST …/shares` has no scratch
gate. A "shared temporary transcript" is a contradiction under rule 2. darth-cli `upload --scratch` / `list
--scratch` and `POST /api/transcripts?scratch=1` all ride this flag.

**F8 — Consented automations that create meetings and shares (consistent, but must be named as such).**
`src/lib/server/account-auto-sync.ts:558`, `series-auto-import.ts:361`, `gmeet-import-core.ts:572/666/778/1094`,
`teams-import-core.ts:280/416/589` create meetings from cloud artifacts and share them to internal invitees /
watchers. These are not machine *matches* — the provider's conferenceRecord / Graph id is the occurrence — and the
person opted in per series or per account. They fit §1.2's "cloud import" arm. The model must say so explicitly,
or the next reader will read "never auto-share" as covering them (§6 Q8).

**F9 — The calendar row's "Upload" is an implicit link.** `recording-strip.tsx:221-229`: pressing Upload on the
occurrence's row sends `linkedEvent` to the tray. Arguably the person chose the row, so it is their action — but
the label should say "Upload and link to this meeting" and, per F5, not share.

### 2.3 The open question: should "X's Mac recorded this occurrence" survive rule 1?

**Recommendation: no — delete the cross-user existence hint, the `?event=` others-view and the nudge, and replace
them with an owner-side prompt.** Reasons:

1. Rule 1 has no carve-out for "existence + owner + status". The redaction comment in `recorder.ts:10-16` is a
   careful compromise, but a compromise with the rule the owner has now stated as absolute.
2. The hint is computed from the match, which is the signal that produced both of today's incidents. Every
   tightening of the threshold is a bet that the next false positive is rarer; rule 4 says stop betting.
3. The fact that a person recorded a call is itself sensitive. Someone recording a 1:1 for their own notes did not
   agree to eight invitees seeing "On Alok's Mac · 58m · not uploaded yet · Ask Alok to upload".
4. The legitimate need behind the hint — "someone recorded this, please share it" — is better served from the
   owner's side, where the rules allow it: the owner's own calendar row (norec layer) shows *"Looks like your
   recording 'Swaralee (DM)' · 15:48 · 8 min — Link · Not this"* (the existing `suggested-event-strip.tsx`
   turned around), and the owner's Recordings surface shows the same. When the owner links, the meeting appears
   on every invitee's row as "imported → open" through the ordinary imported-state path — the hint survives, as
   rule 3 says it should: *through the meeting*.
5. Cost of keeping it: two cross-user code paths (`recordingsForOccurrences`, `recordingsForOccurrence` +
   `othersView`), a nudge table, a DM template and a redaction contract that every future change must re-prove.

If the owner wants to keep a hint for invitees, the only rule-compatible form is **opt-in by the recording's owner
per recording** ("Let the invitees know I have a recording" toggle on the Recordings card) — a user action, not a
match. I would not build it until someone asks.

---

## 3. The UI: three surfaces

Top-level navigation becomes **Meetings · Recordings · Series** (Series already has its own page at `/series`;
Recordings is promoted from a tab inside the meetings listing to a sibling surface — the tab is a half-way house
that still says "a recording is a kind of meeting row"). Phone width: the same three as a segmented control.

### 3.1 Recordings (or "Files")

What it lists: the caller's own recordings that are not part of any meeting, newest first, in three sections
reusing `recordings-surface.tsx` as it stands:

1. **On your Macs** — registry rows in `recording | local | uploading | upload_failed` (`MacCard`, unchanged).
2. **Uploaded, not in a meeting** — recordings with no clip (`BareCard`, re-sourced: from `recordings` with no
   `meeting_clips` row, not from `isBareRecording`).
3. **Temporary** — recordings with an expiry, with "expires in 12 days" on the card (replaces the Temporary tab).

Row / card anatomy (one recording): source glyph (Laptop / FileAudio / phone) · title (the call's own title, or
"Recording · Sat 20 Sept 22:00" — never a filename as a *meeting* title; the filename lives in the tooltip) · when
· duration · size · "6 segments" · the recording strip (`stripForRecorderRef` / `stripForArchiveRow`, unchanged
vocabulary: uploading / transcribing / transcribed / failed · Retry) · the suggestion line **only when confident**
(reuse `suggested-event-strip.tsx`: "Looks like 'Triton next steps!' · 15:30–16:30 · Google Meet — Link to it ·
Not this · Pick another…") · actions: **Link to meeting…** (calendar picker → creates the meeting linked to the
occurrence; or "an existing meeting" → Add recording to that meeting, the phase 3b clip add) · **Make a meeting**
(today's "Name…", renamed: a name makes a standalone meeting) · **Keep** (temporary only: removes the expiry) ·
**Open** (plays it; the transcript page in *recording mode*: player + text + speakers, no share/notes/labels/series
controls) · **Delete**.

Delete from here: `MatchHint`'s raw-score line (F3); the stale P1 comment; the "Every recording belongs to a meeting"
empty-state copy, which promises the auto-link that no longer exists (`recordings-surface.tsx:205-208`).

### 3.2 Meetings

The listing redesign as built (`docs/listing-ui-redesign.md` §3–§5) already says the right thing: **a row is a
meeting**, the recording strip under the title says what its recordings are doing, one action. Keep it; change
only what the model changes:

- The archive stops needing `hideBare` / `isBareRecording` (`transcript-table.tsx:2186-2191`): unclaimed recordings
  are not meetings, so they are not in the archive query at all. The "2 recordings aren't linked to a meeting yet"
  strip stays (it now reads the Recordings surface's count).
- Row actions (⋯): Link to a calendar event… / **Unlink from event…** (built) / **Add recording ▾** (from my
  recordings · upload a file · on this Mac · check Google/Microsoft — the built menu) / **Recordings…** (the phase
  3b clip sheet: per clip source, offset, policy, *Remove from this meeting* — the recording survives) / Move to
  temporary is **removed** (a meeting cannot become temporary; a person who wants that trashes the meeting and the
  recording goes back to Recordings) / Trash.
- The suggestion strip on listing rows (`transcript-table.tsx:2129-2145`) is deleted once unlinked recordings stop
  being rows; until then it stays gated to owner/edit.
- **Calendar layer** (unimported / no-recording rows): the cloud state strip as built (`stripForCalendarRow`), the
  imported state through the meeting, and — for the caller's OWN unlinked recording with a confident match — the
  owner-side suggestion strip ("Looks like your recording … — Link · Not this"). Nothing about anyone else's
  recording, ever (F1). The `Upload` on a calendar row reads "Upload and link to this meeting" (F9).

### 3.3 Series

`/series` as built: series list, occurrences computed live, member meetings, auto-import settings, suggestions to
attach a meeting. What changes is only what it must *not* show: an occurrence's "recording" column reflects the
linked **meeting's** recording strip (through the meeting), never a registry match. Attach/detach a meeting to a
series stays a user action (`how = manual | confirmed`); auto-attach stays strong-key-only. Recordings do not
appear on this surface at all.

### 3.4 The tray's upload card and the web's suggestion strip

The tray (0.3.13 as built) already does the right sequence: stop → (confident match?) → *"Link to 'X' (15:30)? ·
This recording: Slack · 15:48 · '…'"* [Link] [Not this] → upload. Two changes: the Link button's copy must say
what the link does once F5 is decided ("Link" alone if linking stops sharing; "Link and share with 8" if it does
not); and "Not this" / no-answer opens `…/recording/<rid>` (the recording in recording mode, with the Link picker)
rather than `/transcript/<id>?link=1` — same picker, right noun. The saved card's terminal state is "Uploaded to
your Recordings — Open" (not "Open transcript").

The web suggestion strip (`suggested-event-strip.tsx`) is kept verbatim and lives in exactly two places: the
recording's page and its Recordings card. It is the one place a match is ever shown, and only to the owner.

---

## 4. API and CLI consequences

### 4.1 Server

- **New, owner-scoped:** `GET /api/recordings?mine=1[&unlinked=1][&temporary=1]`, `GET /api/recordings/:id`,
  `GET /api/recordings/:id/audio` (owner, or caller with access to a meeting holding a clip — the two reachability
  arms stated in the route, per 044's header), `POST /api/recordings/:id/link` `{eventRef | eventKey | meetingId,
  title?}` → creates the meeting (or adds a clip to an existing one) and returns it, `PATCH /api/recordings/:id`
  `{keep: true, title?}`, `DELETE /api/recordings/:id`. `POST /api/recordings/:id/align` exists already.
- **Removed:** the `?event=` branch of `GET /api/recorder/recordings` and `othersView`; `POST
  /api/recorder/recordings/:id/nudge`; `recordingsForOccurrences` / `recordingsForOccurrence` cross-user joins
  (the calendar fold becomes a join on the caller-visible linked meeting). `recorder_nudges` is left in place,
  unused, until a later migration drops it.
- **Changed:** `POST /api/uploads` / `POST /api/transcripts` (raw) create a recording, not a `transcripts` row,
  unless `linkedEvent` / `eventRef` / `attachTo` names the meeting (then both, as today); `?scratch=1` maps to a
  temporary recording. `GET /api/transcripts/:id` redacts `suggestedEvent` and `recorder` for `access='read'` (F4).
- **Listing v2 tabs:** `all | mine | shared | trash` are meetings; `scratch` is kept as an alias that serves legacy
  scratch *rows* (there will be some until they expire) and, once §5 step 4 lands, returns `[]` for new uploads.
  `recordings` is not a listing tab; it is its own endpoint.

### 4.2 darth-cli — `meetings` stays, `recordings` is added

- `meetings list` (no flags) is byte-identical to `GET /api/transcripts` and stays so (I9). One observable change
  after §5 step 3: **new** unclaimed uploads no longer appear in it, because they are no longer meetings. Existing
  filename-titled rows stay until someone links or trashes them. The README's "byte-identical output, never change"
  is honoured — the *set* of meetings changes, the *shape* does not.
- `meetings upload` keeps its flags; without `--event` it returns a recording id and prints "uploaded to your
  Recordings — link with `darth-cli recordings link <rid> <ref>`"; with `--event` it returns the meeting as today.
  `--scratch` → temporary recording (`expiresAt` in the reply). `list --scratch` serves legacy rows only and says
  so in `--json` (`legacy: true`); a new `recordings list --temporary` is the replacement.
- New family, no AI verbs (same design rule as `meetings`): `recordings list [--unlinked] [--temporary] [--json]`,
  `recordings get <rid>` (prints `suggested event:` when confident, `expires:` when temporary), `recordings link
  <rid> <event-ref|meeting-id> [--title]`, `recordings make-meeting <rid> --title "…"`, `recordings keep <rid>`,
  `recordings rm <rid>`, `recordings audio <rid> --out`. `meetings get` prints `suggested event:` only for
  owner/edit (F4). `meetings unlink <id>` per the as-built spec.
- Versioned path for anything that would change a shape: `?v=2` rows may gain fields (they already do:
  `recorder_recording_id`, `suggested_event`, `split_off`); the legacy shape never gains or loses one.

---

## 5. Migration path — small steps, privacy first, each with its acceptance check

| # | Step | Touches | Acceptance |
|---|---|---|---|
| **P1** | **Calendar fold keys on the link, not the match.** `recordingsForOccurrences` → return only (a) the caller's OWN recordings (any state) and (b) recordings whose `transcript_id` is a meeting the caller can open (owner or share) and whose `gmeet_context` links this occurrence. `recorderRefOf` drops `transcript_id` for (a) when unlinked; the "Open transcript" action exists only under (b). | `src/db-ops/recorder.ts`, `src/app/api/calendar-meetings/route.ts`, `src/lib/recording-strip.ts` (theirs branch deleted), `recording-strip.tsx:241` | Two-user fixture: A records and uploads unlinked, matched confident to B's occurrence → B's row is byte-identical to "no recording". A links → B (an invitee, auto-shared or manually shared) sees "imported → open"; B (not shared) sees nothing. Playwright script on the norec layer for both users. |
| **P2** | **Remove the cross-user API and the nudge.** `?event=` branch answers only own rows; nudge route returns 404 for everyone; `othersView` deleted. | `src/app/api/recorder/recordings/route.ts`, `…/[id]/nudge/route.ts`, `recorder-view.ts`, `recording-strip.ts:344-360` | I2 holds for `/api/recorder/**`: B gets `[]` / 404 for A's recording under every parameter. `bun test` fixture added. |
| **P3** | **Weak matches never offered anywhere; read-only redaction.** `MatchHint` requires `matched.confident` (or reads `suggested_event`); detail GET strips `suggestedEvent`/`recorder` for `read`. Stale P1 comment fixed. | `recordings-surface.tsx`, `src/app/api/transcripts/[id]/route.ts` | The 17:03 fixture (score 0.3, provider mismatch) renders no hint on the Recordings tab; `GET /api/transcripts/:id` as a read-only sharer has no `suggestedEvent`. |
| **P4** | **Decide and apply F5.** Either (recommended) link-at-upload stops auto-sharing and the tray/web/CLI link paths all behave like retro-link (shares are suggestions), or the tray card and stepper say "and share with N people (edit)". | `upload-pipeline.ts:713-720`, `Banner.swift:272`, upload stepper copy, CLI `upload --event` output | A tray Link tap on an occurrence with 8 internal invitees creates 0 shares (or the card text names the 8 and the access level). `share-suggestions` lists the 8 afterwards. |
| **P5** | **Temporary and unclaimed rows cannot be shared.** `POST …/shares` 409 on `scratch` rows and on rows with no event and no human title; Share button hidden there. Existing shared scratch rows are listed for the owner (a script under `tmp/`, read-only), not touched. | `shares/route.ts`, transcript page | I5. Count of existing shared scratch rows reported to Alok. |
| **P6** | **Recordings surface is its own endpoint** (`GET /api/recordings?mine=1&unlinked=1`), still fed by the same two halves (registry rows + `transcripts` rows with no event and no title) — a pure re-routing so the UI stops depending on the listing's `isBareRecording`. Promote the tab to a top-level surface. | `recordings-surface.tsx`, `transcript-table.tsx`, nav | The Recordings surface shows the same cards before and after; the archive no longer needs `hideBare` for new rows (kept for old ones one release). |
| **P7** | **Uploads land as recordings (D-B).** Behind `MW_RECORDINGS_BORN_BARE`: an upload with no explicit link creates `recordings` + `recording_media` + `recording_transcriptions` and NO `transcripts` row; transcription runs on the recording (§6 Q3); the recording page (transcript page in recording mode) plays it; **Link / Make a meeting / Keep** create the `transcripts` row + clip in one transaction via the existing dual-write (`applyRecordingGraph`). `recorder_recordings.transcript_id` is joined by `recording_id`. | `upload-pipeline.ts`, `ingest.ts`, `post-completion.ts` (ready-DM keyed by recording), new `/recording/[id]` route, `db-ops/recordings.ts` | With the flag off: the phase-1 diff harness stays at 0 mismatches. With it on: a tray upload produces no `transcripts` row; `meetings list` does not show it; `recordings list` does; Link produces exactly one meeting with one clip and the meeting's `/content` equals the recording's payload verbatim (compat mode). Offline plan `rev` unchanged for existing meetings. |
| **P8** | **Temporary = recording with expiry.** `recordings.expires_at`; `?scratch=1` / `--scratch` set it; the 5-minute sweeper trashes expired *recordings* (bytes + transcription) unless a clip exists; Keep clears it. `transcripts.scratch` stops being written for new uploads; the Temporary tab reads both sources until the legacy rows expire (30 days), then only recordings. | migration `049`, `upload-pipeline.ts`, sweeper, Temporary surface, CLI `list --scratch` note | I6; a kept recording survives the sweep; an expired one is gone; a legacy scratch row is still served by `?scratch=1` until its own 30 days. |
| **P9** | **Delete the heuristics.** `isBareRecording` / `looksLikeFilename` used only for the legacy-row grace period, then removed; `MatchHint` removed; the listing-row suggestion projection removed; `recorder_nudges` dropped. | as named | `grep` finds no reader; tests deleted with them. |

Order rationale: P1–P3 close the exposure with no schema change and no visible loss for anyone but the person who
would have seen someone else's recording; P4–P5 close the share paths; P6 is a refactor that makes P7 a swap; P7–P8
make the model true; P9 is cleanup. Each of P1–P5 is a half-day and independently shippable; P7 is the multi-day
one and rides the existing flag/dual-write/diff-harness machinery.

---

## 6. Risks, and the decisions only the owner can make

### 6.1 Risks

- **Playback of an unclaimed recording** needs a route that serves media by recording id under the two reachability
  arms; today every media path is keyed on a `transcripts` row (`/api/transcripts/:id/audio`, offline plan, frames,
  voiceprints). P7 must not touch those; the recording page uses the new route only.
- **Two "recording" tables.** `recorder_recordings` (the Mac's view of the file, 041) and `recordings` (the server's
  bytes, 044) both stay; the link is `recordings.recorder_recording_id`. Confusing the two is the likeliest bug.
- **CLI users scripting on `meetings list`** will stop seeing new unclaimed uploads after P7. The shape is unchanged
  (I9) but the set shrinks; ship `recordings list` (P6/P7) before, and say so in the CLI README.
- **Ready-DM and SSE keys** embed the meeting id (`mw-transcript-ready:<id>`, landmine #9); a recording that becomes
  a meeting later must not DM twice and must not DM never. Key the DM on the recording; the "meeting made" moment
  needs no DM.
- **Existing rows with filename titles** (18+ groups, design §0) and existing shared scratch rows are grandfathered;
  they keep working as meetings. Nothing is migrated backwards.
- **Series suggestions** read `gmeet_context` of transcripts only; a recording promoted to a meeting via Link gets
  its keys at that moment and auto-attach runs then (strong keys only) — already how `autoAttachSeries` behaves for
  linked uploads.

### 6.2 Decisions for the owner (recommendation in bold)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Does the invitee-side existence hint ("X's Mac recorded this · Ask X to upload") survive rule 1? | **No** (§2.3). Delete it and the nudge; the owner-side "Looks like your recording …" prompt replaces it; a per-recording opt-in "tell the invitees" is the only rule-compatible revival, not built until asked. |
| Q2 | When the user *links* a recording to an occurrence (tray Link, stepper, CLI `--event`, calendar-row Upload), does the link also share the meeting with all internal invitees with **edit**? | **No — link never shares.** Sharing is a second, explicit ask ("Share with the 8 invitees?") using the existing share-suggestions list, defaulting to *read*. Same behaviour on all four link paths and on retro-link. If the owner prefers to keep the auto-share, the card and the stepper must say it and the level. |
| Q3 | Is an unclaimed recording transcribed on upload (today) or only when claimed (D-B's "never bill AAI for a recording nobody has claimed")? | **Transcribe on upload**, default on, tray setting "Transcribe recordings when uploaded" to turn off. The owner's Recordings surface is useless without text, the incident was about sharing not cost, and DEC-4 already made the AssemblyAI id disposable. D-B's cost worry is met by the same-file check and the 30-day expiry on temporaries. |
| Q4 | Is the tray's auto-upload (default on, `main.swift:89-91`) a "user action" under rule 4? | **Yes.** Upload lands in the owner's private Recordings and shares nothing; the ask is for the *link*. Keep the toggle; keep "Keep on this Mac" in the Record dialog. |
| Q5 | Does "Name…" on a recording make a standalone meeting? | **Yes, and call it "Make a meeting".** A name on a recording is a meeting's title; a recording keeps the call's own title as a label, not a name. |
| Q6 | What does *Keep* do on a temporary recording? | **Removes the expiry; it stays a recording.** "Make a meeting" and "Link" are separate actions that also remove it. Retention of kept recordings: same as any recording (D-F: originals deleted only by the owner). |
| Q7 | Existing shared temporary rows and existing filename-titled shared meetings — grandfather or unshare? | **Grandfather**, and hand Alok the list (P5). They were shared by a human. |
| Q8 | Confirm the cloud-import arm: a Meet/Teams import (manual, series auto-import, account auto-sync) creates a meeting shared to internal invitees/watchers without a per-occurrence ask. | **Keep as is**, stated in the model as "the invite is the meeting; the artifact is the provider's; the person opted in". It is not a machine match. |
| Q9 | Should `recorder_recordings.transcript_id` be repointed to `recordings.id` (landmine #8) in P7? | **Yes**, additive column `recording_id`, the old column kept for the tray's "uploaded ✓" until 0.3.15 reads the new one. |
| Q10 | After P7, new unclaimed uploads disappear from `darth-cli meetings list`. Acceptable? | **Yes**, with `recordings list` shipped first and one line in the CLI README. The legacy shape is untouched. |
| Q11 | Top-level nav (Meetings · Recordings · Series) vs the Recordings tab inside the listing? | **Top-level.** The tab says "a recording is a kind of meeting row"; the nav says what rule 5 says. Series is already there. |

---

## Appendix — files this design touches, by finding

| Finding | Files (read at `a2e3ea4`) |
|---|---|
| F1 | `src/db-ops/recorder.ts:292-392`, `src/app/api/calendar-meetings/route.ts:240-258, 376-398`, `src/lib/recording-strip.ts:301-360`, `src/components/recording-strip.tsx:186-241`, `src/components/calendar-meeting-rows.tsx:667-679` |
| F2 | `src/app/api/recorder/recordings/route.ts:41-64`, `src/app/api/recorder/recordings/[id]/nudge/route.ts`, `src/lib/server/recorder-view.ts:48-114`, `src/db-ops/recorder.ts:415-464` (nudges) |
| F3 | `src/components/recordings-surface.tsx:299-325, 384-385, 422, 583` |
| F4 | `src/app/api/transcripts/[id]/route.ts:43-79`; CLI spec in `docs/recorder-link-confirm-spec.md` ("darth-cli — the two-line spec") |
| F5 | `src/lib/server/upload-pipeline.ts:713-720`, `src/lib/server/auto-share.ts:12-45`, `poc/mac-recorder/Sources/darth-tray/Banner.swift:272-316`, `Uploader.swift:302`, `src/components/recording-strip.tsx:221-229` |
| F6 | `src/lib/meeting-title.ts:19-65`, `src/components/transcript-table.tsx:2186-2191`, `src/lib/server/upload-pipeline.ts:690-704`, `migrations/041_recorder.sql` (`transcript_id`), `docs/recordings-first-class-design.md:322` (D-B) |
| F7 | `migrations/042_scratch.sql`, `src/db-ops/transcripts.ts:583, 2249-2273`, `src/app/api/transcripts/[id]/shares/route.ts`, `../cli/src/subcommands/meetings/README.md` (`list --scratch`, `upload --scratch`) |
| F8 | `src/lib/server/account-auto-sync.ts:410-452, 558-595`, `src/lib/server/series-auto-import.ts:361`, `src/lib/server/gmeet-import-core.ts:572-1094`, `src/lib/server/teams-import-core.ts:280-589` |
| F9 | `src/components/recording-strip.tsx:221-229` |

---

## As built — P1–P3 (2026-09-22, commits `7a1242b`, `68c06fe`, `4297190`)

P1, P2 and P3 are shipped on `main`. Nothing from P4 onward was touched; §3–§4's surfaces, the
share paths (P4/P5), the recordings endpoint (P6) and the model changes (P7–P9) are all still ahead.
No migration, no deploy, no prod database was involved. Line numbers below are at `4297190`.

### P1 — the calendar fold keys on the link (`7a1242b`)

| Where | What it is now |
|---|---|
| `src/db-ops/recorder.ts:8-27` | The module header states the two reachability arms and says plainly that a match is not one of them. |
| `src/db-ops/recorder.ts:311-315` (`RecorderCaller`) | Both folds now take `{userId, email}` — a share is keyed on the email, not the id. |
| `src/db-ops/recorder.ts:327-357` (`linkedMeetingLateral`) | Arm (b) as a LATERAL: the meeting the recording is LINKED to (`transcripts.assemblyai_id = r.transcript_id`), when the caller owns it or holds a `transcript_shares` row on the lower-cased email, and when the MEETING'S OWN `gmeet_context.meetingCode` + `IMPORTED_OCCURRENCE_START` (±`OCCURRENCE_WINDOW_S`) say it is this occurrence. It never reads `matched`. |
| `src/db-ops/recorder.ts:394-431` (`recordingsForOccurrences`) | `WHERE r.user_id = $caller OR linked.assemblyai_id IS NOT NULL` — arm (a) or arm (b), nothing else. The projection serves `linked.assemblyai_id AS linked_transcript_id` in place of the old `r.transcript_id`. |
| `src/db-ops/recorder.ts:359-372` (`OccurrenceRecordingHit`) | `transcript_id` → `linked_transcript_id`. |
| `src/app/api/calendar-meetings/route.ts:239-269` (`recorderRefOf`) | `transcriptId: hit.linked_transcript_id`. An unlinked recording — the caller's own included — hands out no meeting id, so the strip's "Open transcript" exists only where the caller can genuinely open it. |
| `src/app/api/calendar-meetings/route.ts:108-114, 386-391` | Doc comments restated: the row carries the caller's own recording or one linked to a meeting they can open, never a colleague's unlinked one. |
| `src/lib/recording-strip.ts:396-412` | NEW branch: `uploaded` with no linked meeting reads "Recorded on your Mac · 44m 31s · uploaded to your Recordings", no action. Without it the ref would have fallen through to the owner branch and said "not uploaded yet · Upload" about an uploaded file. |
| `src/components/recording-strip.tsx:219-223` | The `actionHref` is unchanged in code; the comment above it records that `rec.transcriptId` is now arm (b) and only arm (b). |

**Deviation (deliberate, documented in the code at `src/db-ops/recorder.ts:373-393`):** the batch fold still
narrows candidates by the stored confident match before evaluating arm (b), so arm (b) is checked over
confidently-matched rows only rather than over every linked recording. Doing it the other way round means a
cross join of occurrences × recordings with a correlated EXISTS on a listing hot path. It costs nothing
observable: the calendar layers anti-join every occurrence ANYONE has imported
(`db-ops/imported-occurrences.ts` `importedOccurrenceAntiJoin`, used by `norecWhere` /`unimportedWhere`), so an
occurrence whose linked meeting the caller can open is not served by these layers at all. Arm (b) is the belt
on those braces. If P6/P7 ever serve a fold from a layer without that anti-join, the driving join must be
rewritten.

**Acceptance.** `src/db-ops/__tests__/recorder-occurrence-scope.test.ts` — 5 SQL-shape tests over the fake
postgres tag (the arms, the meetings predicate with the lower-cased email, the lateral asking the meeting's own
keys and never `matched`, the projection carrying only arm (b)'s id, the empty page asking nothing). The
two-user fixture ran end to end against a **real scratch Postgres built from this repo's own migrations**
(`bash scripts/scratch-db.sh up --dir tmp/recordings-p1 --port 55931 --db mw_p1 --schema-prefix p1test`, then
`bun test ./tmp/recordings-p1/p1.check.ts` — 7 pass, 0 fail; `tmp/` is gitignored so the check is not
committed):

- A records the occurrence and does not upload → A's own row shows it, B's and C's are empty.
- A uploads, does NOT link, shares that meeting with B → B's fold is empty; A's own hit carries no meeting id.
- A links it and shares with B → B's fold has the row **with** the meeting id, attributed to A.
- A links it and does not share → C's fold is empty; A's carries the id.
- The share matches case-insensitively; trashing the meeting takes arm (b) with it.
- A weak match is folded for nobody, the owner included.

The Playwright pass over the norec layer for two live users named in the P1 row was **not** run (no deploy, no
prod data): the database-level fixture above is what was proved.

### P2 — the cross-user surface is gone (`68c06fe`)

Removed: the `?event=` branch of `GET /api/recorder/recordings` (it now answers 400 and says why —
`src/app/api/recorder/recordings/route.ts:42-50`); `othersView` / `OthersRecordingView` / the `RecordingView`
union (`src/lib/server/recorder-view.ts`, header rewritten at `:7-17`); the whole
`POST /api/recorder/recordings/:id/nudge` route file; `getRecordingAnyOwner`, `claimNudge`, `releaseNudge`,
`lastNudgeAt`, `NUDGE_WINDOW_H` and the `recorder_nudges` LEFT JOIN on the fold; `nudgedAt` from
`RecorderRecordingRef` and `nudged_at` from `OccurrenceRecordingHit`; `'nudge'` from `StripActionKind` and
from `RecorderRowAction`; the "Ask X to upload" branches in `stripForRecorderRef`
(`src/lib/recording-strip.ts:461-480`, now says who has it and offers nothing) and `recorderRowCopy`
(`src/lib/recorder.ts:307-318`); the nudge fetch and its state in `RecorderRefStrip`
(`src/components/recording-strip.tsx:186-230`).

**The `recorder_nudges` table is untouched** — no migration, as P2 says; a later one drops it.

`recordingsForOccurrence` (the single-occurrence fold, caller-scoped in P1) went with the listing it existed
for, so its two P1 tests went with it. `?mine=1` — the only thing the Recordings surface and the tray read —
keeps its shape byte for byte (`rows.map(ownView)`), and `ownView` is unchanged. **darth-cli never called
any of `/api/recorder/**`** (checked `../cli/src`: no reference at all), so there is no CLI compatibility
question; the tray only POSTs/PATCHes the registry (`poc/mac-recorder/Sources/darth-tray/Api.swift:14-15`).

**Acceptance.** `src/lib/__tests__/recorder-cross-user-surface.test.ts` — 7 tests asserting the route file is
gone, that nothing fetches `/nudge`, that `db-ops/recorder.ts` never names `recorder_nudges`, that the route
serves `?mine=1` and answers `?event=` with a 400 rather than falling through, that only `ownView` exists, and
that no ref carries nudge state. These are deliberately source-level: what must hold is that the code is not
there to be called. A route-handler harness does not exist in this repo (no test mocks `withAuth`), and adding
one would have meant a process-wide `mock.module` of `@/db-ops/recorder` — the hazard the clips test warns
about at its head.

### P3 — confident only, and a reader is told no guesses (`4297190`)

| Where | What it is now |
|---|---|
| `src/lib/recorder.ts:143-167` (`recorderRowIsConfident`) | NEW, and the one question a surface asks: the server's `matched_confident` when the row carries it, `recorderMatchIsConfident(matched)` otherwise. Pure, so it is unit-testable and the client bundle needs no server module. |
| `src/components/recordings-surface.tsx:67` | `OwnRecorderRecording` gained `matched_confident?: boolean` (the server has served it all along). |
| `src/components/recordings-surface.tsx:426` (`MacCard`), `:588-592` (`BareCard`) | Both `MatchHint` call sites gated; `BareCard`'s one-click **Link to it** renders only for a confident match, and `linkSuggested` re-checks (`:505-509`). |
| `src/components/recordings-surface.tsx:384-389` | The stale "The server links a confident calendar match at upload open (P1)" comment replaced with what is true since `6287854`. |
| `src/lib/reader-redaction.ts` (NEW, 50 lines) | `redactForReader(row)`: for `access === 'read'`, drops `gmeet_context.suggestedEvent` entirely and reduces `gmeet_context.recorder` to `{recordingId}`. Owner/editor rows are returned **by identity**. |
| `src/app/api/transcripts/[id]/route.ts:27, 72-79` | The GET payload goes through it. |

**Deviations.** (1) §4.1 says the detail route redacts "`suggestedEvent` and `recorder`"; the task's own
wording is "`suggestedEvent` or the recorder marker's **call details**", and that is what was built —
`recorder.app` / `recorder.kind` go, `recorder.recordingId` stays, because a recording IS reachable through a
meeting the caller can open and a read share is exactly that reachability (rule 3, `migrations/044` header).
The reader loses the player's "no video, during a Slack call" sentence
(`src/lib/suggested-event.ts:85`, rendered at `src/app/transcript/[id]/page.tsx:3321`) and nothing else.
(2) `MatchHint` keeps its "· 82 %" score line — §3.1 lists deleting it, but that is the §3 surface rework, not
P3. (3) One extra, in the same breath as the stale comment P3 names: the Recordings empty state said "Every
recording belongs to a meeting … Recordings from Darth Recorder that match a calendar event land on that
meeting directly" — the auto-link that no longer exists. Rewritten
(`src/components/recordings-surface.tsx:212-217`).

**Acceptance.** `src/lib/__tests__/recorder-row-confident.test.ts` (6) — the gate over both incident fixtures
(the 17:03 Slack-vs-Teams 0.3 and the 15:56 clocks-alone 0.7), the server bit winning over the numbers, and a
source check that both call sites and the two stale copies are as described. `src/lib/__tests__/reader-
redaction.test.ts` (6) — the 17:03 row read-only ("Hypercare", the Teams code and "Slack" all absent from the
serialised payload), a dismissed suggestion redacted too, a null context, and owner/editor identity.

### Suite

`bunx tsc --noEmit -p .` clean · `bunx eslint` clean on every touched file · `TZ=UTC bun test` **1156 pass, 0
fail** across 70 files (1132 before this work: +24 committed tests, −2 that went with
`recordingsForOccurrence`, −1 nudge test replaced) · `bun run build` green with no PG/AAI env.
`src/db-ops/__tests__/helpers/fake-sql.ts` gained `sql.unsafe` (raw fragment, no parameter) so db-ops that
splice a table alias into a predicate builder can be rendered at all.

### Left for the next step

- The owner-side suggestion strip on the caller's own calendar row (§2.3 point 4, §3.2) — P1 removes the
  colleague-side hint and the owner's row now says "uploaded to your Recordings" with no action; the
  "Looks like your recording … — Link · Not this" line that is meant to replace it is §3's work.
- `recorderRowCopy` (`src/lib/recorder.ts:259-318`) has no caller outside its own test — a P9 deletion.
- `resolveOccurrenceRef` (`src/lib/server/recorder-match.ts:270`) lost its only caller with the `?event=`
  branch; kept because P6/P7 will want occurrence refs.
- Everything in P4–P9, unchanged.

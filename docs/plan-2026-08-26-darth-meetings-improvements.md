# Darth Meetings improvement plan — 2026-08-26

Planner session output (Alok's asks, 2026-08-26). Status: DRAFT for review.

**Progress 2026-08-30:** T1 phase 1 SHIPPED (meetings ledger, /m/<uuid>,
former_ids self-heal — 636a461; jobs table still phase 1.5). T5 SHIPPED
(regex=1 + CLI --regex — 18cb005). T3 large slice SHIPPED (POST
/api/meetings/import + CLI 0.41.0 `import --wait` + full `series` verb
family; `calendar-get`/`jobs` verbs pending on phase 1.5). T2/T4 not
started — T2 fires imports on users' behalf, get Alok's design sign-off
(Q3/Q4 below) before building.
Nothing here is built. Each track lists what exists today, the design, the
decisions Alok must make, and rough size. Tracks are ordered by dependency:
**T1 (stable ids + job model) is the foundation the other four sit on.**

Grounding (verified in repo/CLI today):
- darth-cli 0.40.0 `meetings` = read-only archive + calendar layers + labels.
  No series verbs, no import, no wait/poll, `search` is substring only.
- Auto-import is per-series (`series.auto_import_*`, enabler token, 30 m
  sweep). No account-level switch.
- Imports get a placeholder id (`defer-<uuid>`, `up-<uuid>`) that is
  **renamed on promotion** to `gmeet-<code>` / `teams-<…>` / AAI uuid, so a
  link taken at click time can die.
- Video-frame detailed reports already queue from the UI
  (`pendingVideoReport`, 2026-08-20) — but only "now", not scheduled, and
  invisible to the CLI.

---

## T1. One stable meeting id + a first-class job queue  (foundation)

### Problem
The moment you click Import you want a URL you can share and a handle a CLI
can poll. Today the handle is a placeholder that gets renamed, the "waiting"
state lives in three places (deferred-import queue, recording-poller,
pendingVideoReport), and the CLI can't see any of it.

### Design
1. **`meetings` table = the identity.** New table `meetings(id uuid pk,
   created_at, created_by, provider, provider_key, calendar_event_key,
   series_id, title_hint, starts_at, transcript_id null)`. `provider_key` =
   the canonical code we already compute (`gmeet-<code>`, `teams-<callId>`,
   `upload-<hash>`), **unique** — this is the dedupe anchor for T2.
   - `transcripts.assemblyai_id` stays as-is (darth-cli byte-compat rule);
     `meetings.transcript_id` points at it once one exists.
   - `/m/<uuid>` is the permanent URL: 302 → `/transcript/<id>` when the
     transcript exists, otherwise renders the job page (below). Existing
     `/transcript/<id>` links keep working.
   - Placeholder rows (`defer-`, `up-`) stop being the public handle; they
     become internal to the job.
2. **`jobs` table** replaces the three ad-hoc queues over time:
   `jobs(id uuid, meeting_id, kind enum('import','transcribe','notes',
   'report','video_report','speaker_id'), status enum('queued','waiting',
   'running','done','failed','cancelled'), requested_by, requested_at,
   run_after (for scheduling), attempts, last_error, progress jsonb,
   result jsonb, updated_at)`. One poller loop drains it (kind-specific
   handlers wrap today's `gmeet-import-core`, `teams-import-core`, report
   runner). Existing SSE `useLiveEvents` gets a `job` event kind.
   - Migration path: first release writes jobs *alongside* the existing
     queues (dual-write, jobs = read model). Second release switches the
     handlers to consume jobs. No big-bang.
3. **Job page** (`/m/<uuid>` while pending): title, provider, who queued it,
   timeline of job rows, "cancel", and it upgrades itself live into the
   transcript page via SSE when done (T-A remount fix makes this safe).
4. **API**: `POST /api/meetings/import {provider_key|calendar_event_key,
   mode}` → `201 {meeting_id, job_id}` always, even when the same meeting is
   already queued by someone else (returns the existing ids — T2 dedupe).
   `GET /api/jobs/<id>`, `GET /api/meetings/<uuid>/jobs`, `GET /api/jobs?
   status=queued,running&mine=1`. Long-poll variant `GET /api/jobs/<id>?
   wait=30` (server holds up to 30 s, returns on state change) so the CLI
   `--wait` doesn't hammer.

### Decisions for Alok
- **Q1** Is a new uuid per meeting OK, or should the public id *be* the
  provider key (`gmeet-abc`)? Uuid is cleaner (uploads have no natural key,
  Teams keys are ugly) but means two ids in URLs for a while. Recommend uuid
  + `/m/`.
- **Q2** Keep `assemblyai_id` as the transcript pk forever (CLI byte-compat)?
  Recommend yes; `meetings.transcript_id` is the bridge.

Size: ~3–4 days (schema + dual-write + job page + API + poller unification).

---

## T2. Account-level auto-sync with cross-user dedupe

**SHIPPED 2026-08-30** (migration 033, `lib/server/account-auto-sync.ts`,
`/api/auto-sync`, Settings card, darth-cli 0.42.0 `meetings auto-sync`).
Decisions taken (Alok, 2026-08-30): Q3 default **off**; Q4 nudge the
organiser via reminder **and Slack DM** (once per occurrence, daily re-check).
Implementation deviates from the sketch below in one way: the sweep does not
list calendars itself — it consumes the per-user 'unimported' reminders the
poller already produces, groups them on a normalised `code|<UTC instant>`
key (raw reminder keys carry each user's calendar TZ), elects ONE importer
(organiser → earliest-connected, Drive files.get pre-check), and shares the
rest in. Dedupe anchor is `auto_sync_log.occ_key` (PK = the claim), not a
UNIQUE on `meetings.provider_key` (a meeting legitimately has two rows when
two users import it by hand; the ledger is what stops the sweep).

### Problem
Auto-import is opt-in per series. People want "import everything I'm in".
If 5 people in a meeting all turn it on, we must import **once** and share,
not 5 times — and the same holds for manual queues from two people.

### Design
1. **Per-user setting** `auto_sync` in `notify_prefs`-style table
   (`user_prefs`): `off | mine (I organised) | all (I attended)`, plus
   `providers: {gmeet, teams}`, plus an exclusion list (mutes already exist:
   `calendar_mutes` — reuse). UI in Settings next to the Google/MS link
   cards; one toggle, no per-series clicking. Per-series auto-import stays
   as an override (series `force off` wins over account `all`).
2. **Dedupe = T1's `meetings.provider_key` UNIQUE.** The sweep does
   `INSERT … ON CONFLICT (provider_key) DO NOTHING RETURNING id`; if nothing
   returned, the meeting exists → just **ensure a share** for this user
   (auto-share, silent — existing rule) and, if a job is already
   queued/running, attach the user as a `watcher` (so their Slack DM "notes
   ready" fires too). Manual Import by a second person hits the same path
   → returns the existing meeting/job (T1 API contract).
3. **Whose token runs the import?** Priority: organizer's refresh token if
   they have auto-sync on or have connected Google → any attendee with
   auto-sync on (Meet API listing is participant-visible, Doc/Drive access
   is not — memory `series-recurring-calls` participant-only gotcha) →
   else mark job `waiting(reason='no_token_with_access')` and surface it in
   the requester's reminders dropdown as "connect Google to import this".
   Teams: app-only token, no per-user issue.
4. **Privacy**: auto-sync never widens visibility — imports land shared with
   calendar invitees only (existing auto-share rule) and go through
   `callerInvolvedCodes` gates (memory `privacy-caller-scoping-gate`). The
   30 m sweep runs per user, then dedupes; it never lists other people's
   calendars.
5. Sweep cadence: keep the 30 m gmeet-poller; add "recently ended meetings"
   pass (ended in last 6 h) rather than scanning the whole calendar window
   each time.

### Decisions
- **Q3** Default for new users: `off` (recommend, privacy) or `mine`?
- **Q4** When the *only* token that can reach the Doc is a user with
  auto-sync **off**, do we ask them (reminder nudge) or stay silent?
  Recommend nudge once per meeting.

Size: ~2–3 days after T1.

---

## T3. CLI parity: calendar details, import/queue, `--wait`, series

### Additions to `darth-cli meetings` (needs darth-cli release + server routes)
```
calendar-get <meeting-code|event-key>   details of one calendar-layer row: time,
                                        organizer, attendees, evidence verdicts
                                        (recorded/held/norec), series membership,
                                        already-imported-by
import <meeting-code|event-key|/m/uuid> [--mode transcript|video|both]
                                        [--wait [--timeout 30m]]
                                        → prints meeting id + job id + URL;
                                        --wait long-polls /api/jobs until done
                                        and then prints `get` output
jobs [--mine] [--status queued,running,waiting,failed] [--json]
job <id> [--wait] [--cancel]
report <id> --generate [--video-frames] [--at "2026-08-27 02:00"] [--wait]
                                        schedule/queue detailed report (T4)
notes <id> --generate [--wait]
series                                  index: name, cadence, imported/importable,
                                        auto-import flag, dup badge
series <id>                             occurrences (imported → transcript id,
                                        importable, none), members, keys
series set <id> --title|--auto-import on|off|--notify …
series merge <a> <b>                    same txn as the UI merge (logs who)
series attach <series> <transcript|code>   / detach
series exclude <series> <event-key>
```
Rules carried over: no AI inside the CLI (`no-AI-commands` principle — the
CLI *queues* server-side generation, it doesn't run models); every
mutating verb needs read+write scope; `--json` everywhere; `--wait` uses
the long-poll endpoint with exponential fallback, exits non-zero on
`failed`, prints the URL on every line so agents can hand it to humans.

Agent story ("users' CLI agents can help with the UI"): `darth-cli meetings
skill` gets a section on **triage loops** — `calendar --view unimported
--from … | import --wait` is the "import last week's meetings" one-liner,
and `series` lets an agent tidy duplicates that today only Alok clicks.

### Decisions
- **Q5** Should `import` need a *user* token (Google) present server-side?
  With T2 the server picks a token; CLI import just enqueues. If none can
  reach the artifact, job → `waiting(no_token)` and the CLI says so.
- **Q6** `series merge` from CLI: allow for everyone with edit on both, or
  owner-only? Recommend editors, log actor (same as UI).

Size: server ~2 days (mostly exposing existing series/db-ops as routes),
darth-cli ~2 days.

---

## T4. Scheduled detailed (video-frame) reports from the UI

### Today
Generate dialog queues the video report immediately (`pendingVideoReport`).

### Design (small once T1 jobs exist)
- Generate dialog gains "Run: now | tonight (02:00 SGT) | at …" → writes a
  `report`/`video_report` job with `run_after`. Poller honours `run_after`.
- Listing + detail page show a clock chip "report scheduled 02:00" (from
  jobs), cancellable. Slack DM on completion via existing `notifyUser`.
- Cost guard: at most N concurrent video reports (frames = expensive);
  the queue serialises them, `jobs.progress` carries frames-done so the
  chip can show "12/40 frames".
- Deploy gate improves for free: GUARDED-DEPLOY checks `jobs.status=
  'running'` instead of pgrep (keep pgrep as belt).

Size: ~1 day after T1.

---

## T5. Regex search across meetings with filters (CLI)

### Today
`search <q>` = server ILIKE substring over title/filename/description/notes/
full text, with people/provider/speaker filters. `text <id>` output is
grep-able one meeting at a time.

### Design
- `search --regex <re>` (and `list --q-regex`): server runs Postgres `~*`
  over the same columns. Guard: PG regex is not PCRE-catastrophic-safe but
  we still cap with `statement_timeout 5s` and reject patterns > 200 chars.
  Snippets: `regexp_matches` with 80 chars of context, `--max-hits` per
  meeting (default 5). All existing FILTERS compose (`--participant`,
  `--speaker`, `--provider`, `--label`, `--from/--to`).
- `--scope text|notes|report|title|all` (default all) and `--speaker-line`
  to restrict matches to a speaker's utterances (regex applied per
  `[mm:ss] Speaker:` line, not whole doc) — this is what "who said X"
  actually needs.
- Output: `<id>  <date>  <title>  [mm:ss] Speaker: …match…` so timestamps
  feed `frame`. `--json` carries `{id, ts_ms, speaker, snippet}`.
- Full-text index: notes/report are small; full text lives in
  `transcript_content` — add a GIN trigram index (`pg_trgm`) on the
  rendered text column so `~*` isn't a seq scan over 234+ transcripts.
  (Check `pg_trgm` is available on the .6 PG 17 — it ships with contrib.)
- Local fallback stays: `export --format text` + ripgrep already works
  offline; document it in `skill`.

Size: ~1 day server + ½ day CLI.

---

## Sequencing proposal

| Order | Track | Depends on | Size |
|---|---|---|---|
| 1 | T1 stable ids + jobs (dual-write phase) | — | 3–4 d |
| 2 | T5 regex search | — (parallel with T1) | 1.5 d |
| 3 | T3 CLI: `calendar-get`, `import --wait`, `jobs`, `series *` | T1 API | 4 d |
| 4 | T2 account auto-sync + dedupe | T1 unique key | 2–3 d |
| 5 | T4 scheduled reports | T1 jobs | 1 d |
| 6 | T1 phase 2: retire old queues, poller unification | all above stable | 1–2 d |

Open questions to answer before T1 starts: **Q1, Q2** (id model). Q3–Q6 can
wait until their tracks.

## Not in this plan (parked)
- People registry rework (`docs/deferred-people-registry.md`).
- Ivan Seow voiceprint re-enrollment (small ops task).
- Privacy follow-ups listed in memory `privacy-caller-scoping-gate`.

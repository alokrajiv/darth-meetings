# Darth Meetings

Meeting transcripts, AI notes and recordings for Tramés — part of the darth
family of internal tools (darth tasks, holocrons, darth meetings).
Formerly known as *Meeting Whisperer*.

- **Web**: https://meetings.darth-internal.trames.io (Tailscale-internal,
  darth-auth sign-in). The old `meeting-whisperer.` subdomain 301-redirects here.
- **CLI**: `darth-cli meetings` — see `cli-subcommand-src/` (source of truth
  for the subcommand; built into darth-cli at its build time). By design the
  CLI has **no AI commands**: it exposes deterministic primitives (list, get,
  speaker-named text, search, audio/frame/attachment download, notes/report
  write-back) and the calling AI agent brings its own model.

## Darth family

| Member | Web | CLI | Repo | Local folder |
|---|---|---|---|---|
| darth-auth (login, tokens, installer) | `auth.darth-internal.trames.io` | `darth-cli login` | `darth-auth` (own repo, was `darth-cli/auth-service`) | `~/crp-workspace/darth/auth` |
| Darth Tasks (plagueis) | `tasks.darth-internal.trames.io` | `darth-cli tasks` | `darth-plagueis` | `~/crp-workspace/darth/tasks` |
| Holocrons (was Darth Artifacts) | `holocrons.darth-internal.trames.io` | `darth-cli holocrons` (alias `artifacts`) | `darth-artifacts` | `~/crp-workspace/darth/holocrons` |
| Darth Meetings | `meetings.darth-internal.trames.io` | `darth-cli meetings` | `darth-meetings` | `~/crp-workspace/darth/meetings` (was `meeting-whisperer`) |
| darth-admin (users, module grants, sessions, tokens, audit) | `admin.darth-internal.trames.io` | — | (local repo, no remote) | `~/crp-workspace/darth/admin` |

All members share: darth-auth as the only identity provider (`darth_session`
cookie — an opaque `dss_` value — resolved via `POST /api/introspect`; the
lowercased email is the cross-app join key; app access = the `meetings`
module granted at `admin.darth-internal.trames.io`), one `darth-cli` with
`dth_` user tokens / `dapp_` app tokens resolved via the same introspection, hosting on the .6 VM
behind one nginx under the `*.darth-internal.trames.io` wildcard, and the rule
**one owner per external account link — siblings surface and deep-link, never
re-grant**. The full map (who holds Google / the two Microsoft registrations /
Slack, every cross-member call, the add-a-member checklist) is
[`darth-cli/DARTH-FAMILY.md`](https://github.com/alokrajiv/darth-cli/blob/main/DARTH-FAMILY.md).

**Auth in this member (darth-auth v2, 2026-09-13).** `src/proxy.ts` checks for
the `darth_session` cookie and, for document navigations without one, 302s to
`${DARTH_AUTH_URL}/login?returnTo=<absolute URL>` (streaming routes excluded;
API/XHR get 401 JSON). `src/lib/auth/session.ts` + `with-auth.ts` resolve the
cookie and `Bearer dth_` through the one introspect helper
(`${DARTH_AUTH_INTERNAL_URL}/api/introspect`, 60 s cache) and require the
`meetings` module on **both** paths — `dth_` callers included, which closed the
old bearer bypass; read-scope tokens stay GET-only. `/login` forwards to auth,
`api/auth/session` returns the introspect object, Settings carries the Logout
link (`${DARTH_AUTH_URL}/logout?returnTo=`). No clonetrooper, no kenoby JWT,
no `CLONETROOPER_*` env; grants are edited in darth-admin.

What **this** member owns / consumes:

- **Owns** the Google account link (per-user OAuth, Settings page) and the
  app-only "Darth Meetings" Entra registration used for Teams *meeting*
  transcripts/recordings (no per-user step).
- **Surfaces** the Microsoft *Teams chat* link owned by Darth Tasks on its
  Settings page (status / connect / disconnect proxied to
  `tasks…/api/ms/*` with the caller's darth session cookie; connect round-trips back via
  `?return=`). Meeting imports never need that link.
- **Calls** Darth Tasks `POST /api/notify` (`DARTH_APP_TOKEN`) for Slack DMs,
  and reads `darth_plagueis.ppl/emails` read-only for people lookups.

## What it does

- Upload any recording (multi-GB streaming) or import Google Meet
  transcripts calendar-first; AssemblyAI transcription + diarization.
- **darth uploads** (2026-09-18, `docs/darth-uploads.md`): a file ≥ 8 MiB
  goes browser → Azure Blob (account `darthuploads`, container `meetings`,
  per-blob user-delegation SAS) as parallel 4 MiB blocks — Tailscale and
  nginx out of the byte path, resumable from the block list Azure keeps —
  and the VM pulls the committed blob once (sha256 verified) into the same
  chunked-upload session (`upload_sessions.via = 'blob'`, migration 043).
  Hosts without `DARTH_UPLOADS_ACCOUNT` keep the chunk path for every size.
- Voiceprint speaker auto-ID (ECAPA sidecar) with enrollment on naming.
- AI notes, titles, topical segments and a detailed wiki-style report
  (Claude Agent SDK on the VM), with video-frame screenshots embedded.
- Sharing with per-user read/edit access, deep search, Ask-AI archive chat.
- Temporary transcripts: tick "Temporary" on an upload (or `?scratch=1` on
  `POST /api/transcripts`, `scratch: true` on `POST /api/uploads` /
  `import-text`) for a quick one-off transcription that stays out of the
  main list, search, series and calendar "imported" markers. It lives under
  the **Temporary** tab (`?v=2&tab=scratch`, legacy `?scratch=1`), is still a
  full transcript (AI passes, sharing, labels, `/m/` link), can be kept
  (`PATCH {scratch:false}`, or link it to a calendar event), and is moved to
  the trash automatically 30 days after creation (migration 042).

## Darth desktop shell

Meetings runs inside the Darth desktop shell (Electron, repo `darth/desktop`)
on the same contract as Darth Chat (its SPEC §20.76):

- **Detection** — the shell's UA carries `DarthDesktop/<ver>`. The root
  layout reads the *request* UA at SSR (`src/lib/desktop-shell.ts`), sets
  `<html data-shell="desktop" data-shell-os="mac|win|linux">` and passes
  `inDesktopShell` to `ShellSearchProvider` — first paint already right, no
  hydration diff. (Reading `headers()` makes every page dynamic-rendered.)
- **Events** (shell → page only, window `CustomEvent`s, listened for only
  inside the shell — `src/lib/shell-signals.ts`): `darth-shell:search`
  `{query, submit}` — `submit:false` while typing (shell-debounced, `''` =
  cleared), `submit:true` on Enter; `darth-shell:toggle-sidebar` toggles the
  labels rail on the listing; `darth-shell:new-chat` is not applicable and
  ignored. Nothing flows page → shell.
- **Panel** (`src/components/shell-search.tsx`) — the Darth Chat search
  look: one row per meeting with title, date, meta (owner · duration · where
  it matched · labels) and a ~140-char snippet with the matched words bold.
  Anchored just under the app header, full content width up to 720 px,
  centred, over the page. Opens on the first non-empty query, follows typing
  live, runs at once on Enter and moves focus into the results (↑/↓, Enter
  opens the meeting, Esc closes and clears; a click outside closes). Never
  two panels. Inside the shell there is no in-app search field (see Layout
  below); in the browser the field filters the listing as before.
- **Search** — `GET /api/search?q=` (`src/lib/meeting-search.ts` +
  `src/db-ops/meeting-search.ts`): every whitespace term must occur in the
  title, file name, description, AI notes or transcript text (ILIKE over the
  migration-012 trigram indexes), same visibility and `meetings` gate as the
  listing, max 30 hits (title hits first, then newest); the snippet is cut
  from a 400-char SQL window around the earliest term with bold ranges as
  UTF-16 offsets into the returned text.
- **Layout rules** (`src/lib/listing-layout.ts`) — ONE layout, designed for
  the shell's window (900–1300 px of content, the shell's title band with its
  own search above, its 64 px rail on the left); the browser mirrors it at
  every width, there is no separate wide-browser variant, and nothing
  stretches past 1400 px of content.
  - *Toolbar*: one row at every width, never two. Left: the scope tabs
    (All / Mine / Shared / Trash with counts; they scroll sideways below
    900 px). Right: ONE **Filter** button with a count badge (layers off,
    time range, label filter, each people/organizer/provider term) whose
    popover holds Layers, Labels (current filter + show/hide the rail), Time
    range, People and the Hidden calendar meetings; then a **⋯** menu with
    calendar sync status + Sync now, Refresh, and the column chooser.
  - *Search*: the shell hides the in-app field — the band owns search (⌘L)
    and drives the results panel; no `/` hint there. In the browser the
    field sits at the right of the same row, 240 px (wider on focus), and
    `/` focuses it.
  - *Header*: wordmark + Meetings / Recordings / Series; one **Import
    meeting ▾** split button (menu: Import from… a transcript file, Upload
    media); the offline-save cloud and **Recorder ●** chips always visible;
    an account menu at the far right (Settings, theme, Sign out).
  - *Theme*: set in Darth. Inside the shell the page follows
    `prefers-color-scheme` live (the boot script ignores a stored browser
    choice) and the account menu shows "Theme · set in Darth"; in the
    browser the menu keeps the light/dark toggle.
  - *Table*: no Labels column — labels are chips on the title (max 2 +
    "+n"); Owner · Length · Speakers form a compact right-aligned group with
    fixed widths (shown from 900 px); the date keeps its width and the title
    takes the rest. "Add recording" is a hover/focus "+" icon on the row
    (always visible on touch screens), and the unlinked-recordings notice is
    one slim line.

## Stack

Next.js (App Router) + Postgres (schema `meeting_whisperer_*`) + AssemblyAI +
Claude Agent SDK. Deployed on the .6 dev VM via pm2; nginx in front. The pm2
app, the VM dir and the DB schema keep the historic `meeting-whisperer` /
`meeting_whisperer` identifiers on purpose — only the product-facing name changed.

## Deploy

`./deploy.sh` (from the laptop) — blue/green on the .6 VM, no downtime.
`./deploy.sh --dry-run` prints the plan and what rsync would send, changes
nothing. `./deploy.sh --help` lists every flag.

Why (2026-10-02 12:10–12:35 SGT): the old script built `.next` IN PLACE under
the running process (3–5 min of mismatched chunks → "This page couldn't load"
in the browser and the desktop app), its wait for AI runs matched a darth-chat
process so the restart never came, and the restart itself was an nginx 502.

**Two colours**, one DB, one storage dir:

| colour | dir | pm2 app | port |
|---|---|---|---|
| blue | `~/apps/meeting-whisperer` | `meeting-whisperer` | 3002 |
| green | `~/apps/meeting-whisperer-green` | `meeting-whisperer-green` | 3012 |

Green's `.env.local` and `storage/` are symlinks to blue's (`MW_STORAGE_DIR`
unset or relative resolves against each colour's cwd → the symlink; absolute →
shared anyway). The nginx vhost (`deploy/nginx-meetings.conf`) proxies to
`upstream meetings_app`, whose servers come from `/etc/nginx/mw-active.conf`:
the live colour first, the other as `backup` (a refused connect on the live one
is retried on the backup — `proxy_next_upstream error timeout`, deliberately not
`http_502`: several API routes return their own 502s). The include file lives
directly in `/etc/nginx/`, NOT in `conf.d/` (it is only valid inside the
upstream block). `cat /etc/nginx/mw-active.conf` on the VM = which colour is
live; run ad-hoc `scripts/*.ts` from that colour's dir.

**A deploy** (`deploy.sh` header has the detail): stop the idle colour → rsync
+ `bun install && bun run build` in ITS dir (the live tree is never touched) →
drain files in both dirs → start the idle colour and health-check it on its own
port (`/api/health` 204, `/login` 302) → rewrite `mw-active.conf`, `nginx -t &&
nginx -s reload` (graceful) → public check (flips back by itself on failure) →
15 s grace → wait until the OLD colour has no Claude Agent SDK run (only
processes under `<old dir>/node_modules/@anthropic-ai/claude-agent-sdk*` count —
darth-chat's `/opt/darth-chat/…` runs no longer block it; 15 s × 60,
`DEPLOY_FORCE=1` skips) → `pm2 stop` the old colour, `pm2 save` → remove the new
colour's drain file. Any failure before the flip leaves the live colour exactly
as it was.

**Background jobs and the overlap.** Every colour arms the in-process
pollers/sweepers of `src/instrumentation.ts`, and their in-process guards
(`sweeping`, `globalThis.__mw*` maps) do not reach across processes. Checked job
by job (2026-10-02):

| job | two processes at once |
|---|---|
| ingest-retry | safe — `resetForIngestRetry` is a conditional `UPDATE … RETURNING`; the loser gets "Row changed under us" |
| gmeet-poller + fast lane | mostly benign (account auto-sync claims via `auto_sync_log` ON CONFLICT; DMs carry dedupe keys); series auto-import has no claim → two near-simultaneous ticks could queue two placeholders |
| video-fetch-sweeper | wasteful — two full downloads, atomic rename, last one wins |
| auto-notes-sweeper | risky — notes / speaker-ID backlog runs set `running` unconditionally → two Claude runs on one meeting |
| recording-poller | risky — queued video reports and recombines are read-then-write → duplicate report run, duplicate combined meeting + AssemblyAI job |
| deferred-import-poller | risky — the row stays `waiting` during a multi-minute import → a second process imports it again |
| media-sweeper | risky — the in-place faststart remux uses a fixed temp name (`<src>.faststart.tmp`) → can corrupt the original recording |

So background jobs must never run in both colours, and they don't: a
`.mw-draining` file in a colour's dir pauses its timer callbacks
(`src/lib/server/deploy-drain.ts`; a skipped job runs once within 10 s of the
file going away). The deploy drains the live colour before the new one starts,
boots the new one drained, and removes the new one's file only after the old
process is stopped. Background work therefore PAUSES — never overlaps — from
the drain to the end: normally under a minute; up to 15 min when the old colour
has an AI run to finish (then the new colour is activated anyway and the old
one is left running, drained, with a message to stop it). The file stays in the
retired dir, so a colour pm2 resurrects after a reboot stays passive. HTTP
never pauses. Real DB claims for the risky jobs (above) would make the drain a
belt rather than the braces.

**Not switched with the colours:** the `mw-voiceprint` sidecar runs from BLUE's
`voiceprint/` (deploy.sh keeps that copy current on every deploy; it is still
not restarted by a deploy, as before).

**One-time VM setup** (the owner runs it; idempotent, never touches blue or the
live upstream; `deploy.sh` refuses until it has run):

```bash
ssh azureuser@172.17.0.6 'mkdir -p /tmp/mw-setup' \
  && scp deploy/setup-blue-green.sh deploy/nginx-meetings.conf deploy/maintenance.html \
         azureuser@172.17.0.6:/tmp/mw-setup/ \
  && ssh -t azureuser@172.17.0.6 'bash /tmp/mw-setup/setup-blue-green.sh'
```

It creates the green dir + symlinks, `/var/www/mw-maintenance/` with
`maintenance.html`, `/etc/nginx/mw-active.conf` (blue live) if missing, installs
the vhost (previous copy → `/etc/nginx/mw-meetings-vhost.bak-<ts>`, restored if
`nginx -t` fails) and registers pm2 `meeting-whisperer-green` with blue's exact
command, port swapped to 3012, left stopped until the first deploy builds it.

### Maintenance notice

Only ever the owner's own words — no file, no notice; a 5xx is never assumed to
be a deployment.

```bash
./deploy.sh --message "Deploying the recorder fixes — back by 12:40 SGT" --eta 10m   # notice, deploy, clear
./deploy.sh --message "…" --keep-notice                                               # leave it up afterwards
./deploy.sh --notice "Transcription is slow this afternoon (AssemblyAI)" [--eta 1h]  # post only
./deploy.sh --clear-notice                                                           # remove only
```

It writes `/var/www/mw-maintenance/notice.json` `{message, since, eta_at|null,
build}`; nginx serves it at `/__notice.json` (`Cache-Control: no-store`, 404
when absent) straight from disk, so it answers while the app is down. Readers
(`src/lib/maintenance-notice.ts`):

- `<MaintenanceBanner>` in the root layout — polls every 30 s and on focus,
  "Maintenance until ~HH:MM SGT" when an ETA is set, dismissable per notice;
- `src/app/global-error.tsx` — replaces Next's built-in "This page couldn't
  load" page (what users saw on 2026-10-02 — it is the app's page, not the
  desktop shell's): shows the notice, and for a chunk-load error (a tab on an
  older build) or while a notice is up polls `/api/health` every 5 s and reloads
  itself (at most 3 times in 5 min); Reload / Back stay;
- `deploy/maintenance.html` — nginx's own 502/503/504 page (no colour
  answering): the notice + ETA, else "Darth Meetings is restarting", retries
  the URL every 5 s. App-generated 502s pass through untouched;
- the Darth desktop shell's updating overlay (desktop repo, `src/updating.js`)
  — the same file, per origin, for every family app.

## Dev

```bash
bun install
bun run dev        # scrub PG*/AWS_* env vars from the shell first
```

`next build` must pass with no env vars set — keep config validation lazy.

Auth locally without a real darth-auth: run the stub introspect server and
point the app at it, then run the cutover checks (read-only against the DB):

```bash
bun scripts/stub-introspect.ts 8797 &
DARTH_AUTH_URL=http://127.0.0.1:8797 DARTH_AUTH_INTERNAL_URL=http://127.0.0.1:8797 bun run dev -- -p 3002 &
DARTH_AUTH_URL=http://127.0.0.1:8797 scripts/verify-auth-cutover.sh http://localhost:3002
```

Env reference: `.env.example` (`DARTH_AUTH_URL`, `DARTH_AUTH_INTERNAL_URL`, …).

Reverse-proxy contract (`src/lib/auth/public-origin.ts`): the absolute
`returnTo` sent to darth-auth is built from the request's `Host` plus
`X-Forwarded-Proto`, which the .6 nginx vhost owns (`proxy_set_header Host
$host; X-Forwarded-Proto $scheme`). nginx does **not** set `X-Forwarded-Host`
and passes client headers through, so that header is ignored unless
`DARTH_TRUST_FORWARDED_HOST=1` — only set it behind a proxy that overwrites it.

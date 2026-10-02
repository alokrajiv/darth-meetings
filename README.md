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
- **Search in this meeting** (2026-10-02, like Slack's `in:#channel`) — a
  meeting page offers its meeting to the panel (`useShellSearchScope`). The
  panel's first row is then "Search in <title>", selected by default, so
  Enter in the band (or on that row) applies the chip `in: <title>` in the
  panel header and the query runs over THAT meeting's transcript —
  client-side, over what the page shows (edits and speaker names applied,
  raw text in the Raw view; `src/lib/meeting-scope-search.ts`: every term in
  the same utterance, transcript order). There is no per-meeting server
  search: `GET /api/search` ranks whole meetings. A hit shows `m:ss ·
  speaker` + snippet; Enter / click seeks the player there, scrolls to the
  utterance and flashes it. The chip's × (or Backspace in the results)
  removes it → the broad search across all meetings, as before. ↓ in the
  band hands the keyboard to the panel (desktop `search-field.js down()`),
  and an empty Enter / ↓ opens the panel on its suggestions.
- **Recent searches** — the last 5 queries with their chips
  (`src/lib/recent-searches.ts`), shown when the panel's query is empty;
  click / Enter re-runs one (a scoped one for another meeting navigates
  there first and applies the chip when that page offers it), × forgets it.
  Stored in the shell's local store for Meetings (`window.darthDesktop.store`,
  table `recent_searches`, one row per darth user id; the shell wipes it on
  sign-out), else localStorage (`src/lib/recent-searches-store.ts`). The
  band itself still shows only text: nothing flows page → shell, so a
  recent query picked in the panel is not echoed into the band.
- **Copy link** — no URL bar in the shell, so the meeting page header has a
  **Copy link** button (also first in its ⋯ menu, and ⌘⇧C / Ctrl+Shift+C —
  listed as a page key in the shell's shortcut map), and every listing row's
  ⋯ menu has **Copy link**. It copies the permanent
  `https://meetings.darth-internal.trames.io/m/<meeting uuid>` (migration
  031 ledger id via `GET /api/meetings/resolve?any=<id>`; falls back to
  `/transcript/<id>` when there is no ledger row) and toasts "Link copied"
  (`src/lib/meeting-link.ts`, `src/components/copy-link-button.tsx`,
  `src/components/toast.tsx`). `/recording/<id>` copies its own URL. The
  clipboard write uses a pending ClipboardItem when the uuid lookup is still
  in flight (keeps Safari's user-activation), else `writeText`, else a hidden
  textarea. The web app has no header search on a meeting page, so the
  in-meeting scope is shell-only; in a browser the transcript's own ⌘F
  find (editors) and the browser's find cover it.
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

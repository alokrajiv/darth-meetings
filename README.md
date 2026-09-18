# Darth Meetings

Meeting transcripts, AI notes and recordings for Tramés — part of the darth
family of internal tools (darth tasks, darth-artifacts, darth meetings).
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

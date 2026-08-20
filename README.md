# Darth Meetings

Meeting transcripts, AI notes and recordings for Tramés — part of the darth
family of internal tools (darth tasks, darth-artifacts, darth meetings).
Formerly known as *Meeting Whisperer*.

- **Web**: https://meetings.darth-internal.trames.io (Tailscale-internal,
  Trames SSO). The old `meeting-whisperer.` subdomain 301-redirects here.
- **CLI**: `darth-cli meetings` — see `cli-subcommand-src/` (source of truth
  for the subcommand; built into darth-cli at its build time). By design the
  CLI has **no AI commands**: it exposes deterministic primitives (list, get,
  speaker-named text, search, audio/frame/attachment download, notes/report
  write-back) and the calling AI agent brings its own model.

## Darth family

| Member | Web | CLI | Repo |
|---|---|---|---|
| darth-auth (login, tokens, installer) | `auth.darth-internal.trames.io` | `darth-cli login` | `darth-cli/auth-service` |
| Darth Tasks (plagueis) | `tasks.darth-internal.trames.io` | `darth-cli tasks` | `darth-plagueis` |
| Darth Artifacts | `artifacts.darth-internal.trames.io` | `darth-cli artifacts` | `darth-artifacts` |
| Darth Meetings | `meetings.darth-internal.trames.io` | `darth-cli meetings` | `darth-meetings` (dir `meeting-whisperer`) |

All members share: Trames SSO (`trames-auth-session` cookie, lowercased SSO
email is the cross-app join key), one `darth-cli` with `dth_` user tokens /
`dapp_` app tokens resolved via darth-auth introspection, hosting on the .6 VM
behind one nginx under the `*.darth-internal.trames.io` wildcard, and the rule
**one owner per external account link — siblings surface and deep-link, never
re-grant**. The full map (who holds Google / the two Microsoft registrations /
Slack, every cross-member call, the add-a-member checklist) is
[`darth-cli/DARTH-FAMILY.md`](https://github.com/alokrajiv/darth-cli/blob/main/DARTH-FAMILY.md).

What **this** member owns / consumes:

- **Owns** the Google account link (per-user OAuth, Settings page) and the
  app-only "Darth Meetings" Entra registration used for Teams *meeting*
  transcripts/recordings (no per-user step).
- **Surfaces** the Microsoft *Teams chat* link owned by Darth Tasks on its
  Settings page (status / connect / disconnect proxied to
  `tasks…/api/ms/*` with the caller's SSO cookie; connect round-trips back via
  `?return=`). Meeting imports never need that link.
- **Calls** Darth Tasks `POST /api/notify` (`DARTH_APP_TOKEN`) for Slack DMs,
  and reads `darth_plagueis.ppl/emails` read-only for people lookups.

## What it does

- Upload any recording (multi-GB streaming) or import Google Meet
  transcripts calendar-first; AssemblyAI transcription + diarization.
- Voiceprint speaker auto-ID (ECAPA sidecar) with enrollment on naming.
- AI notes, titles, topical segments and a detailed wiki-style report
  (Claude Agent SDK on the VM), with video-frame screenshots embedded.
- Sharing with per-user read/edit access, deep search, Ask-AI archive chat.

## Stack

Next.js (App Router) + Postgres (schema `meeting_whisperer_*`) + AssemblyAI +
Claude Agent SDK. Deployed on the .6 dev VM via pm2; nginx in front. The
clonetrooper SSO app name and the DB schema keep the historic
`meeting-whisperer` / `meeting_whisperer` identifiers on purpose — only the
product-facing name changed.

## Dev

```bash
bun install
bun run dev        # scrub PG*/AWS_* env vars from the shell first
```

`next build` must pass with no env vars set — keep config validation lazy.

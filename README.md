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

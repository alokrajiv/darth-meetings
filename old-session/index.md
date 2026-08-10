# Session archive — meeting-whisperer

## 1. Voiceprint speaker ID + Claude auto-notes — 2026-07-30

**File:** [1. voiceprint-speaker-id-and-claude-auto-notes.txt](1.%20voiceprint-speaker-id-and-claude-auto-notes.txt)

Built and shipped two intertwined features to the dot6 deployment:

- **Voiceprint speaker auto-ID**: Python sidecar (`voiceprint/server.py`, SpeechBrain
  ECAPA on CPU, pm2 `mw-voiceprint`, port **3004** — 3003 is sentinel's), venv at
  `~/.mw-voiceprint/venv`. Node lib `src/lib/server/voiceprint.ts` picks ≤6 longest
  utterances per speaker, matches cosine vs global `voiceprints` table (rolling-average
  embeddings). Threshold 0.5 + 0.05 margin over best *distinct person*
  (`sameIdentity()` — duplicate free-text names must not compete; an "Ivan"/"Ivan Seow"
  pair suppressed a 0.81 match before that fix). Enrollment fires on every speaker-name
  save; backfill enrolled 303 samples / ~100 people; merged 11 voice-confirmed duplicate
  identities (106→95) — voice cosine saved two wrong name-based merges (Paola 0.20,
  rick 0.04 — different people). UI: "Sounds like X (NN%)" chips + Confirm, and a
  standalone "Guess names" button → `POST /api/transcripts/:id/speakers/suggest`
  (synchronous, no Claude, ~13s for 4 speakers).
- **Auto notes/title/segments/context-speaker-guesses via headless Claude**: one
  `claude -p` call on the VM (configured `opus[1m]` → Opus 5, 1M ctx; uses the VM's
  authenticated Claude Code, no API key; `MW_CLAUDE_BIN` in .env.local). Output
  contract: `TITLE:` / `SPEAKERS:` (evidence-based context guesses, e.g. Harriet the
  external auditor) / `SEGMENTS:` (3–8 topical sections → named jump points in the
  outline + heading dividers in the transcript body) / markdown notes. Prompt receives
  confirmed names + voice matches with confidences. Triggered on first observation of
  completion (post-completion hook — the app has no job queue), or via Regenerate;
  status machine `auto_notes_status`, UI polls at 5s. Speaker renames show a
  "Rerun summary?" stale banner. Migrations 005 + 006 applied on the VM.

Verified E2E with real SSO-cookie curls and Playwright on transcript `ebb6d729` (ISO
27001 audit call): title + notes 24s, segments rendered, Harriet context-guessed with
quoted evidence, Ivan voice-matched 0.81 after margin fix, Yadu N M enrolled from
first naming. All work is uncommitted on the `ui` branch alongside pre-existing UI
changes.

**Next session pickup points:**
1. Decide + delete placeholder voiceprints ("Enterprise SG", "DGF A", "DGF B",
   "Unknown Lady", "agnt") — user hasn't confirmed yet.
2. Sylvia identity is polluted (SATS Sylvia Liew + Thermo Fisher Sylvia Leong averaged
   together) — rename speakers in transcripts dc3c9d78 / 78c6ca07 / b834978a to full
   names, then rebuild both voiceprints (delete rows, re-run targeted backfill).
3. Commit the work (user's call — tree also carries their in-progress UI changes;
   stage new files + my hunks only, per shared-repo rule).
4. Consider linking voiceprints/speaker labels to `people` ids instead of free-text
   names (prevents duplicate identities recurring; watch out: `Person.id` not unique
   across trames/custom sources).
5. Future enrollments under a short name variant will recreate duplicates — consider
   an `aliases` column or name normalization on save.
6. Tune threshold with accumulating data (`scripts/diagnose-voiceprint-match.ts <aai-id>`
   prints raw top-5 cosines per speaker).

## 2. Teams Graph tenant setup and E2E verification — 2026-08-10

**File:** [2. teams-graph-tenant-setup-and-e2e-verification.txt](2.%20teams-graph-tenant-setup-and-e2e-verification.txt)

Set up the entire Microsoft/Teams side for meeting-whisperer, zero to verified.
Started as a "tell me about Teams meetings" research question, ended with working
artifact fetch. Registered the **Darth Meetings** Entra app (Playwright-driven
portal session, Alok clicking commits), added 7 app-only Graph permissions +
admin consent, created + globally granted the `MeetingWhisperer-Access`
application access policy (Teams PowerShell, device-code auth), and flipped the
new tenant transcript gate (`EnableGraphTranscriptAccess` — Microsoft kill-switch
enforced 2026-07-29, default off). Decision (Alok): **full service-account
model** — app-only for calendars AND artifacts, no per-user Microsoft OAuth ever.
E2E proof on the real LP-Global recurring meeting: 11 speaker-attributed VTTs +
11 range-capable MP4s fetched via join-URL resolution under Swaralee. Key
discoveries: `getAllTranscripts` is blind to GSuite-add-on-created meetings
(all of Trames'), Trames Exchange calendars are empty (Google Workspace shop —
discovery must come from the existing Google poller), join URLs embed
organizer Oid + tenant Tid, one onlineMeeting object per recurring series with
occurrences keyed by callId. Wrote the full build spec to
`docs/teams-integration-spec.md` and a deep admin runbook to project memory
(`project_ms_teams_entra_setup.md`). Code: only `config.microsoft` block added
(uncommitted); two codebase-exploration maps (Google OAuth/poller + import
pipeline) are embedded in the transcript.

**Next session pickup points:**
1. Execute `docs/teams-integration-spec.md` §12 build order: `ms-graph.ts` +
   `teams-vtt.ts` + tests → `ingest-parsed.ts` refactor → migration 019 +
   `/api/teams/check` → `/api/teams/import` → poller extension → dialog UI
   (distinct Meet/Teams icons; external-tenant rows labeled + guided manual
   upload, video preferred / docx-vtt fallback).
2. Commit the pending working tree first: `docs/teams-integration-spec.md` +
   `src/config/index.ts` microsoft block.
3. Live test target: LP-Global series under Swaralee (`8c05d801-…`), today's
   occurrence callId `3b465b7d-…`; compare against manual row 219 (`ext-eaced482`).
4. Verification curls + all tenant IDs/gotchas: memory `project_ms_teams_entra_setup.md`.
5. Secret expires 2028-08-09 (rotation note in runbook).

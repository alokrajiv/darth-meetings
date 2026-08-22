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

## 3. Deferred imports, soft-delete trash, and listing perf — 2026-08-19

**File:** [3. deferred-imports-soft-delete-trash-and-listing-perf.txt](3.%20deferred-imports-soft-delete-trash-and-listing-perf.txt)

Three ships, all deployed + prod-E2E-verified:
1. **Deferred imports** (commit 587bace): import while Google is still preparing
   artifacts — `defer-<uuid>` placeholder rows (status `'waiting'`), the import
   route's core extracted to `lib/server/gmeet-import-core.ts`, new 60s
   deferred-import poller replays the frozen request with the owner's server
   token. Per-mode deps: transcript→Doc, video→file, both→both (6h cap).
   Verified end-to-end on the real "alok <> intraa integrations" meeting: video
   deferral queued → auto-ran 29 min later unattended (row `164a4de9…`).
   Finding: transcript quick-import rarely defers — Meet's structured API
   entries land before the Doc is generated.
2. **Soft delete / trash** (commit 67f5689, migration 021 `deleted_at`): DELETE
   soft-deletes by default; Trash tab with restore + delete-forever;
   Move-to-trash button on the detail page + in-trash banner; `deleted_at IS
   NULL` guards across all readers/pollers/dedupe. The E2E-test duplicate was
   left in Alok's trash for him to keep or purge.
3. **Listing perf** (commit 78637ae): `/api/transcripts` was ~195ms server-side —
   194ms was the suspected-series LATERAL running normalization regexps per
   (row × key) (~11k evals/call). `WITH norm AS MATERIALIZED` fence → 33ms
   query, 46-54ms endpoint. Plain subquery hoisting does NOT work (planner
   inlines it). No indexes needed at this table size.

Ops incident: an ungated `pgrep && pm2 restart` chain killed a live Telefonica
auto-report mid-run (exit-0 trap — pgrep FINDING processes exits 0); it was
retriggered and completed. Gating must be a script that reads the count.

**Next session pickup points:**
1. **Enable gzip on the meetings nginx vhost** — API responses are served
   uncompressed (280KB JSON, would be ~40KB). Alok was offered this and the
   session ended before a go-ahead; edit `deploy/nginx-meetings.conf` in-repo,
   deploy to `/etc/nginx/sites-available/meetings`, `nginx -t && reload`.
2. Later perf stages (only when scale demands): precompute normalized series
   keys at write time once ~1k un-attached rows (chip cost is O(rows)); real
   pagination bundle (cursor by day + server-side tabs/search + ETag/304 on
   SSE refetches) at ~2-3k rows. Growth: 116 rows in Aug, accelerating.
3. Cosmetic: video-mode force button says "Re-import (overwrites yours)" but
   creates a SEPARATE row (only transcript-mode truly overwrites) — label lies.
4. Deferred-import edge not yet exercised live: 'both'-mode 6h transcript-wait
   cap, and the 24h give-up path (flips row to error with reason).
5. Memories written: `project_deferred_imports.md`, `project_soft_delete_trash.md`.

## 4. Series UI: index, merge, retro-attach, coverage strip — 2026-08-19

**File:** [4. series-ui-index-merge-retro-attach-coverage-strip.txt](4.%20series-ui-index-merge-retro-attach-coverage-strip.txt)

Built the approved Series UI MVP in one pass (commit `ebc7bb4`), deployed via
the guarded recipe and prod-E2E-verified. Zero migrations. Session started from
a truncated prompt; the full workflow proposal (3 design lenses + synthesis)
was recovered intact from the prior session's task output and followed as spec.

1. **`/series` index page** — new Meetings|Series nav in AppHeader (hidden when
   a breadcrumb renders). Table: members / cadence / last meeting + amber `dup`
   badge on same-normalized-title collisions (flags Integration Cadence 6+1 and
   Data Cadence 9+4 — NOT the Spanish Perfume trio, whose titles normalize
   differently). Cadence = median inter-occurrence gap via `percentile_cont`
   window CTE, classified in the route (≤1.5d/10d/20d/45d). Footer totals from
   new `seriesTotals()`: 18 series · 83 memberships · 190 unattached. Row click
   → existing SeriesDialog (deliberately no /series/:id page). Header actions:
   "+ New series" (prompt) and "Re-scan attachments".
2. **Merge series** — `POST /api/series/:id/merge {fromSeriesId}`: one
   `sql.begin` transaction (keys+members plain UPDATEs — their UNIQUEs can't
   conflict on a series_id change; exclusions INSERT…ON CONFLICT DO NOTHING;
   loser deleted), logs who did it, auto-runs retro-attach after. Dialog footer
   "Merge…" opens an inline picker + loud confirm; new `onMerged(targetId)`
   prop switches the open dialog to the survivor in both hosts. Permissions per
   Alok's leaning: open to all users, confirm + log (not gated).
3. **Retro-attach sweep** — `retroAttachSweep()` in series-attach.ts +
   `POST /api/series/retro-attach`: strong-key re-match over
   `listUnattachedTranscripts()`, attaches to EXISTING series only (no
   create-new), weak-only matches counted as suggestions. Prod: 190 scanned /
   0 attached / 3 suggestions (exactly the 3 pending "?"-chips — import-time
   attach has kept up; the sweep pays off after merges).
4. **Calendar-row series chips** — `/api/calendar-meetings` rows gained
   seriesId/seriesTitle via batch `findSeriesByRecurringBaseIds` (route-level
   enrichment; the big SQL untouched); CalendarEventRow renders the
   member-style chip → SeriesDialog. Verified: 6 unimported + 4 norec rows.
5. **Coverage dot-strip** in SeriesDialog (hidden <4 occurrences): chronological
   dots (solid=imported, amber ring=importable, hollow=bare, dashed=upcoming),
   ⌇ break at gaps >1.75× median, caption ("47 of 51 imported · longest gap
   2 wks (Dec)"), dot click scrolls to its occurrence row (`series-occ-<key>`).

Tested locally against the prod schema (tunnel 5433 + scrubbed-env dev +
cookie-injected Playwright), merge exercised with two throwaway series only.

**Next session pickup points:**
1. **Real dupe merges are Alok's click**: Integration Cadence 1(5)→6(48), Data
   Cadence 9/4, Spanish Perfumes 2/10/11 — then re-run Re-scan attachments.
2. V2 backlog (proposal order): series-scoped Ask AI → delta brief ("since last
   time", approved-summaries only) → per-series auto-import off|remind|import
   (BLOCKED on Alok: token identity + transcript-only question) → keys &
   exclusions drawer → promote dialog to /series/:id when it outgrows.
3. Dup badge is same-normalized-title only — the Spanish Perfume trio needs the
   human eye (visible adjacent in the index anyway).
4. Memory updated: `project_series_recurring_calls.md` (full ship details),
   pickup note in `project_listing_v2_calendar_views.md` collapsed to a pointer.

## 5. Series index: Imported/Importable columns, evidence-based dup pairing, member folding — 2026-08-20

**File:** [5.%20series-index-imported-importable-dup-pairing-member-folding.txt](5.%20series-index-imported-importable-dup-pairing-member-folding.txt)

Triggered by Alok's "this entire UI is stupid" screenshot of /series: the MCAP
dialog claimed "0 occurrences" while the footer said "1 meeting in this
series", and the "dup" badge on Integration Cadence had no visible partner.
Root causes: (a) the occurrence sweep is the CALLER's own Google Calendar /
Teams — a colleague's import in a meeting Alok isn't invited to has no
calendar instance, so it vanished from the list; (b) dup detection was
title-only and the index is sorted by last meeting, so the twin was 12 rows
down. Data finding: both "Integration Cadence" (#6=49, #1=5) and both "Data
Cadence" (#4=2, #9=1) are literally the SAME Meet (`ook-esgs-wkf` /
`vnm-gyww-fiy`) split across keys — one side only held the recurring-base id,
the other only the meeting code (members on both sides carry both).

Shipped + prod-verified (commits 8c31738, 6e5becb, e868401; rsync deploy):
1. **Sweep folds members** no calendar/Graph occurrence claimed into the list
   as `source:'imported'` rows (key `imp-<id>`), so counts always agree with
   "N meetings in this series"; `counts.external` = calendar-seen count (0 with
   members ⇒ "not on your calendar" hint in header + row chip); `bare` excludes
   imported rows; candidates skip soft-deleted transcripts.
2. **`findDuplicateSeries()`** (db-ops/series.ts): siblings by shared series
   key OR member-level evidence — Meet code, recurring base from
   recurringEventId or the `<base>_YYYYMMDDTHHMMSSZ` instance eventId, Teams
   join URL — title-only ranked last; carries `last_recorded_at` for
   disambiguation. `GET /api/series` → `dup_with[]`, `GET /api/series/:id` →
   `dupes[]`.
3. **New `GET /api/series/occurrence-counts?ids=`** (≤8) batches sweep counts
   behind the same 6h per-user cache.
4. **Index**: Members→Imported, new **Importable** column filled progressively
   in chunks of 4 (amber >0, "—" + tooltip when not on your calendar / Google
   not connected, breakdown tooltip), dup groups emitted ADJACENTLY (largest
   first, ↳ tinted siblings, badge says why), footer legend + "N probable
   duplicates". `/series?series=<id>` deep-link opens that dialog on load.
5. **Dialog**: "Probably a duplicate" banner — "Another series with the same
   name (#4, 2 meetings, last Jul 24) is the same recurring event as this one
   (1 meeting)" + **View it ↗** (new tab deep-link) + **Merge this one into
   it**; right-side chips wrap instead of overflowing; "Also in this series"
   is now only the sweep-failed fallback.

Tested via tunnel 5433 + scrubbed-env dev on 3002 + headless playwright-core
script (the shared Playwright MCP browser was held by another session —
`~/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core` +
`chromium_headless_shell-1223` works as a standalone driver).

Real numbers seen: Weekly Tressa Review 16 importable, Data Cadence 21+23,
Spanish Perfume w/ Monday reviews 5, Integration Cadence 2.

**Status: KIV — deployed and usable, but Alok hasn't signed off on the Series
UI as a whole ("ok for now").**

**Next session pickup points:**
1. Alok still needs to do the two real merges (one click now): Integration
   Cadence #1(5)→#6(49), Data Cadence #9(1)→#4(2); then Re-scan attachments.
2. Series UI is KIV — revisit overall design when Alok raises it again; the
   "—" importable cells for colleague-imported series are expected behaviour
   (caller's calendar), not a bug — don't re-investigate.
3. Dialog on a dup series still shows the UNION imported count (e.g. "50
   imported" on the 5-member Integration Cadence) because imported
   cross-reference is key-matched, not member-only — acceptable while the
   banner explains; fix if it confuses after merges are done.
4. Remaining working-tree changes (generate-dialog, stitch uploads, etc.) are
   deployed but UNCOMMITTED — commit them separately.

## 6. Evidence consolidation, 401 self-heal & sync chip — 2026-08-22

**File:** [6. evidence-consolidation-401-self-heal-and-sync-chip.txt](6.%20evidence-consolidation-401-self-heal-and-sync-chip.txt)

Started from Alok's screenshot pair (listing vs import dialog disagreeing on
21 Aug meetings — "APP Thru" missing, Data scrum "No recording" while the
dialog showed recording+transcript) and the question "is the entire codebase
disorganised?". Two explorer agents produced a full inventory: meeting
discovery/evidence is FOUR parallel stacks (poller, listing SQL, browser
dialog, series sweep) with ~15 inline predicates and 12 concrete
disagreements (D1–D12), catalogued in `docs/meeting-evidence-consolidation.md`.
Then shipped, in order:

- **c9ba3ae — 401 self-heal** (folded in from the same-day token session):
  `lib/auth-refresh.ts` fetch guard (single-flight kenoby refresh + replay)
  + `proxy.ts` JWT-exp pre-check for document navs (returnTo from
  `x-forwarded-host`, NOT request.url = localhost behind nginx). Proven in a
  real browser: expired JWT → refresh → back on page, zero 401s. Global
  cookbook written: `~/.claude/playbooks/trames-sso-401-self-heal.md`.
- **7fe05dd — sync visibility**: "Cal synced Nm ago · Sync" chip from
  `last_poll_at`; `POST /api/calendar/sync` runs a real caller sweep (E2E
  21.5s); misleading "Meet not synced" header nudge (manual checkpoint,
  4 users ever) removed.
- **b595cb5 — evidence consolidation Phase 1**: `lib/meeting-evidence.ts` is
  THE classifier (attachments/recordings/transcripts/verdict + the single
  ±12h window); migration 026 evidence states on both caches; poller counts
  Gemini-notes Docs + attached videos as evidence (D1), generating artifacts
  get state rows (D2); one `evidencePresent()` predicate, WHERE==SELECT (D3),
  file-less recordings stop badging (D4, 20/138 prod rows), checkFailed ≠
  "nothing to import" (D5), shared attachment regexes (D7), eventId anti-join
  (D9), server-consistent pending (D11), series 24h aging.

10-agent adversarial workflow caught 3 real bugs pre-release (Teams backfill
zeroed → repaired live on prod; dialog ignored meta.videoFileId;
attachment video outside the classifier) — all fixed. E2E: darth-cli bearer
for the API (human SSO jar was dead mid-session; Alok refreshed it later),
forged-JWT curls, Playwright with real refresh token; final screenshot shows
Not imported 63→79 (Gemini meetings now counted), Gemini-notes badges, amber
unparseable warnings.

**Next session pickup points:**
1. **Phase 2**: one server-side discovery service (calendar window sync +
   evidence probe, ALWAYS writes back to caches); thin gmeet-import-dialog's
   ~600 lines of browser Google calls into server routes (old path behind a
   flag for one deploy). Then **Phase 3**: single already-imported lookup.
2. Deferred disagreements: D6 (record-lookup windows), D8 (series ×
   transcript_parseable — `empty_transcript_docs` covers part), D10 (norec
   canImport → doomed click), D12 (6h series skeleton staleness), and the
   "Recording ×N" chip showing listed-count not ready-count.
3. Everything is committed (c9ba3ae, 7fe05dd, b595cb5, a736c24) and deployed;
   migration 026 + Teams repair applied on prod. No loose ends in the tree.
4. Full plan + status banner: `docs/meeting-evidence-consolidation.md`.

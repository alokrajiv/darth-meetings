# Rollout runbook — first-class recordings + "AssemblyAI keeps nothing" (September 2026)

Everything below is committed on `main` and **nothing is deployed**. With every new flag unset the app behaves as
it does today, so the deploy itself is safe at any point; each later step is its own switch with its own rollback.
Steps marked **ALOK** need your hands (deploys, migrations on the VM, prod writes, Azure). Keep this file current:
tick a step with the date when it is done.

Flags live in `~/apps/meeting-whisperer/.env.local` on the VM; every one is read lazily, so changing it means
`pm2 restart meeting-whisperer` — check `pgrep -f claude-agent-sd[k]` first, a restart kills in-flight AI runs.

| Flag | What it switches on |
|---|---|
| `MW_AAI_DELETE_ON_COMPLETE` | delete the job at AssemblyAI as soon as our copy is verified |
| `MW_RECORDINGS_WRITE` | every media/transcription write also maintains the recordings tables |
| `MW_RECORDINGS` | readers go through the recordings resolver |
| `MW_MINTED_IDS` | new meetings keep their own uuid instead of taking the AssemblyAI job id |
| `MW_TRANSCRIPTION_VERSIONS` | "Transcribe again" adds a version to the same meeting |
| `DARTH_MEDIA_ACCOUNT` / `DARTH_MEDIA_CONTAINER` / `MW_MEDIA_ARCHIVE` | copy every media file to the permanent blob account |

## A. Deploy + AssemblyAI keeps nothing  (no migration needed)

- [ ] **ALOK** `./deploy.sh`. Ships: payload stored in the same write as `completed`, no read-backs to AssemblyAI for
      finished rows, a 404 is final, jobs stuck > 6 h give up with a Retry (19 trashed rows flip on the first sweep),
      the dead "import from AssemblyAI" feature removed, and all the flag-gated code below (inert).
- [ ] Me: watch one fresh upload reach `completed` with its payload stored (`imported_content` not null at the
      moment of completion) and the pm2 log clean of `[aai-retention] payload missing`.
- [ ] **ALOK** set `MW_AAI_DELETE_ON_COMPLETE=1`, restart.
- [ ] **ALOK** on the VM: `bun run scripts/aai-purge.ts` (dry run: expect ~428 ready, 35 no-media skipped — never
      pass `--include-no-media`, those jobs are not in our account), then `--apply`.
- [ ] **ALOK** shorten retention in the AssemblyAI dashboard to 24 h.

## B. Recordings tables (Phase 1)

- [ ] **ALOK** apply `migrations/044_recordings.sql` and `migrations/045_aai_job_id.sql` (both additive; 045 stamps
      `aai_job_id` on the ~502 UUID-id rows).
- [ ] **ALOK** set `MW_RECORDINGS_WRITE=1`, restart — BEFORE the backfill, so nothing written in between is missed.
- [ ] **ALOK** `SCHEMA_PREFIX=prod bun run scripts/recordings-backfill.ts` (dry run), then
      `--apply --i-know-this-is-prod --check-files ~/apps/meeting-whisperer/storage`.
- [ ] `SCHEMA_PREFIX=prod bun run scripts/recordings-verify.ts --check-files …` → **0 findings** (read-only; I can run it).
- [ ] **ALOK** set `MW_RECORDINGS=1`, restart. Soak one week; verifier daily. Canaries: offline pins must not
      re-download (the plan `rev` is unchanged by design) and darth-cli.
- Rollback: unset the flag(s), restart. If `MW_RECORDINGS_WRITE` was ever off and on again, run the verifier.

## C. Ids we mint (Phase 1b) — after B has soaked a few days

- [ ] **ALOK** set `MW_MINTED_IDS=1`, restart. New uploads keep their placeholder's uuid; `/m/` links and
      darth-cli are unaffected (surveyed). Rollback: unset; rows minted meanwhile keep their ids.

## D. Media archive to Azure Blob (DEC-3 stage A)

- [ ] **ALOK** create the media account — NOT in `darthuploads`, whose `expire-uploads` rule deletes every blob in
      every container a day after its last write. Settings in `docs/recordings-blob-spec.md` ("Stage A as built"):
      `darthmedia`, `prod-internal-rg`, southeastasia, Standard_LRS, no shared keys, no public blob access, NO
      lifecycle policy, blob soft-delete 14 d, container `meetings-media`, role Storage Blob Data Contributor for
      the VM `darth-p01`'s system-assigned identity.
- [ ] **ALOK** apply `migrations/047_media_archive.sql`; set `DARTH_MEDIA_ACCOUNT=darthmedia`,
      `DARTH_MEDIA_CONTAINER=meetings-media`, restart; `scripts/media-archive-status.ts` says `0 archived / N pending`.
- [ ] **ALOK** set `MW_MEDIA_ARCHIVE=1`, restart. ~80 GB backfills at ≤ 2 GB per 5-minute tick, pausing while
      uploads or AI runs are active. Local files are never deleted by this stage.
- [ ] `scripts/media-archive-status.ts --check-blobs` clean; after 36 h the canary says `CANARY OK`.

## E. Transcription versions (Phase 2) — committed 2332967

- [ ] **ALOK** apply `migrations/046_transcription_versions.sql`; set `MW_TRANSCRIPTION_VERSIONS=1`, restart (needs B's
      `MW_RECORDINGS_WRITE` and a backfilled graph — a meeting with no clip falls back to the old new-row flow).
      Rollback: unset; stored versions stay readable and are never deleted by the sync.
- [ ] First real use: re-run one of the five Indonesian-detected meetings with Language = English; check the old
      version is still there under Versions with its edits and names.

## Order and dependencies

A is independent and can go today. B needs only its two migrations. C, D(archive) and E all need B's
`MW_RECORDINGS_WRITE`. Nothing here needs a darth-cli release.

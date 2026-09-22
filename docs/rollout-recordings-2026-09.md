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
| `MW_SAME_FILE_CHECK` | an upload whose bytes the same owner already has is answered before anything is spent |
| `MW_CLIPS` | split a window of a recording off into its own meeting (no re-transcription, no file cut) |
| `MW_MEDIA_FROM_BLOB` | /audio answers browsers with a 60-minute signed blob link instead of streaming through the VM |
| `MW_COMBINE` | several recordings in one meeting (clips on different recordings, the align guesser) |
| `DARTH_MEDIA_ACCOUNT` / `DARTH_MEDIA_CONTAINER` / `MW_MEDIA_ARCHIVE` | copy every media file to the permanent blob account |
| `MW_AAI_FROM_BLOB` | AssemblyAI reads the recording from the blob; the VM stops pushing it there (Stage C) |
| `MW_SCRATCH_DIR` | the stitch of a multi-file upload works on the NVMe (`/temphigh/mw-scratch`) instead of the root disk |

## A. Deploy + AssemblyAI keeps nothing  (no migration needed)

- [x] **ALOK** `./deploy.sh`. Ships: payload stored in the same write as `completed`, no read-backs to AssemblyAI for
      finished rows, a 404 is final, jobs stuck > 6 h give up with a Retry (19 trashed rows flip on the first sweep),
      the dead "import from AssemblyAI" feature removed, and all the flag-gated code below (inert).
      **Done 2026-09-22 12:53 SGT** (main `1da8701`, VM quiet: 0 agent processes, 0 uploads). First sweep flipped
      exactly the 19 trashed rows (`[aai-giveup]` ×19). The one new error-log line, `[aai-job-id] column missing`,
      is the expected notice until B applies 045.
- [x] Me: watch one fresh upload reach `completed` with its payload stored (`imported_content` not null at the
      moment of completion) and the pm2 log clean of `[aai-retention] payload missing`.
      **Done 2026-09-22 12:56 SGT**: darth-cli `upload --scratch` of a 9 s clip → row 927 (`806d9dcf…`) completed
      with the full AssemblyAI payload stored (7,974 chars); zero `payload missing` lines.
- [ ] **ALOK** set `MW_AAI_DELETE_ON_COMPLETE=1`, restart.
- [ ] **ALOK** on the VM: `bun run scripts/aai-purge.ts` (dry run: expect **443 ready, 34 no-media skipped, 0
      incomplete** — never pass `--include-no-media`, those jobs are not in our account), then `--apply`.
      The 2026-09-22 dry run first showed 10 "payload incomplete": all silent recordings (9 trashed test uploads +
      one 12 s "Integration Cadence") whose stored copy is the finished response with `words: []` and
      `utterances: null` — that is how AssemblyAI answers no speech. The script now treats that as complete; the
      patched copy is on the VM already (sha `57381f6f…`).
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

## F. Same-file check (Phase 2c) — committed 2ceb786

- Upload hashes start being STORED as soon as B's `MW_RECORDINGS_WRITE` is on (no extra flag) — so the check has
  history on the day it is switched on. Videos uploaded before that cannot be back-hashed (the stored file is the
  faststart-remuxed copy, not the bytes the user had).
- [ ] **ALOK** set `MW_SAME_FILE_CHECK=1`, restart. Only `dupAware` clients are ever answered: the web dialog (when
      its UI lands), tray ≥ 0.3.11.
- [ ] **ALOK** tray 0.3.11: `cd poc/mac-recorder && ./make-app.sh --release && ./dist-scripts/deploy-to-dot6.sh`.
- darth-cli needs a four-line change before it may send `dupAware` (exact lines in
  `docs/recordings-same-file-spec.md` §8 of the as-built notes) — for the CLI agent; until then it behaves as today.

## G. Clips (Phase 3a) — server committed bb6f34b, UI in progress

- [ ] **ALOK** set `MW_CLIPS=1`, restart (needs B, C and E on). First real use: split the kerner podcast row into the
      podcast and the 1:1 with "Split off a part…", check both play only their window and the source's notes still
      cite the right moments.
- darth-cli verbs `clips` / `propose-clips` / `split` / `unsplit` are specified in
  `docs/recordings-phase3-clips-spec.md` ("darth-cli verb spec") — for the CLI agent.

## H. Playback from blob (DEC-3 stage B) — committed 174214d

- [ ] After D has archived the media: set `MW_MEDIA_FROM_BLOB=1`, restart; play a meeting on a phone and a laptop,
      seek, and check Safari (the one browser no fake could prove — the player falls back to the app path by itself).

## I. AssemblyAI reads the blob (DEC-3 stage C)

- [ ] Needs B (`MW_RECORDINGS_WRITE` + `MW_MINTED_IDS`) and D (the media account, `MW_MEDIA_ARCHIVE`, canary OK).
- [ ] **ALOK** set `MW_AAI_FROM_BLOB=1`, restart. Then upload a short recording **from the web dialog** and follow
      the eight live-proof steps in `docs/recordings-blob-spec.md` ("Stage C as built"): the pm2 log must show a
      server-side copy and no AssemblyAI upload for that row, `blobFirst.landedAt` must appear within a couple of
      minutes, and `grep -c 'sig='` must stay 0.
- The Darth Recorder tray deliberately keeps the pull path (a tray file may be multi-track — DEC-1); so does every
  multi-file group. Nothing to switch off for them.
- [ ] Optional, independent: **ALOK** `mkdir -p /temphigh/mw-scratch`, set `MW_SCRATCH_DIR=/temphigh/mw-scratch`,
      restart — the stitch of a multi-file upload then works on the NVMe. Unset = today's behaviour exactly.

## J. Several recordings, one meeting (Phase 3b) — server b540e8a, UI in progress

- [ ] **ALOK** deploy `voiceprint/server.py` to the VM's sidecar dir and `pm2 restart mw-voiceprint` (the /align
      endpoint; numpy only, nothing to install). Check nginx/pm2 timeouts: aligning two multi-hour recordings takes
      minutes (route `maxDuration` 800 s).
- [ ] **ALOK** set `MW_COMBINE=1`, restart (needs G on). Acceptance: rebuild the SI-BL day (row 548's three
      recordings) with Add a recording… + Guess instead of the hand merge, compare the text.

## K. Tray 0.3.12 (mix as track 0) — d7842cd

- [ ] **ALOK** `cd poc/mac-recorder && ./make-app.sh --release && ./dist-scripts/deploy-to-dot6.sh` (also carries
      0.3.11's same-file check). After the first real recording on 0.3.12: `ffprobe` its file — audio stream 0 must be
      the stereo `qmx` mix — and check the transcript word count is sane (the 2026-09-16 failure mode is 1/3 of the
      words). Only then set `MW_AAI_FROM_BLOB=1` (section I).

## Order and dependencies

A is independent and can go today. B needs only its two migrations. C, D(archive) and E all need B's
`MW_RECORDINGS_WRITE`; I needs B + D. Nothing here needs a darth-cli release.

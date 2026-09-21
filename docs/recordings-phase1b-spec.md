# First-class recordings — Phase 1b: ids we mint

Status: **build brief**, 2026-09-22, against main `c6698b6`. Implements the identity half of DEC-4
(`docs/recordings-first-class-design.md` §7): the AssemblyAI id stops being the identity of anything.

## The change in one paragraph

Today an upload is born `up-<uuid>` and, at submit, `promoteUploadingRow` renames the meeting to the AssemblyAI job
id; the media file is renamed to `<job id>.<ext>`; every poller/retention check asks "is `assemblyai_id` UUID-shaped?"
to mean "this is an AssemblyAI job". After 1b: a new column **`transcripts.aai_job_id`** holds the job id, the
meeting's public id becomes **the bare uuid of its placeholder** (`up-1234…` → `1234…`), and nothing derives meaning
from the shape of `assemblyai_id` except "which of OUR prefixes is it".

Why a bare uuid and not a new prefix: ~27 files (listing glyphs, sources card, series dialog, darth-cli's
uuid-or-prefix resolution) treat "no known prefix" as "an ordinary transcribed upload". A bare uuid keeps every one
of them correct with zero edits; a new prefix would need all of them audited and the CLI re-released.

## Migration `045_aai_job_id.sql` (additive; 044 conventions)

```sql
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS aai_job_id text;
UPDATE transcripts SET aai_job_id = assemblyai_id
 WHERE aai_job_id IS NULL AND assemblyai_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
CREATE INDEX IF NOT EXISTS transcripts_aai_job_id_idx ON transcripts (aai_job_id) WHERE aai_job_id IS NOT NULL;
```
Not unique: the one legacy two-owner job (f4a32ca1…) has two rows.

## Code

1. **One accessor**, pure, in `src/lib/aai-job-state.ts`: `aaiJobIdOf(row)` = `row.aai_job_id` if set, else
   `row.assemblyai_id` when UUID-shaped **and the row predates 1b** (i.e. `aai_job_id` is null/undefined — covers a
   server running before 045 is applied and any row the migration's UPDATE missed), else null. Every current use of
   `isAaiJobId(row.assemblyai_id)` / "UUID-shaped ⇒ AssemblyAI job" moves to it: `aai-retention.ts` (delete, stamp,
   `listAaiDeletePending`), `transcript-sync.ts`, the listing poller in `api/transcripts/route.ts`,
   `listPendingVisibleToUser` / `listStuckAtAai` (SQL: `COALESCE(aai_job_id, <uuid-shaped assemblyai_id>)`),
   `aai-giveup.ts`, `auto-notes-sweeper.ts`, permanent delete (`aaiDelete(id)` → the job id), `scripts/aai-purge.ts`,
   `retry-ingest`, retranscribe. `getTranscript(...)`, `deleteTranscript(...)` are only ever called with a job id.
   `stampAaiDeleted` matches on `aai_job_id`.
2. **Writers always record the job id** (`promoteUploadingRow`, `createForUser`, any INSERT of a submitted row) —
   flag or no flag — once the column exists.
3. **Flag `MW_MINTED_IDS`** (lazy-read; unset = today's ids): when on, `promoteUploadingRow` sets
   `assemblyai_id = <placeholder uuid without 'up-'>` and `aai_job_id = <job id>`; the media file is named after the
   NEW meeting id (`audioFilename(newId, …)`), not the job id; `repointMeeting` gets `(placeholderId → newId)` exactly as
   today so `/m/` links and `former_ids` self-heal are unchanged. `defer-` placeholders that turn into uploads follow the
   same rule. Rows that never go to AssemblyAI (`gmeet-`, `teams-`, `ext-`) are untouched.
4. **Column-missing safety.** If 045 has not been applied, an UPDATE naming `aai_job_id` would break every upload. On
   first use, check `information_schema.columns` once per process (cached promise); when the column is missing: skip
   the `aai_job_id` writes, force `MW_MINTED_IDS` off, log `[aai-job-id] column missing — apply migrations/045` once.
5. **Recording graph** (`src/lib/recording-graph.ts`): `canonicalKeyOf` = the job id **only when
   `aai_job_id = assemblyai_id`** (legacy rows — keeps every id the Phase 1 backfill will mint, and keeps the
   two-owner collapse); otherwise `t<transcripts.id>`. `provider_job_id` comes from `aaiJobIdOf`. Re-run the
   writers' integration check and add the minted-id promotion case (one recording, no orphan, second sync no-op).
6. **Two-owner lookups** keyed on a shared AssemblyAI id (`transcript-access.ts`, `offline-plan.ts` and friends) keep
   working for the legacy pair because those rows keep `assemblyai_id = job id`. New rows can never share a job. Say
   in a comment that this path is legacy-only.
7. **darth-cli**: read-only look at `~/crp-workspace/darth/cli` for anything that treats a meeting id as "the
   AssemblyAI id" (name, help text, a call to AssemblyAI). Report; do not edit that repo.
8. Naming: do NOT rename the `assemblyai_id` column or the `assemblyaiId` variables (D-H stays: it is an opaque
   document id). Add one paragraph to the header of `src/db-ops/transcripts.ts` and to `StoredTranscript` in
   `src/lib/format.ts` saying what the two columns mean from now on.

## Verification

- Unit: `aaiJobIdOf` truth table; SQL twins return the same set as the JS predicate on the scratch DB.
- Scratch Postgres (recipe: `tmp/recordings-diff/README.md`; own port, own dir, stop and delete afterwards): apply
  044 + 045, seed rows, then drive `ingestLocalAudio` with AssemblyAI stubbed (the diff harness shows how to
  `mock.module('@/lib/server/assemblyai')`) with the flag OFF and ON: placeholder → promoted id, `aai_job_id`, file on
  disk, `/m/` repoint + `former_ids`, completion poll (polls the JOB id), DEC-4 delete (called with the JOB id, stamp
  lands), give-up after 6 h, retry-ingest → a second job id on the SAME meeting id, permanent delete, recording graph.
- Flag off must be behaviour-identical to today except that `aai_job_id` gets written.
- `bun test`, `bunx tsc --noEmit`, `bunx eslint` on touched files, `bun run build` with no env.

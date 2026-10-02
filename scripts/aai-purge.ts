/**
 * DEC-4 backlog purge (docs/recordings-first-class-design.md §7): delete the
 * AssemblyAI jobs behind transcripts we already hold in full, so AssemblyAI
 * stops holding a second copy of our meetings.
 *
 * DRY RUN BY DEFAULT — prints exactly what it would do and touches nothing.
 * `--apply` is the only thing that deletes at AAI and writes the
 * `gmeet_context.aai` stamp.
 *
 * Run on the VM (needs .env.local for DATABASE_URL + ASSEMBLYAI_API_KEY):
 *   cd ~/apps/meeting-whisperer
 *   bun run scripts/aai-purge.ts                 # dry run, prints the plan
 *   bun run scripts/aai-purge.ts --apply         # actually delete
 *
 * Flags:
 *   --apply             perform the deletes and the stamps
 *   --include-no-media  also purge rows whose recording is NOT on our disk
 *                       (the 35 legacy "import from AssemblyAI" rows — text
 *                       only, nothing to re-transcribe from ever again)
 *   --limit <n>         cap the number of jobs considered (default: all)
 *
 * A job is only ever purged when our copy is provably complete: the stored
 * payload says `status: completed`, its `words` array is present, and its
 * `utterances` array is present unless `words` is empty (AssemblyAI answers
 * `utterances: null` for a recording in which it heard no speech — that copy
 * is complete, there is nothing more to fetch), and (unless
 * --include-no-media) the media on disk. One
 * AAI job can back several rows — `UNIQUE (user_id, assemblyai_id)` — so the
 * delete happens once per job and every copy gets stamped.
 *
 * Standalone on purpose: the app's server libs are `server-only` and can't be
 * imported from a plain bun script. Idempotent — an already-stamped row is
 * skipped, and AAI answers 404 for a job that is already gone.
 */
import postgres from 'postgres';
import { AssemblyAI } from 'assemblyai';

const SCHEMA = `meeting_whisperer_${process.env.SCHEMA_PREFIX || 'prod'}`;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_NO_MEDIA = args.includes('--include-no-media');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number.parseInt(args[limitArg + 1] ?? '', 10) : NaN;

/** AAI job ids are bare UUIDs. Only used for the pre-1b fallback below — a
 * MEETING id is UUID-shaped too since Phase 1b, so what makes a row an
 * AssemblyAI job is `aai_job_id` (migration 045), not the shape of its id. */
const AAI_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Candidate {
  user_id: string;
  assemblyai_id: string;
  /** The AssemblyAI job — what is deleted, and what the copies are grouped
   * by. Equal to `assemblyai_id` for every row born before Phase 1b. */
  aai_job_id: string | null;
  status: string;
  /** `imported_content.status` — 'completed' when the stored copy is the
   * finished AssemblyAI response, anything else when it is a stub. */
  payload_status: string | null;
  title: string | null;
  completed_at: string | null;
  utterances: number | null;
  words: number | null;
  has_media: boolean;
  stamped: boolean;
  trashed: boolean;
}

const sql = postgres({ onnotice: () => {} });

/** Largest stored count across the copies; null when NO copy stores the array. */
function maxOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null && v !== undefined);
  return present.length > 0 ? Math.max(...present) : null;
}

function fmt(c: Candidate): string {
  const when = c.completed_at ? String(c.completed_at).slice(0, 10) : '????-??-??';
  const name = (c.title ?? '(untitled)').slice(0, 44);
  return `${c.aai_job_id}  ${when}  u=${c.utterances ?? '-'} w=${c.words ?? '-'}  ${
    c.has_media ? 'media' : 'NO-MEDIA'
  }${c.trashed ? ' trashed' : ''}  ${name}`;
}

async function main(): Promise<void> {
  // Tolerate a schema where migration 045 has not been applied: the job is
  // then the meeting id, which is exactly what every pre-1b row looks like.
  const hasJobIdColumn =
    (
      await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${SCHEMA} AND table_name = 'transcripts'
          AND column_name = 'aai_job_id'
      `
    ).length > 0;
  const legacyJobId = sql`CASE WHEN assemblyai_id ~* ${AAI_JOB_ID_RE.source} THEN assemblyai_id END`;
  // Column present ⇒ it is the whole answer (045 stamped every legacy row): a
  // NULL beside a UUID-shaped meeting id is a minted id AssemblyAI has never
  // heard of (src/db-ops/aai-job-id.ts).
  const jobIdExpr = hasJobIdColumn ? sql`aai_job_id` : legacyJobId;

  const rows = await sql<Candidate[]>`
    SELECT user_id, assemblyai_id, ${jobIdExpr} AS aai_job_id, status, title,
           imported_content->>'status' AS payload_status,
           completed_at::text AS completed_at,
           jsonb_array_length(
             CASE WHEN jsonb_typeof(imported_content->'utterances') = 'array'
                  THEN imported_content->'utterances' END
           ) AS utterances,
           jsonb_array_length(
             CASE WHEN jsonb_typeof(imported_content->'words') = 'array'
                  THEN imported_content->'words' END
           ) AS words,
           (local_audio_path IS NOT NULL) AS has_media,
           (COALESCE(gmeet_context, '{}'::jsonb) ? 'aai') AS stamped,
           (deleted_at IS NOT NULL) AS trashed
    FROM ${sql(SCHEMA)}.transcripts
    WHERE status = 'completed'
    ORDER BY completed_at NULLS LAST
  `;

  // Group by job: two owners can hold the same AAI id, and the delete is
  // per job, not per row.
  const jobs = new Map<string, Candidate[]>();
  for (const r of rows) {
    if (!r.aai_job_id) continue;
    const list = jobs.get(r.aai_job_id);
    if (list) list.push(r);
    else jobs.set(r.aai_job_id, [r]);
  }

  const ready: Candidate[] = [];
  const noMedia: Candidate[] = [];
  const unsafe: Candidate[] = [];
  const done: Candidate[] = [];

  for (const [, copies] of jobs) {
    // The job is judged on the best copy we hold: any owner having the media
    // means the bytes exist on our disk.
    const head = copies.find((c) => c.has_media) ?? copies[0]!;
    const merged: Candidate = {
      ...head,
      has_media: copies.some((c) => c.has_media),
      stamped: copies.every((c) => c.stamped),
      payload_status: copies.some((c) => c.payload_status === 'completed') ? 'completed' : head.payload_status,
      utterances: maxOrNull(copies.map((c) => c.utterances)),
      words: maxOrNull(copies.map((c) => c.words)),
    };
    // null = the array is not stored at all (payload missing or truncated);
    // 0 = stored and empty. A silent recording comes back from AssemblyAI as
    // `words: []` + `utterances: null` — complete, nothing left to fetch.
    const complete =
      merged.payload_status === 'completed' &&
      merged.words !== null &&
      (merged.utterances !== null || merged.words === 0);
    if (merged.stamped) done.push(merged);
    else if (!complete) unsafe.push(merged);
    else if (!merged.has_media) noMedia.push(merged);
    else ready.push(merged);
  }

  const purge = INCLUDE_NO_MEDIA ? [...ready, ...noMedia] : ready;
  const capped = Number.isFinite(LIMIT) && LIMIT > 0 ? purge.slice(0, LIMIT) : purge;

  console.log(`schema ${SCHEMA} — ${jobs.size} AssemblyAI job(s) behind completed rows`);
  console.log(`  already deleted at AAI (stamped): ${done.length}`);
  console.log(`  payload incomplete, NEVER purged:  ${unsafe.length}`);
  console.log(`  no local media:                    ${noMedia.length}${
    INCLUDE_NO_MEDIA ? ' (included: --include-no-media)' : ' (skipped)'
  }`);
  console.log(`  ready to purge:                    ${ready.length}`);
  console.log(`  → this run would act on:           ${capped.length}`);
  console.log('');

  if (unsafe.length > 0) {
    console.log('-- payload incomplete (fix these before AAI retention drops) --');
    for (const c of unsafe) console.log(`  ${fmt(c)}`);
    console.log('');
  }
  if (noMedia.length > 0) {
    console.log('-- completed, payload safe, but no recording on our disk --');
    for (const c of noMedia) console.log(`  ${fmt(c)}`);
    console.log('');
  }

  console.log(`-- ${APPLY ? 'PURGING' : 'would purge'} --`);
  for (const c of capped) console.log(`  ${fmt(c)}`);

  if (!APPLY) {
    console.log('');
    console.log('Dry run. Nothing was deleted at AssemblyAI and nothing was written.');
    console.log('Re-run with --apply to act.');
    await sql.end();
    return;
  }

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    console.error('ASSEMBLYAI_API_KEY is not set — cannot delete. Aborting.');
    await sql.end();
    process.exit(1);
  }
  const client = new AssemblyAI({ apiKey });

  let deleted = 0;
  let failed = 0;
  for (const c of capped) {
    const jobId = c.aai_job_id!;
    let gone = false;
    try {
      await client.transcripts.delete(jobId);
      gone = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\b404\b|not found/i.test(message)) {
        gone = true;
      } else {
        failed += 1;
        console.warn(`  FAILED ${jobId}: ${message}`);
      }
    }
    if (!gone) continue;
    const stamp = { deletedAt: new Date().toISOString(), jobId };
    // Keyed on the JOB: every meeting that ran on it gets the stamp, however
    // it is called.
    const stamped = await sql`
      UPDATE ${sql(SCHEMA)}.transcripts
      SET gmeet_context = COALESCE(gmeet_context, '{}'::jsonb)
        || jsonb_build_object('aai', ${sql.json(stamp as never)}::jsonb)
      WHERE ${jobIdExpr} = ${jobId}
      RETURNING user_id
    `;
    deleted += 1;
    console.log(`  deleted ${jobId} (${stamped.length} row(s) stamped)`);
  }

  console.log('');
  console.log(`Done: ${deleted} job(s) deleted at AssemblyAI, ${failed} failure(s).`);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

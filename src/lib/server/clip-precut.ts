import 'server-only';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { clipMirrorNeedsCut, cutPlanOf, type CutVariant } from '@/lib/clip-cut';
import { clipCutRoot, ensureClipCut, findClipCut, type ClipCutRequest } from '@/lib/server/clip-cut';
import { resolveMeetingMedia, type MediaOnlyRow, type ResolvedMedia } from '@/lib/server/recordings';
import { isDraining } from '@/lib/server/deploy-drain';
import type { GmeetContext } from '@/lib/format';

/**
 * Cutting a meeting's media AHEAD of the first view (2026-10-02 M2).
 *
 * The meeting media routes serve a windowed (or holed) file as a cut made by
 * lib/server/clip-cut.ts. Made lazily, the first person to press play on a
 * long meeting that needs a re-encode waited — and past the route's 240 s,
 * got a 503. So the cut is started where it becomes necessary:
 *
 *   - `queueClipPrecut(meeting, trigger)` — fire-and-forget, called wherever
 *     a meeting's clips are written: split (both halves), un-split, combine
 *     add / patch / delete / rollback, a meeting made or linked from a
 *     recording, and the settle of a meeting made before its recording was
 *     transcribed. A meeting whose clips need no cut costs one row read.
 *   - `precutBackstopPass()` — run by the media sweeper's tick (so it skips
 *     while this colour is draining for a deploy, lib/server/deploy-drain.ts):
 *     any meeting whose clip mirror has a window or a hole and whose cut is not
 *     on disk is queued, a few per tick. That covers meetings split before this
 *     existed, a hook that died with the process, and a VM that lost its cache.
 *
 * Every cut goes through `ensureClipCut`, so it shares the process-wide lock
 * with the routes (a request and a pre-cut of the same output join ONE ffmpeg)
 * and logs the same `[clip-cut] … via=<trigger>` line. The queue runs ONE
 * meeting at a time, so a burst of splits never starts a burst of re-encodes;
 * the route's own wait stays as the fallback for whatever the queue has not
 * reached yet.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
/** Writes land in several statements (mirror, clip rows, materialise): let them settle. */
const PRECUT_DELAY_MS = 2_000;
/** The backstop queues at most this many meetings per sweeper tick… */
const BACKSTOP_QUEUE_PER_TICK = 2;
/** …and resolves the media of at most this many candidates to find them. */
const BACKSTOP_CHECKS_PER_TICK = 25;
const BACKSTOP_SCAN = 200;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
/** A `.tmp` under clips/ older than this was left by a crashed ffmpeg. */
const STALE_TMP_MS = 2 * 60 * 60 * 1000;

interface PrecutState {
  /** meeting id → trigger, in arrival order. */
  queue: Map<string, string>;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** meeting id → the mirror key whose cuts were confirmed on disk. */
  verified: Map<string, string>;
  /** meeting id → failed pre-cuts (the backstop backs off; a write retries). */
  failures: Map<string, { n: number; at: number }>;
}

// globalThis: the clip writers run in route graphs, the sweeper in the
// instrumentation graph — one queue for all of them (same reason as clip-cut).
const g = globalThis as unknown as { __mwClipPrecut?: PrecutState };
const state = (g.__mwClipPrecut ??= {
  queue: new Map(),
  running: false,
  timer: null,
  verified: new Map(),
  failures: new Map(),
});

/** The row columns a pre-cut needs — everything `resolveMeetingMedia` reads. */
interface PrecutRow {
  id: number;
  assemblyai_id: string;
  status: string;
  duration: number | null;
  local_audio_path: string | null;
  clips: unknown;
  video_parts: GmeetContext['videoParts'] | null;
}

function mediaRowOf(row: PrecutRow): MediaOnlyRow {
  return {
    id: row.id,
    duration: row.duration,
    local_audio_path: row.local_audio_path,
    gmeet_context: {
      ...(row.clips != null ? { clips: row.clips } : {}),
      ...(Array.isArray(row.video_parts) ? { videoParts: row.video_parts } : {}),
    } as GmeetContext,
  };
}

/** What makes a meeting's cuts what they are: its clip mirror and its file. */
function mirrorKey(row: Pick<PrecutRow, 'clips' | 'local_audio_path'>): string {
  return createHash('md5')
    .update(JSON.stringify([row.clips ?? null, row.local_audio_path]))
    .digest('hex');
}

/**
 * Every cut a meeting's media routes can be asked for: for each file it holds
 * only part of, the soundtrack (what the player streams with its video toggle
 * off — and cheap) and then the full rendition. For an audio-only file the two
 * are one cut (`ensureClipCut` names both the `av` stem), so the second is a
 * cache hit.
 */
export function cutRequestsFor(meetingId: string, media: ResolvedMedia[], trigger: string): ClipCutRequest[] {
  const out: ClipCutRequest[] = [];
  for (const m of media) {
    const segments = cutPlanOf(m);
    if (!segments) continue;
    for (const variant of ['audio', 'av'] as CutVariant[]) {
      out.push({
        meetingId,
        sourceFilename: m.filename,
        segments,
        variant,
        part: m.part,
        sourceDurationMs: m.durationMs,
        media: m,
        trigger,
      });
    }
  }
  return out;
}

/**
 * Queue the cuts of one meeting. Fire-and-forget: never throws, never awaited.
 * A meeting already queued is not queued twice; one queued while its pre-cut
 * runs is run again afterwards (its clips may have changed under it).
 */
export function queueClipPrecut(assemblyaiId: string, trigger: string, opts: { delayMs?: number } = {}): void {
  if (!/^[A-Za-z0-9_-]+$/.test(assemblyaiId)) return;
  if (!state.queue.has(assemblyaiId)) state.queue.set(assemblyaiId, trigger);
  schedule(opts.delayMs ?? PRECUT_DELAY_MS);
}

function schedule(delayMs: number): void {
  if (state.running || state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void drainQueue();
  }, delayMs);
  state.timer.unref?.();
}

async function drainQueue(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    for (;;) {
      const next = state.queue.entries().next();
      if (next.done) break;
      const [id, trigger] = next.value;
      state.queue.delete(id);
      // A backstop item in a colour that is now draining is left to the colour
      // that takes over (its own sweeper finds it); a write's pre-cut runs —
      // it was asked for by a request this colour served.
      if (trigger === 'sweeper' && isDraining()) continue;
      try {
        await precutMeeting(id, trigger);
      } catch (err) {
        console.warn(`[clip-cut] pre-cut ${id} via=${trigger} failed:`, err);
        noteFailure(id);
      }
    }
  } finally {
    state.running = false;
  }
}

function noteFailure(id: string): void {
  const prev = state.failures.get(id);
  state.failures.set(id, { n: (prev?.n ?? 0) + 1, at: Date.now() });
}

async function loadRow(assemblyaiId: string): Promise<PrecutRow | null> {
  const rows = await sql<PrecutRow[]>`
    SELECT id, assemblyai_id, status, duration, local_audio_path,
           gmeet_context->'clips' AS clips,
           gmeet_context->'videoParts' AS video_parts
    FROM ${sql(SCHEMA)}.transcripts
    WHERE assemblyai_id = ${assemblyaiId} AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** The dependencies a pre-cut reads through — swapped in tests. */
export interface PrecutDeps {
  loadRow: (assemblyaiId: string) => Promise<PrecutRow | null>;
  resolveMedia: (row: MediaOnlyRow) => Promise<ResolvedMedia[]>;
}

const realDeps: PrecutDeps = { loadRow, resolveMedia: (row) => resolveMeetingMedia(row) };

/**
 * Make every cut one meeting's routes can be asked for, one after another.
 * 'skipped' = nothing to cut (whole recording, not completed, gone).
 */
export async function precutMeeting(
  assemblyaiId: string,
  trigger: string,
  deps: PrecutDeps = realDeps
): Promise<'done' | 'skipped' | 'failed'> {
  const row = await deps.loadRow(assemblyaiId);
  if (!row || row.status !== 'completed' || !row.local_audio_path) return 'skipped';
  const key = mirrorKey(row);
  if (!clipMirrorNeedsCut({ clips: row.clips })) {
    state.verified.set(assemblyaiId, key);
    return 'skipped';
  }
  const requests = cutRequestsFor(assemblyaiId, await deps.resolveMedia(mediaRowOf(row)), trigger);
  let failed = 0;
  for (const req of requests) {
    const r = await ensureClipCut(req);
    if (r.status !== 'ready') failed += 1;
  }
  if (failed > 0) {
    // The [clip-cut] FAILED line (or the archive's "missing") already says why.
    noteFailure(assemblyaiId);
    return 'failed';
  }
  state.verified.set(assemblyaiId, key);
  state.failures.delete(assemblyaiId);
  return requests.length > 0 ? 'done' : 'skipped';
}

/**
 * The media sweeper's pass: queue the meetings whose cuts should exist and do
 * not. Bounded — it resolves at most BACKSTOP_CHECKS_PER_TICK meetings and
 * queues at most BACKSTOP_QUEUE_PER_TICK — and it adds nothing while the
 * queue is still busy with earlier work. A meeting confirmed cut is not looked
 * at again until its clip mirror changes; one that keeps failing backs off
 * like the media preparation does. Returns how many were queued.
 */
export async function precutBackstopPass(): Promise<number> {
  await sweepStaleClipTemps().catch(() => {});
  if (isDraining()) return 0;
  if (state.running || state.queue.size > 0) return 0;

  const rows = await sql<PrecutRow[]>`
    SELECT id, assemblyai_id, status, duration, local_audio_path,
           gmeet_context->'clips' AS clips,
           gmeet_context->'videoParts' AS video_parts
    FROM ${sql(SCHEMA)}.transcripts
    WHERE deleted_at IS NULL
      AND status = 'completed'
      AND local_audio_path IS NOT NULL
      AND jsonb_typeof(gmeet_context->'clips') = 'array'
    ORDER BY created_at DESC
    LIMIT ${BACKSTOP_SCAN}
  `;

  let checks = 0;
  let queued = 0;
  for (const row of rows) {
    if (queued >= BACKSTOP_QUEUE_PER_TICK || checks >= BACKSTOP_CHECKS_PER_TICK) break;
    const key = mirrorKey(row);
    if (state.verified.get(row.assemblyai_id) === key) continue;
    if (!clipMirrorNeedsCut({ clips: row.clips })) {
      state.verified.set(row.assemblyai_id, key);
      continue;
    }
    const failed = state.failures.get(row.assemblyai_id);
    if (failed && (failed.n >= MAX_ATTEMPTS || Date.now() - failed.at < RETRY_AFTER_MS)) continue;

    checks += 1;
    const media = await resolveMeetingMedia(mediaRowOf(row)).catch(() => [] as ResolvedMedia[]);
    let missing = false;
    for (const req of cutRequestsFor(row.assemblyai_id, media, 'sweeper')) {
      if (!(await findClipCut(req))) {
        missing = true;
        break;
      }
    }
    if (!missing) {
      state.verified.set(row.assemblyai_id, key);
      continue;
    }
    queueClipPrecut(row.assemblyai_id, 'sweeper', { delayMs: 0 });
    queued += 1;
  }
  if (queued > 0) console.log(`[clip-cut] sweeper queued ${queued} pre-cut(s) (${checks} checked)`);
  return queued;
}

/** Temp files a crashed ffmpeg (or process) left under clips/. */
async function sweepStaleClipTemps(): Promise<void> {
  const root = clipCutRoot();
  const dirs = await fsp.readdir(root).catch(() => [] as string[]);
  const now = Date.now();
  for (const d of dirs) {
    const dir = path.join(root, d);
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue;
      const p = path.join(dir, name);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > STALE_TMP_MS) {
        await fsp.unlink(p).catch(() => {});
        console.log(`[clip-cut] removed stale temp ${d}/${name}`);
      }
    }
  }
}

/** Test hook: how many meetings are queued, and whether one is running. */
export function precutQueueState(): { queued: number; running: boolean } {
  return { queued: state.queue.size, running: state.running };
}

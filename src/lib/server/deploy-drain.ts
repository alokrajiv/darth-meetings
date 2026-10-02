import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Blue/green deploys (README "Deploy"): for a short while two copies of the
 * app run side by side against one DB and one storage dir. Both arm the
 * in-process pollers/sweepers of src/instrumentation.ts, and several of those
 * are NOT safe to run in two processes at once — their only dedupe is
 * in-process (media-sweeper's in-place faststart remux uses a fixed temp
 * name; deferred imports, recombines, notes/speaker-ID runs claim nothing in
 * the DB). So exactly one colour may run background passes at any time.
 *
 * The switch is a file in the colour's app dir: while `<cwd>/.mw-draining`
 * exists, every background timer callback (wrapped in `unlessDraining`) is
 * skipped and remembered. deploy.sh:
 *   1. touches it in the LIVE dir    → the live colour stops starting passes
 *                                      (it keeps serving requests);
 *   2. touches it in the NEW dir     → the new colour boots passive;
 *   3. starts + health-checks the new colour, flips nginx, waits for the old
 *      colour's AI runs, stops the old colour;
 *   4. removes it from the NEW dir   → within RESUME_CHECK_MS the new colour
 *      runs each skipped job once and its timers carry on as usual.
 * The file stays in the retired dir, so a colour that pm2 resurrects after a
 * VM reboot stays passive; the next deploy into that dir replaces it.
 *
 * pm2 starts each colour with cwd = its app dir, so cwd locates the file.
 * existsSync per tick is a single stat.
 */
export const DRAIN_FILE = '.mw-draining';
export const RESUME_CHECK_MS = 10_000;

export function drainFilePath(cwd: string = /*turbopackIgnore: true*/ process.cwd()): string {
  return path.join(/*turbopackIgnore: true*/ cwd, DRAIN_FILE);
}

export function isDraining(cwd?: string): boolean {
  try {
    return existsSync(drainFilePath(cwd));
  } catch {
    return false;
  }
}

type Job = () => Promise<unknown> | unknown;

/** Jobs skipped while draining, by label (one catch-up run per label). */
const owed = new Map<string, Job>();
let resumeTimer: ReturnType<typeof setInterval> | null = null;
let announced = false;

function runJob(label: string, job: Job): void {
  try {
    const r = job();
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      (r as Promise<unknown>).catch((err) => console.warn(`[deploy-drain] ${label} failed:`, err));
    }
  } catch (err) {
    console.warn(`[deploy-drain] ${label} failed:`, err);
  }
}

/**
 * If the drain file is gone: run every owed job once, stop watching, and
 * return how many ran. Called by the resume watcher; exported for tests.
 */
export function resumeIfUndrained(): number {
  if (isDraining()) return 0;
  if (resumeTimer) {
    clearInterval(resumeTimer);
    resumeTimer = null;
  }
  announced = false;
  const jobs = [...owed.entries()];
  owed.clear();
  if (jobs.length > 0) {
    console.log(`[deploy-drain] ${drainFilePath()} gone — resuming ${jobs.map(([l]) => l).join(', ')}`);
  }
  for (const [label, job] of jobs) runJob(label, job);
  return jobs.length;
}

function armResumeWatcher(): void {
  if (resumeTimer) return;
  resumeTimer = setInterval(() => void resumeIfUndrained(), RESUME_CHECK_MS);
  resumeTimer.unref?.();
}

/**
 * A timer callback that runs `job` unless this process is draining; a skipped
 * job is owed and runs once as soon as the drain file is removed.
 */
export function unlessDraining(label: string, job: Job): () => void {
  return () => {
    if (isDraining()) {
      if (!announced) {
        announced = true;
        console.log(`[deploy-drain] ${drainFilePath()} present — background jobs paused (first skipped: ${label})`);
      }
      owed.set(label, job);
      armResumeWatcher();
      return;
    }
    runJob(label, job);
  };
}

/** Test hook: forget owed jobs and stop the watcher. */
export function __resetDrainForTests(): void {
  owed.clear();
  if (resumeTimer) clearInterval(resumeTimer);
  resumeTimer = null;
  announced = false;
}

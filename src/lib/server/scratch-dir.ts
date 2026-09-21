import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

/**
 * Where heavy media manipulation happens — DEC-3's scratch
 * (docs/recordings-first-class-design.md §7: "manipulation … happens in
 * `/temphigh` (NVMe, ephemeral — scratch only)").
 *
 * Today every ffmpeg job (the stitch of a multi-file upload, the re-encode
 * fallback) writes its several-GB output straight into the audio dir on the
 * VM's ROOT disk, next to the permanent store. `MW_SCRATCH_DIR` moves that
 * work to the NVMe: set it to `/temphigh/mw-scratch` on the VM and each job
 * gets `/temphigh/mw-scratch/<id>/`, removed when it finishes.
 *
 * UNSET — the laptop, a test, today's VM — is not "a different default": it is
 * literally the old code path, the output written into the audio dir with no
 * move at all. That is what keeps this change inert until somebody sets the
 * variable.
 *
 * Read lazily on every call, never at module scope: `bun run build` must
 * succeed with no environment, and the variable is flipped by a pm2 restart.
 */

export const SCRATCH_DIR_ENV = 'MW_SCRATCH_DIR';

/** The configured scratch root, or null when this host has none. */
export function scratchRoot(): string | null {
  const raw = (process.env[SCRATCH_DIR_ENV] ?? '').trim();
  if (raw === '') return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** A job's own directory under the scratch root, created; null = no scratch. */
export async function makeScratchDir(id: string): Promise<string | null> {
  const root = scratchRoot();
  if (!root) return null;
  // One path segment, ours: the callers pass a uuid, and a stray separator
  // would let a caller write outside the root.
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safe) return null;
  const dir = path.join(root, safe);
  try {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  } catch (err) {
    // A missing/unwritable NVMe must never fail an upload: fall back to the
    // audio dir, which is exactly what an unset variable does.
    console.warn(`[scratch] ${dir} is not usable — working in the audio dir instead:`, err);
    return null;
  }
}

/** Remove a job's scratch directory and everything in it. Best effort. */
export async function dropScratchDir(dir: string | null): Promise<void> {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Move a finished scratch file to its place in the audio dir. A rename when
 * both are on the same filesystem (the no-scratch case never calls this at
 * all); a copy + unlink across devices, which is what the NVMe → root-disk
 * hop is. The copy is what the ingest's atomic rename cannot do for us.
 */
export async function moveFromScratch(absFrom: string, absTo: string): Promise<void> {
  try {
    await fsp.rename(absFrom, absTo);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err;
  }
  await fsp.copyFile(absFrom, absTo);
  await fsp.unlink(absFrom).catch(() => {});
}

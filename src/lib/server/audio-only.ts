import 'server-only';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import { getStorageDir, resolveAudioPath } from '@/lib/server/audio-storage';
import { hasVideoStream } from '@/lib/server/video-frames';

/**
 * Audio-only derivatives of stored meeting recordings, for offline pins.
 *
 * A Meet/Teams recording is a video container of several hundred MB; the
 * offline "audio" pin level only wants the soundtrack (mono AAC 64 kbps is
 * ~30 MB/hour, an order of magnitude smaller). The derivative lives next to
 * the source tree under `${MW_STORAGE_DIR}/audio-only/<stored name>.m4a`
 * and is produced ONCE, lazily, the first time `?variant=audio` is asked
 * for. The transcode is never awaited by a request: the caller answers 202
 * `{ preparing: true }` and the client polls.
 *
 * Sources that carry no video stream need no derivative at all — the plain
 * file IS the audio — so `ensureAudioOnly` hands back the source path with
 * `derived: false` and the route streams it exactly like the plain route.
 */

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * In-flight transcodes keyed by output path, plus the last failure per
 * output (consumed by the next request as a 500, then cleared so a later
 * retry can re-run). Both live on globalThis: Next bundles this module once
 * per route graph, so a module-scope Map would let two route graphs start
 * the same ffmpeg twice (see deferred-import-poller.ts for the same rule).
 */
const g = globalThis as unknown as {
  __mwAudioOnlyInflight?: Map<string, Promise<void>>;
  __mwAudioOnlyErrors?: Map<string, string>;
};
const inflight = (g.__mwAudioOnlyInflight ??= new Map<string, Promise<void>>());
const lastError = (g.__mwAudioOnlyErrors ??= new Map<string, string>());

export function getAudioOnlyDir(): string {
  return path.join(getStorageDir(), 'audio-only');
}

/**
 * `<storageDir>/audio-only/<stored basename without ext>.m4a`. Runs the
 * stored filename through resolveAudioPath first so the same unsafe-name
 * guard applies (no slashes, no `..`).
 */
export function getAudioOnlyPath(storedFilename: string): string {
  resolveAudioPath(storedFilename);
  const stem = path.parse(storedFilename).name;
  return path.join(getAudioOnlyDir(), `${stem}.m4a`);
}

export type AudioOnlyResult =
  | {
      status: 'ready';
      path: string;
      /** true = the .m4a derivative; false = the source file itself (no video stream). */
      derived: boolean;
    }
  | { status: 'preparing' }
  | { status: 'error'; error: string };

/**
 * Resolve the audio-only file for a stored recording, kicking off the
 * transcode in the background when it doesn't exist yet. Never blocks on
 * ffmpeg.
 */
export async function ensureAudioOnly(storedFilename: string): Promise<AudioOnlyResult> {
  const src = resolveAudioPath(storedFilename);

  if (!(await hasVideoStream(storedFilename))) {
    return { status: 'ready', path: src, derived: false };
  }

  const out = getAudioOnlyPath(storedFilename);

  // A derivative older than its source is stale (the source was replaced
  // in place) — treat it as absent so it is rebuilt.
  const st = await fsp.stat(out).catch(() => null);
  if (st && st.size > 0) {
    const srcSt = await fsp.stat(src).catch(() => null);
    if (!srcSt || st.mtimeMs >= srcSt.mtimeMs) {
      return { status: 'ready', path: out, derived: true };
    }
    await fsp.unlink(out).catch(() => {});
  }

  if (inflight.has(out)) {
    return { status: 'preparing' };
  }

  const err = lastError.get(out);
  if (err !== undefined) {
    lastError.delete(out);
    return { status: 'error', error: err };
  }

  const job = transcode(src, out)
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[audio-only] transcode failed for ${storedFilename}:`, message);
      lastError.set(out, message);
    })
    .finally(() => {
      inflight.delete(out);
    });
  inflight.set(out, job);

  return { status: 'preparing' };
}

/**
 * ffmpeg → `<out>.tmp` (explicit `-f mp4` since the tmp name carries no
 * extension for the muxer to infer from) → rename to `<out>`. The rename is
 * atomic on the same filesystem, so a reader never sees a half-written m4a.
 * spawn, not execFile: the run is minutes long and we don't want its
 * stderr buffered against a maxBuffer.
 */
async function transcode(src: string, out: string): Promise<void> {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  await fsp.unlink(tmp).catch(() => {});

  await new Promise<void>((resolve, reject) => {
    const args = [
      '-y', '-loglevel', 'error',
      '-i', src,
      '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmp,
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg could not start: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 60000} min`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.trim() || 'no stderr'}`));
      }
    });
  }).catch(async (e) => {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  });

  // ffmpeg can exit 0 with an empty output when the source has no audio track.
  const st = await fsp.stat(tmp).catch(() => null);
  if (!st || st.size === 0) {
    await fsp.unlink(tmp).catch(() => {});
    throw new Error('ffmpeg produced an empty file (source has no audio track?)');
  }
  await fsp.rename(tmp, out);
}

/**
 * Best-effort removal of a stored recording's derivative (and a half-written
 * .tmp). Called by the permanent-delete route alongside deleteAudioFile so
 * the audio-only copy does not outlive its source.
 */
export async function dropAudioOnly(storedFilename: string): Promise<void> {
  let out: string;
  try {
    out = getAudioOnlyPath(storedFilename);
  } catch {
    return; // unsafe name — nothing of ours can exist for it
  }
  await fsp.unlink(out).catch(() => {});
  await fsp.unlink(`${out}.tmp`).catch(() => {});
}

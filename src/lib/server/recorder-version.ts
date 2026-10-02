import { promises as fsp } from 'node:fs';

/**
 * The published Darth Recorder tray version, read from the same version.json
 * the updater polls (served by cli.darth-internal from /var/www/cli-dist on
 * this VM). Riding on the 5-minute heartbeat means a tray hears about a
 * release on its next ping and checks the feed right away instead of waiting
 * for its own poll (Alok, 2026-09-16: "we have heartbeats — should be like 5
 * mins"). The operator view (GET /api/admin/recorder/devices) marks trays
 * below it as outdated. Cached 60 s; a missing/unreadable file → null.
 */
const VERSION_FEED_PATH =
  process.env.RECORDER_VERSION_FEED_PATH || '/var/www/cli-dist/darth-recorder/version.json';
const VERSION_FEED_URL =
  process.env.RECORDER_VERSION_FEED_URL ||
  'https://cli.darth-internal.trames.io/darth-recorder/version.json';
let feedCache: { at: number; version: string | null } = { at: 0, version: null };

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
}

export async function latestAppVersion(): Promise<string | null> {
  if (Date.now() - feedCache.at < 60_000) return feedCache.version;
  let version: string | null = null;
  try {
    const raw = await fsp.readFile(VERSION_FEED_PATH, 'utf8');
    version = str((JSON.parse(raw) as { version?: unknown }).version, 40);
  } catch {
    try {
      const res = await fetch(VERSION_FEED_URL, { signal: AbortSignal.timeout(3000) });
      if (res.ok) version = str(((await res.json()) as { version?: unknown }).version, 40);
    } catch {
      version = null;
    }
  }
  feedCache = { at: Date.now(), version };
  return version;
}

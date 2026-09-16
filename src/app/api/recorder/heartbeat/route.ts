import { promises as fsp } from 'node:fs';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { upsertRecorderDevice } from '@/db-ops/recorder';

export const runtime = 'nodejs';

/**
 * The published tray version, read from the same version.json the updater
 * polls (served by cli.darth-internal from /var/www/cli-dist on this VM).
 * Riding on the 5-minute heartbeat means a tray hears about a release on its
 * next ping and checks the feed right away instead of waiting for its own
 * poll (Alok, 2026-09-16: "we have heartbeats — should be like 5 mins").
 * Cached 60 s; a missing/unreadable file just omits the field.
 */
const VERSION_FEED_PATH =
  process.env.RECORDER_VERSION_FEED_PATH || '/var/www/cli-dist/darth-recorder/version.json';
const VERSION_FEED_URL =
  process.env.RECORDER_VERSION_FEED_URL ||
  'https://cli.darth-internal.trames.io/darth-recorder/version.json';
let feedCache: { at: number; version: string | null } = { at: 0, version: null };

async function latestAppVersion(): Promise<string | null> {
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

/** The oldest tray build the server still wants in the field. The tray shows
 * an update prompt below it (it self-updates anyway). */
const MIN_APP_VERSION = process.env.RECORDER_MIN_APP_VERSION || '0.2.0';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
}

/**
 * POST /api/recorder/heartbeat
 * `{device_id, hostname, os, app_version, status}` → upsert the device row
 * (owner = caller) → `{ok, server_time, min_app_version, latest_app_version?}`.
 *
 * Called on tray launch and every 5 min. `status` is the tray's own status
 * snapshot, stored verbatim for debugging the beta.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const deviceId = str(body.device_id, 64);
  if (!deviceId || !UUID_RE.test(deviceId)) {
    return NextResponse.json({ error: 'device_id must be a uuid' }, { status: 400 });
  }
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;

  const device = await upsertRecorderDevice({
    deviceId,
    userId: user.userId,
    email: user.email,
    hostname: str(body.hostname, 120),
    os: str(body.os, 120),
    appVersion: str(body.app_version, 40),
    ip: ip ? ip.slice(0, 64) : null,
    status: body.status && typeof body.status === 'object' ? body.status : null,
  });

  const latest = await latestAppVersion();
  return NextResponse.json({
    ok: true,
    server_time: new Date().toISOString(),
    min_app_version: MIN_APP_VERSION,
    ...(latest ? { latest_app_version: latest } : {}),
    device: { device_id: device.device_id, first_seen: device.first_seen, email: device.email },
  });
});

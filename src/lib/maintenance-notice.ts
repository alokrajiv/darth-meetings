/**
 * The owner's deploy notice (README "Deploy" → "Maintenance notice").
 *
 * `./deploy.sh --message "…" [--eta 10m]` (or `--notice`) writes
 * `/var/www/mw-maintenance/notice.json` on the VM and nginx serves it at
 * `/__notice.json` — straight from disk, so it answers while the app itself is
 * down. The text is always the owner's own words; there is NO automatic text:
 * no file → no notice, and a 5xx is never assumed to be a deployment.
 *
 * Read by three places, all through this module:
 *   - <MaintenanceBanner> in the root layout (polls every 30 s + on focus);
 *   - src/app/global-error.tsx (the "This page couldn't load" page);
 *   - deploy/maintenance.html (nginx's 502/503/504 page — a plain-JS copy of
 *     parse + format, since it cannot import this file).
 *
 * File shape (written by deploy.sh): { message, since, eta_at | null, build }.
 */

export const NOTICE_PATH = '/__notice.json';

export type MaintenanceNotice = {
  /** The owner's text, trimmed, at most MAX_MESSAGE chars. */
  message: string;
  /** ISO time the notice was written; doubles as its identity for "dismiss". */
  since: string;
  /** ISO time the owner expects to be done, or null when no ETA was given. */
  etaAt: string | null;
  build: string | null;
};

const MAX_MESSAGE = 500;

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The parsed body of `/__notice.json`, or null for anything that is not a
 * notice: no body, not JSON-shaped, an empty/blank message. `since` falls back
 * to the message itself so a hand-written file still dismisses per notice.
 */
export function parseNotice(raw: unknown): MaintenanceNotice | null {
  let v: unknown = raw;
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const message =
    typeof o.message === 'string'
      ? o.message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_MESSAGE)
      : '';
  if (!message) return null;
  return {
    message,
    since: isoOrNull(o.since) ?? `msg:${message}`,
    etaAt: isoOrNull(o.eta_at ?? o.etaAt),
    build: typeof o.build === 'string' && o.build.trim() ? o.build.trim() : null,
  };
}

const SGT_OFFSET_MS = 8 * 3600 * 1000;

/** "12:40 SGT" — or "Fri 12:40 SGT" when the time is not on `now`'s SGT day. */
export function formatSgtClock(iso: string, now: Date = new Date()): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + SGT_OFFSET_MS);
  const n = new Date(now.getTime() + SGT_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const sameDay =
    d.getUTCFullYear() === n.getUTCFullYear() &&
    d.getUTCMonth() === n.getUTCMonth() &&
    d.getUTCDate() === n.getUTCDate();
  const day = sameDay ? '' : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} `;
  return `${day}${hh}:${mm} SGT`;
}

/**
 * The ETA line: "until ~12:40 SGT", or "expected back ~12:40 SGT — running
 * late" once that time has passed. null when the notice has no ETA.
 */
export function noticeEtaText(n: Pick<MaintenanceNotice, 'etaAt'>, now: Date = new Date()): string | null {
  if (!n.etaAt) return null;
  const clock = formatSgtClock(n.etaAt, now);
  if (!clock) return null;
  if (Date.parse(n.etaAt) < now.getTime()) return `expected back ~${clock} — running late`;
  return `until ~${clock}`;
}

/**
 * GET /__notice.json, no cache (the service worker passes `no-store` fetches
 * straight to the network). Any failure — 404 (no notice), a network error, a
 * non-JSON body (the local dev server has no such file) — is "no notice".
 */
export async function fetchNotice(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<MaintenanceNotice | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(NOTICE_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return parseNotice(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Did this client error come from a JS/CSS chunk that could not be loaded?
 * That is version skew — the tab runs an older (or newer) build than the
 * server it is talking to, e.g. a tab left open across a deploy — and a
 * reload fixes it, unlike a real render bug.
 */
export function isChunkLoadError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const msg = typeof e.message === 'string' ? e.message : '';
  if (name === 'ChunkLoadError') return true;
  return /Loading (CSS )?chunk [\w-]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
    msg
  );
}

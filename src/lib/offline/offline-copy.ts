/**
 * Offline copy for the desktop replica's screens (family wording, desktop
 * plans/offline contract "App side"). Pure.
 */

/** The family's one phrase for a control or row that needs the network. */
export const NOT_AVAILABLE_OFFLINE = 'Not available offline';

/** The hash the listing uses to open a stored meeting in place (no document
 * load: `/#read=<id>`). */
export const READ_HASH_PREFIX = '#read=';

/** The event a search hit fires on the listing page to open a stored meeting
 * in place (a hash-only router.push fires neither popstate nor hashchange). */
export const OFFLINE_READ_EVENT = 'meetings:offline-read';

export function readHashOf(id: string): string {
  return `${READ_HASH_PREFIX}${encodeURIComponent(id)}`;
}

/** The meeting id a `#read=<id>` hash names, or null. */
export function readIdFromHash(hash: string | null | undefined): string | null {
  if (!hash || !hash.startsWith(READ_HASH_PREFIX)) return null;
  try {
    const id = decodeURIComponent(hash.slice(READ_HASH_PREFIX.length)).trim();
    return id ? id : null;
  } catch {
    return null;
  }
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:02" today, "Mon 20 Oct, 14:02" before (local time). */
export function savedAtLabel(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(d, now)) return time;
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/** "Showing what was saved at 14:02" (or "… on this Mac" when the time is unknown). */
export function savedLine(ms: number | null, now: Date = new Date()): string {
  return ms ? `Showing what was saved at ${savedAtLabel(ms, now)}` : 'Showing what was saved on this Mac';
}

/** The local-day key (YYYY-MM-DD) of an ISO time. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00-00';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** "Today", "Yesterday", or "Mon 20 Oct" (with the year when it is not this year). */
export function dayHeading(key: string, now: Date = new Date()): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y!, (m ?? 1) - 1, d ?? 1);
  if (sameDay(date, now)) return 'Today';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (sameDay(date, yest)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** Rows grouped by local day, newest day first, order kept inside a day. */
export function groupByLocalDay<T>(rows: readonly T[], atOf: (r: T) => string): { key: string; rows: T[] }[] {
  const out: { key: string; rows: T[] }[] = [];
  const byKey = new Map<string, { key: string; rows: T[] }>();
  for (const r of rows) {
    const key = localDayKey(atOf(r));
    let g = byKey.get(key);
    if (!g) {
      g = { key, rows: [] };
      byKey.set(key, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

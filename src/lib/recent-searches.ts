/**
 * The results panel's "Recent searches" (like Slack's): the last
 * RECENT_SEARCH_MAX queries, each with its scope chip (`in: <meeting>`) when
 * it was a search inside one meeting. Newest first; the same query with the
 * same scope is kept once (moved to the top, its chip title refreshed).
 *
 * Pure list logic here; the storage (the Darth desktop shell's local store,
 * else localStorage) is lib/recent-searches-store.ts.
 */

export const RECENT_SEARCH_MAX = 5;
/** Queries longer than this are not remembered (pasted paragraphs). */
export const RECENT_QUERY_MAX = 200;

export interface RecentSearchScope {
  /** Transcript route id of the meeting. */
  id: string;
  /** The meeting's title when the search ran (the chip's text). */
  title: string;
}

export interface RecentSearch {
  q: string;
  scope: RecentSearchScope | null;
  /** Epoch ms of the last run. */
  at: number;
}

function keyOf(q: string, scopeId: string | null | undefined): string {
  return `${scopeId ?? ''}\u0000${q.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** `entry` remembered: deduped (query, case/space-insensitive, + scope), newest first, capped. Pure. */
export function pushRecentSearch(
  list: readonly RecentSearch[],
  entry: RecentSearch,
  max = RECENT_SEARCH_MAX
): RecentSearch[] {
  const q = entry.q.trim().replace(/\s+/g, ' ');
  if (!q || q.length > RECENT_QUERY_MAX) return list.slice(0, max);
  const k = keyOf(q, entry.scope?.id);
  const rest = list.filter((r) => keyOf(r.q, r.scope?.id) !== k);
  return [{ q, scope: entry.scope ? { id: entry.scope.id, title: entry.scope.title } : null, at: entry.at }, ...rest].slice(
    0,
    max
  );
}

/** Drop one entry (the row's × button). Pure. */
export function removeRecentSearch(list: readonly RecentSearch[], entry: Pick<RecentSearch, 'q' | 'scope'>): RecentSearch[] {
  const k = keyOf(entry.q, entry.scope?.id);
  return list.filter((r) => keyOf(r.q, r.scope?.id) !== k);
}

/** Anything parsed from storage → a clean list (bad rows dropped). Pure. */
export function sanitizeRecentSearches(raw: unknown, max = RECENT_SEARCH_MAX): RecentSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentSearch[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as { q?: unknown; scope?: unknown; at?: unknown };
    if (typeof o.q !== 'string' || !o.q.trim() || o.q.length > RECENT_QUERY_MAX) continue;
    let scope: RecentSearchScope | null = null;
    if (o.scope && typeof o.scope === 'object') {
      const s = o.scope as { id?: unknown; title?: unknown };
      if (typeof s.id === 'string' && s.id) scope = { id: s.id, title: typeof s.title === 'string' ? s.title : '' };
    }
    const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
    out.push({ q: o.q.trim(), scope, at });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, max);
}

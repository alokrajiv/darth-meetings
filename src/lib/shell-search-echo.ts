import type { RecentSearchScope } from './recent-searches';

/**
 * Page → band search echo (Darth desktop shell 0.3.3, desktop repo
 * docs/SEARCH-HANDOFF.md "Page → band echo" + docs/ARCHITECTURE.md).
 *
 * The shell's band mirrors what the results panel holds: its query and its
 * `in: <meeting>` chip, so a Recent search picked in the panel, or the chip
 * applied by Enter, shows in the band too. The shell exposes
 *
 *   window.darthDesktop.search.echo({ query, scope })
 *     query  string ≤ 512 ('' = nothing)
 *     scope  { kind: 'meeting', id: 1..200 chars, label: 1..4096 chars } | null
 *     → Promise<{ ok: true, shown } | { error: { code, message } }>, never rejects
 *
 * only on registry app origins inside the shell. Feature-detected: in a
 * browser, or an older shell without `search`, nothing happens at all. The
 * result is never awaited (fire and forget; a throw or a rejection is
 * swallowed — the echo is cosmetic).
 *
 * The other way, the band's `darth-shell:search` detail carries `scope: null`
 * (and only ever null) when the person removed the chip in the band (its ×,
 * Backspace at the start, Esc) — `bandRemovedScope`. No `scope` key = keep
 * whatever scope the page has.
 */

export const ECHO_QUERY_MAX = 512;
export const ECHO_ID_MAX = 200;
export const ECHO_LABEL_MAX = 4096;
/** The chip's text when the meeting has no title. */
export const ECHO_FALLBACK_LABEL = 'this meeting';

export type EchoScope = { kind: 'meeting'; id: string; label: string } | null;
export interface SearchEcho {
  query: string;
  scope: EchoScope;
}

type EchoFn = (d: SearchEcho) => unknown;
type EchoWindow = { darthDesktop?: { search?: { echo?: unknown } } };

/** The payload for the band: query cut to 512; the scope as the shell's
 * `{kind:'meeting', id, label}` (null when there is none, or its id is not
 * 1..200 chars — the shell would refuse it). Pure. */
export function bandEcho(query: string, scope: RecentSearchScope | null): SearchEcho {
  const q = query.slice(0, ECHO_QUERY_MAX);
  if (!scope || !scope.id || scope.id.length > ECHO_ID_MAX) return { query: q, scope: null };
  const label = (scope.title ?? '').trim().slice(0, ECHO_LABEL_MAX) || ECHO_FALLBACK_LABEL;
  return { query: q, scope: { kind: 'meeting', id: scope.id, label } };
}

/** The shell's echo function, or null outside the shell / on a shell without
 * it. `win` defaults to the real window (tests pass a plain object). */
export function desktopSearchEcho(win?: unknown): EchoFn | null {
  const w = (win ?? (typeof window === 'undefined' ? undefined : window)) as EchoWindow | undefined;
  const s = w?.darthDesktop?.search;
  if (!s || typeof s.echo !== 'function') return null;
  const echo = s.echo as EchoFn;
  return (d) => echo.call(s, d);
}

/** Echo `query` + `scope` into the band. Returns whether it was sent (false
 * when the API is absent). Never throws, never awaits, never rejects. */
export function echoToBand(query: string, scope: RecentSearchScope | null, win?: unknown): boolean {
  const echo = desktopSearchEcho(win);
  if (!echo) return false;
  try {
    const r = echo(bandEcho(query, scope));
    if (r && typeof (r as PromiseLike<unknown>).then === 'function') {
      (r as PromiseLike<unknown>).then(undefined, () => {});
    }
  } catch {
    // An echo is cosmetic: a broken bridge never breaks the page's search.
  }
  return true;
}

/**
 * An echoer that sends only when what the panel holds CHANGED (query, chip id
 * or chip label), starting from "nothing" — so the first mount with a closed
 * panel sends nothing (a reload never wipes the band's text), and a re-render
 * with the same state is not echoed twice.
 */
export function createBandEchoer(
  send: (query: string, scope: RecentSearchScope | null) => unknown = (q, s) => echoToBand(q, s)
): (query: string, scope: RecentSearchScope | null) => void {
  let last = keyOf(bandEcho('', null));
  return (query, scope) => {
    const key = keyOf(bandEcho(query, scope));
    if (key === last) return;
    last = key;
    send(query, scope);
  };
}

function keyOf(e: SearchEcho): string {
  return JSON.stringify([e.query, e.scope?.id ?? null, e.scope?.label ?? null]);
}

/** True when a `darth-shell:search` detail says the person removed the band's
 * chip (`scope` present and null). A missing key means "unchanged". Pure. */
export function bandRemovedScope(detail: { scope?: null } | null | undefined): boolean {
  return !!detail && typeof detail === 'object' && 'scope' in detail && detail.scope === null;
}

/**
 * Darth family — the sibling internal tools Darth Meetings links to.
 *
 * Client-safe constants (no secrets). The family map + shared conventions
 * (SSO, hosting, darth-cli, which app owns which external account link,
 * cross-app calls) are documented once in the darth-cli repo:
 *   darth-cli/DARTH-FAMILY.md
 * Server-only base URLs with env overrides live next to their callers
 * (e.g. `@/lib/server/darth-notify` for the notify pipe).
 */

/** Darth Tasks (repo darth-plagueis) — tasks, Slack, people registry, Teams chat link. */
export const DARTH_TASKS_URL = 'https://tasks.darth-internal.trames.io';
/** Holocrons (formerly Darth Artifacts; repo/service still darth-artifacts) —
 * internal page/file hosting. `darth-cli holocrons` (alias `artifacts`). The
 * const keeps its old name on purpose; only the host changed (2026-08-22). */
export const DARTH_ARTIFACTS_URL = 'https://holocrons.darth-internal.trames.io';
/** darth-auth — CLI login, tokens, installer, account links (/connections). */
export const DARTH_AUTH_URL = 'https://auth.darth-internal.trames.io';

/**
 * darth-auth's Connections page — since 2026-10-12 the ONE place a person
 * connects, reconnects or disconnects Google / Microsoft / Notion (auth holds
 * every refresh token; members fetch access tokens service-to-service).
 * Takes `?return=<absolute url>`; auth comes back to it with
 * `?connected=<provider>` appended.
 */
export const DARTH_AUTH_CONNECTIONS_URL = `${DARTH_AUTH_URL}/connections`;

/**
 * `/connections?return=<absolute url>`. A relative `returnTo` is made
 * absolute on `base` (the browser's origin client-side, APP_BASE_URL on the
 * server — see `connectionsUrl` in `@/lib/server/google-oauth`). `page`
 * lets a caller use the bare page URL a status payload handed it.
 */
export function connectionsHref(
  returnTo: string,
  base: string,
  page: string = DARTH_AUTH_CONNECTIONS_URL
): string {
  const ret = new URL(returnTo, base).toString();
  return `${page}?return=${encodeURIComponent(ret)}`;
}

/** Old Darth Tasks Microsoft page — now only a redirect to
 * DARTH_AUTH_CONNECTIONS_URL. Prefer that constant. */
export const DARTH_TASKS_MS_PAGE = `${DARTH_TASKS_URL}/ms`;

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
/** Darth Artifacts — internal page/file hosting. */
export const DARTH_ARTIFACTS_URL = 'https://artifacts.darth-internal.trames.io';
/** darth-auth — CLI login, tokens, installer. */
export const DARTH_AUTH_URL = 'https://auth.darth-internal.trames.io';

/** Where a user connects/manages their Microsoft (Teams chat) account — owned by Darth Tasks. */
export const DARTH_TASKS_MS_PAGE = `${DARTH_TASKS_URL}/ms`;

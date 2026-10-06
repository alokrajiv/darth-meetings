/**
 * The company's own mail domains. An invitee on one of these is "internal":
 * the meeting share policy shares a meeting with its internal invitees
 * (lib/server/auto-share.ts), the auditor policy treats everyone else as an
 * outside party (lib/auditor-policy.ts), and a curated-series invite rule can
 * insist on "nobody from outside" (lib/series-patterns.ts `internalOnly`).
 *
 * Pure + client-safe — the matcher runs in the browser's preview too, so the
 * set cannot live in the server-only auto-share module (which re-exports it
 * as AUTO_SHARE_DOMAINS so nothing that already imports it changes).
 */
export const INTERNAL_DOMAINS: ReadonlySet<string> = new Set(['trames.sg', 'trames-engineering.com']);

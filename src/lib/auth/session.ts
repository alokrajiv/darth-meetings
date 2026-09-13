/**
 * Browser session resolution — the `darth_session` cookie issued by darth-auth.
 *
 * Replaces the clonetrooper/kenoby JWT path (removed 2026-09-13, SPEC §4.2):
 * the cookie is an opaque `dss_…` value that only darth-auth can resolve, so
 * every read goes through the same introspect helper the darth-cli bearer
 * path uses (`cli-auth.ts`, 60 s in-process cache).
 *
 * meetings is a regular user app: any darth-auth user whose `modules` include
 * `meetings` is allowed in (`hasMeetingsAccess`). No org/group selection, no
 * super-admin. Row-level ACL is enforced at the db-ops layer using
 * `user.userId` passed into every query.
 */

import { cookies } from 'next/headers';
import { resolveSession, resolveSessionDetailed, type DarthIdentity } from './cli-auth';

export const SESSION_COOKIE = 'darth_session';

/** The identity shape every route/pipeline receives (cookie or bearer). */
export type DarthUser = DarthIdentity;

/**
 * Get the current darth user from the cookie jar (server components / route
 * handlers). Returns null if there is no valid session. Does NOT check app
 * access — callers use `hasMeetingsAccess` (withAuth does it for every API).
 */
export async function getCurrentUser(): Promise<DarthUser | null> {
  const cookieStore = await cookies();
  return resolveSession(cookieStore.get(SESSION_COOKIE)?.value);
}

/**
 * Same, from raw request headers — for handlers that already hold a Request
 * and don't want to round-trip through next/headers.
 */
export async function getCurrentUserFromHeaders(headers: Headers): Promise<DarthUser | null> {
  return resolveSession(readCookie(headers.get('cookie'), SESSION_COOKIE));
}

/**
 * Same, distinguishing "no session" from "darth-auth could not be asked"
 * (`transient`). Only /api/auth/session cares — it is the offline
 * provider's session probe and must not report a 401 for a hiccup.
 */
export async function getCurrentUserFromHeadersDetailed(
  headers: Headers
): Promise<{ user: DarthUser | null; transient: boolean }> {
  return resolveSessionDetailed(readCookie(headers.get('cookie'), SESSION_COOKIE));
}

/** Minimal cookie-header parser (no deps; the value is base64url so no quoting). */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

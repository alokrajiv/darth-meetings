/**
 * Authentication wrapper for API routes.
 *
 * meetings is a regular user app: any darth-auth user whose modules include
 * `meetings` is allowed (SPEC §3.3) — on BOTH the browser-session path and the
 * darth-cli bearer path (the old CLI bypass is closed). No super-admin scope
 * exists here. Row-level ACL is enforced at the db-ops layer using
 * `user.userId` passed into every query.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, type DarthUser } from './session';
import {
  getDarthBearer,
  resolveDarthToken,
  hasMeetingsAccess,
  NO_ACCESS_MESSAGE,
  type CliScope,
} from './cli-auth';

export const runtime = 'nodejs';

export interface AuthContext {
  user: DarthUser;
  request: NextRequest;
  /** Set when the caller authenticated with a darth-cli token instead of the session cookie. */
  cliScope?: CliScope;
}

type AuthenticatedHandler = (
  context: AuthContext,
  routeContext: { params: Promise<Record<string, string>> }
) => Promise<Response> | Response;

function forbidden(error: string) {
  return NextResponse.json({ error }, { status: 403 });
}

/**
 * Wrap an API route with authentication.
 *
 * @example
 * ```typescript
 * export const GET = withAuth(async ({ user }) => {
 *   const rows = await listTranscriptsForUser(user.userId);
 *   return NextResponse.json(rows);
 * });
 * ```
 */
export function withAuth(
  handler: AuthenticatedHandler
): (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response> {
  return async (request: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    try {
      // A darth bearer takes precedence over the cookie. An invalid/revoked
      // token is a hard 401 — it must not fall through to cookie auth.
      const bearer = getDarthBearer(request.headers.get('authorization'));
      if (bearer) {
        const identity = await resolveDarthToken(bearer);
        if (!identity) {
          return NextResponse.json(
            { error: 'Unauthorized - invalid or revoked darth token' },
            { status: 401 }
          );
        }
        if (identity.kind === 'app') {
          // No inbound dapp_ routes in meetings (only outbound → tasks /api/notify).
          return forbidden('Forbidden - app tokens are not accepted by meetings');
        }
        if (!hasMeetingsAccess(identity)) {
          return forbidden(NO_ACCESS_MESSAGE);
        }
        const method = request.method.toUpperCase();
        if (identity.scope === 'read' && method !== 'GET' && method !== 'HEAD') {
          return forbidden(
            'Forbidden - token is read-only for meetings; re-run `darth-cli login` and pick Read + write'
          );
        }
        return await handler({ user: identity, request, cliScope: identity.scope }, context);
      }

      const user = await getCurrentUser();
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized - No valid session' }, { status: 401 });
      }
      if (!hasMeetingsAccess(user)) {
        return forbidden(NO_ACCESS_MESSAGE);
      }
      return await handler({ user, request }, context);
    } catch (error) {
      console.error('[withAuth] Error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

/**
 * Authentication wrapper for API routes.
 *
 * meeting-whisperer is a regular user app: any authenticated user with
 * access to the `meeting-whisperer` app in clonetrooper is allowed.
 * No super-admin scope required. Row-level ACL is enforced at the db-ops
 * layer using `user.userId` passed into every query.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, SSOSessionData } from './sso-session';

// Force Node.js runtime (Edge can't do jsonwebtoken RS256 verify with crypto.createPublicKey)
export const runtime = 'nodejs';

export interface AuthContext {
  user: SSOSessionData;
  request: NextRequest;
  scopes: string[];
}

type AuthenticatedHandler = (
  context: AuthContext,
  routeContext: { params: Promise<Record<string, string>> }
) => Promise<Response> | Response;

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
      const user = await getCurrentUser();

      if (!user) {
        return NextResponse.json(
          { error: 'Unauthorized - No valid session' },
          { status: 401 }
        );
      }

      const scopeStrings = user.scopes?.map(s => s.s) || [];

      const authContext: AuthContext = {
        user,
        request,
        scopes: scopeStrings,
      };

      return await handler(authContext, context);
    } catch (error) {
      console.error('[withAuth] Error:', error);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  };
}

export function hasScope(scopes: string[], requiredScope: string): boolean {
  if (scopes.includes('global__super-admin')) return true;
  if (scopes.includes(requiredScope)) return true;
  return false;
}

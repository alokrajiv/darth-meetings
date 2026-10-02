/**
 * Super-admin wrapper for the operator API under /api/admin/* (darth-admin's
 * Recorder page forwards the admin's own `darth_session` cookie or
 * `Bearer dth_` here over loopback).
 *
 * Same credential resolution as `withAuth` (bearer beats cookie, an invalid
 * bearer is a hard 401, no credential → 401), but the gate is the darth-auth
 * `access` module — the super-admin module the whole admin app requires —
 * not `meetings`. Anyone signed in WITHOUT `access` (a plain meetings user, a
 * dapp_ app token) gets 404 `{error:'Not found'}`, exactly like darth-chat's
 * admin API: the route does not reveal that it exists.
 *
 * A `dth_` token passes on any scope for GET/HEAD (read is enough to read);
 * a read-scoped token is refused for anything else — with the same 404, as
 * no admin route here writes today.
 *
 * src/proxy.ts lets `access` holders through to /api/admin/* even without
 * the `meetings` module (as chat's proxy does for its admin API); this
 * wrapper is the gate that matters.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromHeaders, type DarthUser } from './session';
import { getDarthBearer, hasAdminAccess, resolveDarthToken } from './cli-auth';

export { ADMIN_MODULE, hasAdminAccess } from './cli-auth';

export const runtime = 'nodejs';

export interface AdminAuthContext {
  user: DarthUser;
  request: NextRequest;
}

type AdminHandler = (
  context: AdminAuthContext,
  routeContext: { params: Promise<Record<string, string>> }
) => Promise<Response> | Response;

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

export function withAdminAuth(
  handler: AdminHandler
): (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response> {
  return async (request, context) => {
    try {
      const method = request.method.toUpperCase();
      const bearer = getDarthBearer(request.headers.get('authorization'));
      if (bearer) {
        const identity = await resolveDarthToken(bearer);
        if (!identity) {
          return NextResponse.json(
            { error: 'Unauthorized - invalid or revoked darth token' },
            { status: 401 }
          );
        }
        if (identity.kind === 'app' || !hasAdminAccess(identity)) return notFound();
        if (identity.scope === 'read' && method !== 'GET' && method !== 'HEAD') return notFound();
        return await handler({ user: identity, request }, context);
      }

      const user = await getCurrentUserFromHeaders(request.headers);
      if (!user) {
        return NextResponse.json({ error: 'Unauthorized - No valid session' }, { status: 401 });
      }
      if (!hasAdminAccess(user)) return notFound();
      return await handler({ user, request }, context);
    } catch (error) {
      console.error('[withAdminAuth] Error:', error);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}

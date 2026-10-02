import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUserFromHeadersDetailed } from '@/lib/auth/session';
import { hasMeetingsAccess } from '@/lib/auth/cli-auth';

export const runtime = 'nodejs';

/**
 * GET /api/auth/session — the darth-auth introspect object for the caller's
 * `darth_session` cookie, or 401. Diagnostics only (the transcript page reads
 * `email` from it); proxy + withAuth are the real gate.
 *
 * A darth-auth hiccup (unreachable, 5xx, timeout) answers 503
 * `{ transient: true }` instead of 401, so a caller never mistakes "auth
 * service down" for "signed out".
 */
export async function GET(request: NextRequest) {
  try {
    const { user, transient } = await getCurrentUserFromHeadersDetailed(request.headers);
    if (!user) {
      if (transient) {
        return NextResponse.json(
          { isAuthenticated: false, transient: true, error: 'Auth service unavailable' },
          { status: 503, headers: { 'cache-control': 'no-store' } }
        );
      }
      return NextResponse.json({ isAuthenticated: false, error: 'No valid darth session' }, { status: 401 });
    }
    return NextResponse.json({
      isAuthenticated: true,
      kind: user.kind,
      userId: user.userId,
      email: user.email,
      name: user.name ?? null,
      provider: user.provider ?? null,
      modules: user.modules,
      hasMeetingsAccess: hasMeetingsAccess(user),
      expiresAt: user.expiresAt ?? null,
    });
  } catch (error) {
    console.error('[Auth Session] Error:', error);
    return NextResponse.json({ isAuthenticated: false, error: 'Internal server error' }, { status: 500 });
  }
}

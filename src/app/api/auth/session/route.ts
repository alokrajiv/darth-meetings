import { NextRequest, NextResponse } from 'next/server';
import { validateTramesesSession } from '@/lib/clonetrooper/shared/auth/session-utils';
import { config } from '@/config';

export const runtime = 'nodejs';

/**
 * GET /api/auth/session — returns the current user's session payload or 401.
 * Used by the client for diagnostics; middleware + withAuth are the real gate.
 */
export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie') || '';

    const result = await validateTramesesSession(cookieHeader, {
      loginDomain: config.auth.loginDomain,
      requireOrgSelection: false,
    });

    if (!result.success) {
      return NextResponse.json(
        { isAuthenticated: false, error: result.error.message },
        { status: 401 }
      );
    }

    const { data } = result;
    return NextResponse.json({
      isAuthenticated: true,
      userId: data.userId,
      email: data.email,
      allowedApps: data.allowedApps,
      scopes: data.scopes,
    });
  } catch (error) {
    console.error('[Auth Session] Error:', error);
    return NextResponse.json(
      { isAuthenticated: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

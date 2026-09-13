import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';

export const runtime = 'nodejs';

/**
 * GET /api/whoami — identity as this service sees it. Primarily for
 * `darth-cli meetings whoami`: verifies the bearer resolves and shows the
 * effective per-service scope.
 */
export const GET = withAuth(async ({ user, cliScope }) => {
  return NextResponse.json({
    userId: user.userId,
    email: user.email,
    via: cliScope ? 'darth-cli' : 'session',
    scope: cliScope ?? null,
    modules: user.modules,
  });
});

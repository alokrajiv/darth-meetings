import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { hasMeetingsAccess } from '@/lib/auth/cli-auth';

export const runtime = 'nodejs';

/** GET /api/auth/check — cheap "am I signed in" probe for the client. */
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ authenticated: false });
    }
    return NextResponse.json({
      authenticated: true,
      userId: user.userId,
      email: user.email,
      hasMeetingsAccess: hasMeetingsAccess(user),
    });
  } catch (error) {
    console.error('[Auth Check] Error:', error);
    return NextResponse.json({ authenticated: false });
  }
}

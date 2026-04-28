import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/sso-session';

export const runtime = 'nodejs';

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
    });
  } catch (error) {
    console.error('[Auth Check] Error:', error);
    return NextResponse.json({ authenticated: false });
  }
}

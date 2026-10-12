import { NextResponse } from 'next/server';
import { config } from '@/config';

export const runtime = 'nodejs';

/**
 * Former Google OAuth redirect target. The link is made on darth-auth since
 * 2026-10-12 (auth has its own callback), so anything still landing here is a
 * stale bookmark or an old consent tab: send it to Settings, which shows the
 * link's state and the way to Connections. No session needed for a redirect.
 */
export function GET(): NextResponse {
  return NextResponse.redirect(new URL('/settings', config.google.appBaseUrl));
}

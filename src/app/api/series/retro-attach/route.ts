import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { retroAttachSweep } from '@/lib/server/series-attach';

export const runtime = 'nodejs';

// The sweep walks every unattached transcript with one key query each —
// ~200 rows today, well under a minute, but give it headroom.
export const maxDuration = 120;

/**
 * POST /api/series/retro-attach — strong-key re-match of every transcript
 * that belongs to no series, attaching to EXISTING series only (never
 * creates one). Returns { scanned, attached, suggestions } — suggestions =
 * weak-only matches already visible as dashed "?" chips in the listing.
 */
export const POST = withAuth(async ({ user }) => {
  return NextResponse.json(await retroAttachSweep(user.email));
});

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { listOwnRecordingsSurface, parseOwnRecordingsQuery } from '@/lib/server/own-recordings';

export const runtime = 'nodejs';

/**
 * GET /api/recordings?mine=1[&unlinked=1][&temporary=1][&tz=<IANA>]
 *
 * The caller's OWN recordings that belong to no meeting — the Recordings
 * surface (docs/recordings-meetings-series-design.md §3.1, §4.1, P6):
 *
 *  - `unlinked=1` → `registry` (own Darth Recorder rows) + `unlinked` (own
 *    uploads with no calendar event and no human title);
 *  - `temporary=1` → `temporary` (own temporary uploads, migration 042);
 *  - neither → both.
 *
 * Owner only, by construction (invariant I2): there is no form of this
 * route that lists anyone else's recording, and no parameter that asks.
 * `mine=1` is required so that stays spelled out at every call site.
 */
export const GET = withAuth(async ({ user, request }) => {
  const parsed = parseOwnRecordingsQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return NextResponse.json(await listOwnRecordingsSurface(user, parsed.query));
});

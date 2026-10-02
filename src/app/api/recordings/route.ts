import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { listOwnRecordingsSurface, parseRecordingsPageQuery } from '@/lib/server/own-recordings';
import { RecordingsRegexError } from '@/db-ops/own-recordings-page';

export const runtime = 'nodejs';

/**
 * GET /api/recordings?mine=1[&section=mac|uploaded|temporary|linked][&q=][&regex=1]
 *                           [&limit=0..200][&cursor=][&tz=<IANA>]
 *
 * The caller's OWN recordings that belong to no meeting — the Recordings
 * surface (docs/recordings-meetings-series-design.md §3.1, §4.1; P6, P7):
 * one newest-first list over standalone recordings, legacy bare / temporary
 * uploads and Darth Recorder rows still on a Mac, cursor-paginated
 * (`limit` default 50, max 200; `limit=0` = counts only), searchable
 * (`q` over title / filename / call title; `regex=1` = POSIX, case-
 * insensitive), filterable by section. The older `unlinked=1` /
 * `temporary=1` flags still select sections.
 *
 * Answer: `{ items, next_cursor, counts: { mac, uploaded, temporary } }`
 * (lib/server/own-recordings OwnRecordingsResponse).
 *
 * `section=linked` (2026-10-02) — asked for by name only, never part of the
 * default: the caller's recordings a live meeting holds, each item carrying
 * `meetings: [{ assemblyai_id, title, recorded_at }]` (the ones the caller
 * can open), and `counts.linked` on that answer only. The default answer
 * keeps its three count keys, byte-compatible for darth-cli.
 *
 * Owner only, by construction (invariant I2): there is no form of this
 * route that lists anyone else's recording, and no parameter that asks.
 * `mine=1` is required so that stays spelled out at every call site.
 */
export const GET = withAuth(async ({ user, request }) => {
  const parsed = parseRecordingsPageQuery(request.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await listOwnRecordingsSurface(user, parsed.query));
  } catch (err) {
    if (err instanceof RecordingsRegexError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});

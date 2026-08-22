import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getGoogleAccount } from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { listMeetRecordRows } from '@/lib/server/meeting-discovery';
import type { MeetRecordsResponse } from '@/lib/meeting-discovery-types';

export const runtime = 'nodejs';

const MEET_CODE_RE = /([a-z]{3}-[a-z]{4}-[a-z]{3})/i;

/**
 * GET /api/meet/records?days=30   — conferences the caller was in (Meet API,
 *                                   no calendar titles) = the dialog's
 *                                   "Recent 30d" tab.
 * GET /api/meet/records?code=abc-defg-hij — every record for a pasted link.
 *
 * Artifacts are NOT inventoried here (rows come back `meet.checked=false`);
 * POST /api/meet/evidence resolves a row when it is picked. Caller's own
 * server-minted token; 404 when Google isn't connected; 502 when the Meet
 * API refused the listing (distinct from "no records", D5).
 */
export const GET = withAuth(async ({ user, request }) => {
  const sp = request.nextUrl.searchParams;
  const codeRaw = sp.get('code');
  const code = codeRaw ? (MEET_CODE_RE.exec(codeRaw)?.[1]?.toLowerCase() ?? null) : null;
  if (codeRaw && !code) {
    return NextResponse.json(
      { error: 'That doesn’t look like a Meet link or code (abc-defg-hij).' },
      { status: 400 }
    );
  }
  const days = Math.min(60, Math.max(1, Number(sp.get('days') ?? 30) || 30));

  const minted = await getServerAccessToken(user.userId);
  if (!minted) {
    const account = await getGoogleAccount(user.userId);
    return NextResponse.json(
      { connected: !!account, status: account?.status ?? null, error: 'Google account not connected' },
      { status: 404 }
    );
  }
  const rows = await listMeetRecordRows(
    minted.token,
    code ? { code } : { fromIso: new Date(Date.now() - days * 86_400_000).toISOString() }
  );
  if (!rows) {
    return NextResponse.json(
      { error: 'Meet API listing failed — Google refused or rate-limited the request.' },
      { status: 502 }
    );
  }
  const body: MeetRecordsResponse = { rows, checkedAt: new Date().toISOString() };
  return NextResponse.json(body);
});

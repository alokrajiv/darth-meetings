import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';

export const runtime = 'nodejs';

/**
 * POST /api/gmeet/check
 * Body: { meetings: Array<{ code, startTime? }> } (max 100).
 * Legacy body { meetingCodes: string[] } still accepted (code-only match).
 *
 * Cross-USER dedupe check for the sync list: which of these meeting
 * OCCURRENCES has anyone already imported? startTime scopes the match to
 * the specific date — recurring meetings share one code across the whole
 * series. Response is keyed `${code}|${startTime ?? ''}` (bare code for
 * legacy requests) and includes whether the caller can open it and
 * (best-effort) who owns it. Deliberately exposes only owner email +
 * title — enough for a "synced by X" marker.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    meetings?: Array<{ code?: string; startTime?: string | null }>;
    meetingCodes?: string[];
  } | null;
  const legacy = !body?.meetings;
  const meetings = (
    body?.meetings ??
    (body?.meetingCodes ?? []).map((code) => ({ code, startTime: null }))
  )
    .filter((m) => typeof m?.code === 'string' && m.code.trim().length > 0)
    .slice(0, 100)
    .map((m) => ({
      code: m.code!.trim(),
      startTime: typeof m.startTime === 'string' ? m.startTime : null,
    }));
  if (meetings.length === 0) return NextResponse.json({ imported: {} });

  const rows = await findImportedByMeetingCodes(meetings, {
    userId: user.userId,
    email: user.email,
  });
  const imported: Record<
    string,
    {
      assemblyaiId: string | null;
      title: string | null;
      ownerEmail: string | null;
      accessible: boolean;
      mine: boolean;
    }
  > = {};
  meetings.forEach((m, i) => {
    const r = rows[i];
    if (!r) return;
    const key = legacy ? m.code : `${m.code}|${m.startTime ?? ''}`;
    imported[key] = {
      // Don't leak the transcript id unless the caller can actually open it.
      assemblyaiId: r.accessible ? r.assemblyai_id : null,
      title: r.accessible ? r.title : null,
      ownerEmail: r.owner_email,
      accessible: r.accessible,
      mine: r.mine,
    };
  });
  return NextResponse.json({ imported });
});

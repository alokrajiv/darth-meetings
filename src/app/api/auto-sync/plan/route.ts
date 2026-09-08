import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { explainOccurrence } from '@/lib/server/auto-import-plan';
import { callerInvolvedCodes, latestPastOccurrenceStart } from '@/db-ops/calendar-event-cache';
import { getMeetingById, resolveMeetingByAnyTranscriptId } from '@/db-ops/meetings';
import { teamsCacheCode } from '@/lib/server/teams-ids';

export const runtime = 'nodejs';

/**
 * GET /api/auto-sync/plan?code=<meet-code|teams-…>[&start=<iso>]  |  ?uuid=<meeting uuid | transcript id>
 *
 * "What will automation do with this meeting, and what did it do?" — the
 * resolver's answer (owner, importer, mode, report, watchers, why) plus the
 * ledger row, for one occurrence. `start` omitted → the latest past
 * occurrence of that code in anyone's calendar cache.
 *
 * PRIVACY: caller must be involved in the occurrence (callerInvolvedCodes —
 * the same gate the calendar listing uses); the answer names colleagues'
 * settings only for meetings the caller was in.
 */
export const GET = withAuth(async ({ user, request }) => {
  const params = new URL(request.url).searchParams;
  let code = params.get('code')?.trim() ?? '';
  let start = params.get('start')?.trim() ?? '';
  const uuid = params.get('uuid')?.trim() ?? '';
  if (uuid) {
    // /m/<uuid> id first, else a transcript id (/transcript/<id>, current or former).
    const m = (await getMeetingById(uuid)) ?? (await resolveMeetingByAnyTranscriptId(uuid));
    if (!m) return NextResponse.json({ error: 'Unknown meeting / transcript uuid' }, { status: 404 });
    if (!m.occ_start || !m.provider_key) {
      return NextResponse.json({ error: 'That meeting row has no occurrence identity (uploaded / pre-036 row)' }, { status: 422 });
    }
    code = m.provider === 'teams' ? teamsCacheCode(m.provider_key) : m.provider_key;
    start = new Date(m.occ_start).toISOString();
  }
  if (!code) return NextResponse.json({ error: 'code (or uuid) is required' }, { status: 400 });
  if (!start) {
    const latest = await latestPastOccurrenceStart(code);
    if (!latest) return NextResponse.json({ error: 'No past occurrence of that code in any calendar cache — pass start=<iso>' }, { status: 404 });
    start = latest;
  }
  if (Number.isNaN(Date.parse(start))) return NextResponse.json({ error: 'start must be an ISO instant' }, { status: 400 });
  const caller = { userId: user.userId, email: user.email };
  const involved = await callerInvolvedCodes(caller, [{ code, instant: start }]);
  if (!involved.has(code)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const out = await explainOccurrence(code, start);
  if (!out) return NextResponse.json({ error: 'Bad start' }, { status: 400 });
  return NextResponse.json(out);
});

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { alignRecordings } from '@/lib/server/align';
import { combineFlagOn } from '@/db-ops/clips';
import { combineRefusal, type AlignRequest } from '@/lib/clips';

export const runtime = 'nodejs';
/** Decoding two multi-hour envelopes is minutes, not seconds. */
export const maxDuration = 800;

const RECORDING_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/recordings/:id/align — "line these two up"
 * (docs/recordings-phase3b-combine-spec.md §"The offset — never guessed
 * silently"; behind `MW_COMBINE`).
 *
 * Body (`AlignRequest` in lib/clips.ts):
 *   { against: <recordingId>, nominalOffsetMs?, searchWindowMs? }
 * Answer (`AlignOk`): `offsetMs` — how far `:id` starts AFTER `against` — plus
 * a `confidence`, the measured clock `driftPpm`, and the `advice` sentence for
 * a weak match.
 *
 * NOTHING IS APPLIED. The number is shown with the two envelopes overlaid and
 * a nudge control; "Use this offset" is the person's click, and that click is
 * a `PATCH …/clips/:ord`. Below 0.4 the honest answer is "could not line these
 * up — set the offset by ear".
 *
 * PRIVACY: both recordings must be reachable by the caller — owned, or
 * reached through a meeting they can EDIT — which `alignRecordings` checks
 * through the same caller-scoped query the candidate list uses. A recording
 * they cannot reach is 404, never 403, so this is not an existence oracle.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  if (!combineFlagOn()) {
    const refusal = combineRefusal('disabled');
    return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 404 });
  }
  if (!RECORDING_ID_RE.test(id ?? '')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const raw = (await request.json().catch(() => null)) as AlignRequest | null;
  const against = typeof raw?.against === 'string' ? raw.against.trim() : '';
  if (!RECORDING_ID_RE.test(against)) {
    return NextResponse.json({ error: 'A recording to line up against is required.' }, { status: 400 });
  }

  const out = await alignRecordings({
    caller: { userId: user.userId, email: user.email },
    recordingId: id,
    againstRecordingId: against,
    nominalOffsetMs: typeof raw?.nominalOffsetMs === 'number' ? raw.nominalOffsetMs : null,
    searchWindowMs: typeof raw?.searchWindowMs === 'number' ? raw.searchWindowMs : null,
  });
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body);
});

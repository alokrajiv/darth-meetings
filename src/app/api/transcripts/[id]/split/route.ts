import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { parseTimestampMs, splitRefusal, type SplitRequest } from '@/lib/clips';
import { splitMeeting } from '@/lib/server/clip-split';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/split — editors only.
 *
 * "From when Paola joined until she left is its own meeting." A window of
 * this meeting becomes a second meeting on the same recording: no file is
 * cut, nothing is re-transcribed (DEC-2), and by default this meeting keeps
 * its own timeline with a HOLE where the window was, so every `t:<ms>` and
 * `frame:<ms>` already written into its notes still points at the right
 * moment.
 *
 * Body (`SplitRequest` in lib/clips.ts, the shared wire contract):
 *   { fromMs, toMs } in MEETING ms, or `{ from: "12:40", to: "41:05" }` for
 *   darth-cli and a typed field; `title`, `eventRef`, `keepInBoth`.
 * The ms fields win when both are sent.
 *
 * Every refusal carries a `code` from `SplitRefusalCode` so the dialog can
 * grey out "Split" for exactly the reasons the server would refuse for —
 * `validateSplitWindow` is the same pure function on both sides.
 */
export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const raw = (await request.json().catch(() => null)) as SplitRequest | null;
  const fromMs =
    typeof raw?.fromMs === 'number' ? parseTimestampMs(raw.fromMs) : parseTimestampMs(raw?.from);
  const toMs = typeof raw?.toMs === 'number' ? parseTimestampMs(raw.toMs) : parseTimestampMs(raw?.to);
  if (fromMs === null || toMs === null) {
    const refusal = splitRefusal(
      'window-invalid',
      'A start and an end are required (ms, or mm:ss / h:mm:ss).'
    );
    return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 400 });
  }

  const out = await splitMeeting({
    access,
    by: { userId: user.userId, email: user.email, name: user.name ?? null },
    fromMs,
    toMs,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 300) : null,
    eventRef: typeof raw?.eventRef === 'string' ? raw.eventRef : null,
    keepInBoth: raw?.keepInBoth === true,
  });
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body, { status: 201 });
});

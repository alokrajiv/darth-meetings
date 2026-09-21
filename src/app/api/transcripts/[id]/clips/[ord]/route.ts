import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { deleteClip, patchClip } from '@/lib/server/clip-combine';
import { parseTimestampMs, type PatchClipRequest } from '@/lib/clips';
import { isClipTextPolicy } from '@/lib/recording-clips';

export const runtime = 'nodejs';

/**
 * One clip of a meeting (Phase 3b,
 * docs/recordings-phase3b-combine-spec.md; behind `MW_COMBINE`).
 *
 *   PATCH  — move it on the timeline, re-window it, change what its text
 *            contributes (Text / Fill gaps only / Audio only).
 *   DELETE — un-combine. The RECORDING keeps existing (its own meeting, or
 *            the Recordings tab); only its membership of this meeting ends.
 *            Never the last clip: a meeting with no clip has no text and
 *            nothing to play.
 *
 * `:ord` is the clip's IDENTITY within the meeting, not its position (spec
 * §5a) — the timeline order is `offsetMs` then `ord`, so an ord never moves
 * when another clip is added in front of it.
 *
 * PRIVACY: gated on the MEETING (`resolveAccess`), editors only. Whose bytes
 * the clip holds does not enter into a PATCH or a DELETE — the owner already
 * gave them to this meeting by adding the clip, and taking a recording back
 * out of a meeting is something any editor may do.
 */
const ordOf = (raw: string): number | null => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && String(n) === raw.trim() ? n : null;
};

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id, ord: rawOrd } = await params;
  const ord = ordOf(rawOrd ?? '');
  if (ord === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const raw = (await request.json().catch(() => null)) as PatchClipRequest | null;
  const ms = (n: number | null | undefined, clock: string | undefined) =>
    typeof n === 'number' ? parseTimestampMs(n) : parseTimestampMs(clock);

  const offsetMs = ms(raw?.offsetMs, raw?.offset);
  const fromMs = ms(raw?.fromMs, raw?.from);
  // `toMs: null` is a real instruction ("to the end of the recording") and is
  // not the same as leaving it out.
  const toMs = raw?.toMs === null ? null : ms(raw?.toMs, raw?.to);

  const out = await patchClip({
    access,
    by: { userId: user.userId, email: user.email, name: user.name ?? null },
    ord,
    ...(offsetMs !== null ? { offsetMs } : {}),
    ...(fromMs !== null ? { fromMs } : {}),
    ...(raw?.toMs === null || toMs !== null ? { toMs } : {}),
    ...(isClipTextPolicy(raw?.textPolicy) ? { textPolicy: raw.textPolicy } : {}),
  });
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body);
});

export const DELETE = withAuth(async ({ user }, { params }) => {
  const { id, ord: rawOrd } = await params;
  const ord = ordOf(rawOrd ?? '');
  if (ord === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  const out = await deleteClip(
    access,
    { userId: user.userId, email: user.email, name: user.name ?? null },
    ord
  );
  if (!out.ok) return NextResponse.json(out.body, { status: out.status });
  return NextResponse.json(out.body);
});

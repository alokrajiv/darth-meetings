import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  deleteSeries,
  getSeries,
  listKeys,
  listMembers,
  listSuggestedMembers,
  updateSeries,
} from '@/db-ops/series';

export const runtime = 'nodejs';

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/series/:id — the series, its evidence keys, members (with
 * caller-visibility flags), and suggested members awaiting confirmation.
 */
export const GET = withAuth(async ({ user }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const caller = { userId: user.userId, email: user.email };
  const [keys, members, suggestions] = await Promise.all([
    listKeys(id),
    listMembers(id, caller),
    listSuggestedMembers(id, caller),
  ]);
  return NextResponse.json({ series, keys, members, suggestions });
});

/** PATCH /api/series/:id — rename / edit notes. */
export const PATCH = withAuth(async ({ request }, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const series = await getSeries(id);
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  let body: { title?: string; notes?: string | null };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const title = body.title?.trim();
  if (body.title !== undefined && !title) {
    return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 });
  }
  await updateSeries(id, { title, notes: body.notes });
  return NextResponse.json({ ok: true });
});

/** DELETE /api/series/:id — remove the series (members detach, transcripts
 * are untouched). */
export const DELETE = withAuth(async (_ctx, { params }) => {
  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  await deleteSeries(id);
  return NextResponse.json({ ok: true });
});

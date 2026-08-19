import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  addCalendarEventMute,
  listCalendarEventMutes,
  removeCalendarEventMute,
  type CalendarMuteKind,
} from '@/db-ops/calendar-event-cache';

export const runtime = 'nodejs';

/**
 * /api/calendar-mutes — per-user HIDE list for calendar-backed listing rows
 * (migration 023). Personal calendar blocks ("my lunch", focus time) aren't
 * real meetings; a mute removes them from both the norec and unimported
 * layers. Always caller-scoped — a mute only ever affects the user who set
 * it.
 *
 *  - kind='occurrence': value = the row's event_key (one occurrence).
 *  - kind='series':     value = recurring_event_id (event_id fallback for
 *    non-recurring events) — stable, so future occurrences the poller
 *    writes are hidden automatically.
 */

export interface CalendarMuteEntry {
  kind: CalendarMuteKind;
  value: string;
  title: string | null;
  createdAt: string;
}

export interface CalendarMutesResponse {
  mutes: CalendarMuteEntry[];
}

const MAX_VALUE_LEN = 512;

function parseKind(raw: unknown): CalendarMuteKind | null {
  return raw === 'occurrence' || raw === 'series' ? raw : null;
}

function parseValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_VALUE_LEN) return null;
  return value;
}

export const GET = withAuth(async ({ user }) => {
  const rows = await listCalendarEventMutes(user.userId);
  const body: CalendarMutesResponse = {
    mutes: rows.map((r) => ({
      kind: r.kind,
      value: r.value,
      title: r.title,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
  return NextResponse.json(body);
});

export const POST = withAuth(async ({ user, request }) => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { kind: rawKind, value: rawValue, title: rawTitle } =
    (payload ?? {}) as Record<string, unknown>;
  const kind = parseKind(rawKind);
  const value = parseValue(rawValue);
  if (!kind || !value) {
    return NextResponse.json(
      {
        error: `Expected { kind: 'occurrence'|'series', value: non-empty string ≤${MAX_VALUE_LEN} chars, title? }`,
      },
      { status: 400 }
    );
  }
  const title =
    typeof rawTitle === 'string' && rawTitle.trim().length > 0
      ? rawTitle.trim().slice(0, 512)
      : null;
  await addCalendarEventMute(user.userId, kind, value, title);
  return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = withAuth(async ({ user, request }) => {
  const params = request.nextUrl.searchParams;
  const kind = parseKind(params.get('kind'));
  const value = parseValue(params.get('value'));
  if (!kind || !value) {
    return NextResponse.json(
      { error: 'Expected ?kind=occurrence|series&value=…' },
      { status: 400 }
    );
  }
  await removeCalendarEventMute(user.userId, kind, value);
  return NextResponse.json({ ok: true });
});

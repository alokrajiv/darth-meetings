import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { insertRecorderEvents, type RecorderEventInput } from '@/db-ops/recorder';

export const runtime = 'nodejs';

/** The tray batches its events.jsonl tail; anything above this is a bug or a
 * backlog replay that should be split. */
const MAX_EVENTS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/recorder/events
 * `{device_id, events:[{ts, kind, payload}…]}` → bulk insert → `{accepted}`.
 * More than 500 events in one call → 413 (the tray must chunk).
 *
 * Telemetry only: rows are owned by the caller and never served back to the
 * UI. Malformed entries (no kind, unparseable ts) are dropped rather than
 * failing the batch — losing one log line must never stop the tray shipping
 * the rest.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const raw = body.events;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: 'events must be an array' }, { status: 400 });
  }
  if (raw.length > MAX_EVENTS) {
    return NextResponse.json(
      { error: `Too many events (${raw.length} > ${MAX_EVENTS}) — send them in batches`, max: MAX_EVENTS },
      { status: 413 }
    );
  }

  const deviceIdRaw = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  const deviceId = UUID_RE.test(deviceIdRaw) ? deviceIdRaw : null;

  const now = Date.now();
  const events: RecorderEventInput[] = [];
  let dropped = 0;
  for (const e of raw) {
    if (!e || typeof e !== 'object') {
      dropped++;
      continue;
    }
    const o = e as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind.trim().slice(0, 80) : '';
    if (!kind) {
      dropped++;
      continue;
    }
    const tsRaw = typeof o.ts === 'string' ? Date.parse(o.ts) : typeof o.ts === 'number' ? o.ts : NaN;
    const ts = Number.isFinite(tsRaw) ? new Date(tsRaw).toISOString() : new Date(now).toISOString();
    events.push({
      ts,
      kind,
      payload: o.payload === undefined ? null : o.payload,
    });
  }

  const accepted = await insertRecorderEvents(user.userId, deviceId, events);
  return NextResponse.json({ accepted, dropped });
});

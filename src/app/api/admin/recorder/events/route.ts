import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth/with-admin-auth';
import { listRecorderEventsForAdmin } from '@/db-ops/recorder';
import { NOISY_EVENT_KINDS, parseKinds } from '@/lib/recorder-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /api/admin/recorder/events?device_id=<uuid>&limit=<n ≤ 200>&kinds=<csv>
 * — one tray's recent telemetry events, newest first (super-admin only,
 * `access` module; everyone else 404).
 *
 * Without `kinds` the two 60 s samplers (resource_sample, process_sample) are
 * left out; naming them in `kinds` brings them back. Payloads are returned as
 * the tray sent them — window titles appear only when that tray's telemetry
 * level was `full` (the tray decides). Never frames or file contents.
 *
 * → `{ device_id, events: [{id, ts, kind, payload, received_at}] }`
 */
export const GET = withAdminAuth(async ({ request }) => {
  const url = new URL(request.url);
  const deviceId = url.searchParams.get('device_id')?.trim() ?? '';
  if (!UUID_RE.test(deviceId)) {
    return NextResponse.json({ error: 'device_id must be a uuid' }, { status: 400 });
  }
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const kinds = parseKinds(url.searchParams.get('kinds'));

  const rows = await listRecorderEventsForAdmin(deviceId.toLowerCase(), {
    limit,
    kinds,
    excludeKinds: NOISY_EVENT_KINDS,
  });
  return NextResponse.json(
    {
      device_id: deviceId.toLowerCase(),
      events: rows.map((e) => ({
        id: e.id,
        ts: e.ts instanceof Date ? e.ts.toISOString() : e.ts,
        kind: e.kind,
        payload: e.payload,
        received_at: e.received_at instanceof Date ? e.received_at.toISOString() : e.received_at,
      })),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
});

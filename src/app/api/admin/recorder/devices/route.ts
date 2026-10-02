import { NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/auth/with-admin-auth';
import {
  listRecorderDevicesForAdmin,
  recentRecordingsForAdmin,
  recordingProgressForAdmin,
  type AdminRecentRecordingRow,
} from '@/db-ops/recorder';
import { buildAdminDevice, currentRecordingRef, isLive } from '@/lib/recorder-admin';
import { latestAppVersion } from '@/lib/server/recorder-version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/recorder/devices — darth-admin › Recorder (super-admin only,
 * `access` module; everyone else 404).
 *
 * Every Darth Recorder tray, newest heartbeat first: who, which Mac, which
 * version (vs the published one), live / state, what it is recording right
 * now (source, parts, bytes, call app), upload / share in flight, pending
 * uploads, disk on the Mac (`local_disk`, tray ≥ 0.3.22), telemetry level,
 * resources, unclean exits in 7 d and the last 5 recordings. Metadata only —
 * no frames, no file contents. Shaped by lib/recorder-admin.ts.
 *
 * Three queries whatever the fleet size (devices, in-flight progress,
 * recent recordings) + the cached version feed.
 */
export const GET = withAdminAuth(async () => {
  const now = Date.now();
  const [rows, latest] = await Promise.all([listRecorderDevicesForAdmin(), latestAppVersion()]);

  const inflight = rows.flatMap((d) => {
    const ref = currentRecordingRef(d, isLive(d, now));
    return ref ? [{ device_id: d.device_id, recording_id: ref.recording_id, since: ref.started_at }] : [];
  });
  const [progress, recent] = await Promise.all([
    recordingProgressForAdmin(inflight),
    recentRecordingsForAdmin(rows.map((d) => d.device_id)),
  ]);
  const progressByDevice = new Map(progress.map((p) => [p.device_id, p]));
  const recentByDevice = new Map<string, AdminRecentRecordingRow[]>();
  for (const r of recent) {
    if (!r.device_id) continue;
    const list = recentByDevice.get(r.device_id) ?? [];
    list.push(r);
    recentByDevice.set(r.device_id, list);
  }

  const devices = rows.map((d) =>
    buildAdminDevice(d, {
      nowMs: now,
      latestVersion: latest,
      progress: progressByDevice.get(d.device_id) ?? null,
      recent: recentByDevice.get(d.device_id) ?? [],
    })
  );

  return NextResponse.json(
    { latest_app_version: latest, server_time: new Date(now).toISOString(), devices },
    { headers: { 'cache-control': 'no-store' } }
  );
});

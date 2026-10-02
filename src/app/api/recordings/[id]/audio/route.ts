import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getRecordingForOwner } from '@/db-ops/recordings';
import { standaloneMedia } from '@/db-ops/standalone-recordings';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { ensureAudioOnly } from '@/lib/server/audio-only';
import { proxyBlobRange, serveStore } from '@/lib/server/media-serve';
import { streamLocalMedia } from '@/lib/server/media-stream';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /api/recordings/:id/audio[?part=N][&variant=audio]` — a recording's
 * bytes (design P7 risk §6.1: playback of an unclaimed recording needs a
 * route keyed on the RECORDING; the meeting media routes are untouched).
 *
 * REACHABILITY — the OWNER only (`recordings.owner_user_id`), like every
 * `/api/recordings/*` route. Anyone else is 404 — the same answer as for an
 * id that does not exist, so this is not an oracle (invariant I2).
 *
 * A meeting holding a clip on this recording does NOT open this route to the
 * people that meeting is shared with (owner, 2026-10-02: "it is not the
 * recording being shared and the recording API shouldn't reply — it's the
 * meeting API that reveals it"). Until then a meeting's readers reached the
 * WHOLE recording here, even the minutes outside the meeting's clip window.
 * They play the meeting through `/api/transcripts/:id/audio` instead.
 *
 * `?part=N` uses the player's numbering (1 = the canonical file, 2… the
 * parts); `?variant=audio` serves the 64 kbps extract when one exists.
 */
export const GET = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  if (!id || !UUID_RE.test(id)) return notFound();

  const own = await getRecordingForOwner(user.userId, id).catch(() => null);
  if (!own) return notFound();

  const media = (await standaloneMedia(id)).filter((m) => m.kind === 'canonical' || m.kind === 'part');
  const partNo = Number.parseInt(request.nextUrl.searchParams.get('part') ?? '1', 10);
  const target = Number.isInteger(partNo) && partNo >= 1 ? media[partNo - 1] : undefined;
  if (!target?.filename) {
    return NextResponse.json({ error: 'Audio not available' }, { status: 404 });
  }

  const range = request.headers.get('range');
  if (request.nextUrl.searchParams.get('variant') === 'audio') {
    const extract = await ensureAudioOnly(target.filename);
    if (extract.status === 'preparing') {
      return NextResponse.json({ preparing: true }, { status: 202, headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (extract.status === 'ready') {
      const res = await streamLocalMedia(range, extract.path, extract.derived ? 'audio/mp4' : undefined);
      if (res) return res;
    }
  }

  let abs: string | null = null;
  try {
    abs = resolveAudioPath(target.filename);
  } catch {
    abs = null;
  }
  const local = abs ? await streamLocalMedia(range, abs) : null;
  if (local) return local;

  const store = serveStore();
  if (store && target.blob_name) {
    const proxied = await proxyBlobRange(
      store,
      { blobName: target.blob_name, filename: target.filename, bytes: null },
      range
    );
    if (proxied) return proxied;
  }
  return NextResponse.json({ error: 'Audio file missing' }, { status: 404 });
});

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

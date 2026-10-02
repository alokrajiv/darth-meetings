import { NextResponse } from 'next/server';
import { promises as fsp } from 'node:fs';
import { withAuth } from '@/lib/auth/with-auth';
import { getOfflinePrefs, type OfflinePrefs } from '@/db-ops/user-prefs';
import { listOfflinePlanRows, type OfflinePlanRow } from '@/db-ops/offline-plan';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { hasVideoStream } from '@/lib/server/video-frames';
import { resolveMediaForMeetings, type ResolvedMedia } from '@/lib/server/recordings';

export const runtime = 'nodejs';

/**
 * GET /api/offline/plan[?ids=<csv of assemblyai_ids>]
 *
 * What a device should keep offline for this account, and what it needs to
 * know to fetch each meeting:
 *   - without `ids`: the caller's newest completed meetings, as many as the
 *     largest of the three auto-pin counts (the client applies the
 *     transcript / audio / video ladder itself);
 *   - with `ids`: exactly those meetings, if still visible. An id that is
 *     absent from the answer is no longer available to the caller (deleted,
 *     unshared, or never theirs) and the client unpins it.
 * Every row carries `rev` (page-content fingerprint) and the stored media
 * parts with sizes so the client can budget downloads and detect staleness.
 * `buildId` lets the client notice a deploy.
 *
 * The web app no longer consumes this (its offline mode was removed
 * 2026-10-02 — README "Offline and PWA — removed 2026-10-02"). Callers:
 * darth-cli `offline plan` (cli-subcommand-src/index.ts) and, later, the
 * desktop shell's offline replica.
 */

const MAX_IDS = 200;
const ID_RE = /^[A-Za-z0-9._-]+$/;
/** ffprobe fan-out for primaries not yet in hasVideoStream's cache. */
const PROBE_CONCURRENCY = 6;

export interface PlanMeetingPart {
  /** `?part=N` as the audio route numbers it: 1 = the canonical recording,
   * N >= 2 = the extra files, in capture order. */
  part: number;
  filename: string;
  isVideo: boolean;
  /** Stored size, null when the file is missing on disk. */
  bytes: number | null;
}

export interface PlanMeeting {
  /** assemblyai_id */
  id: string;
  title: string | null;
  recordedAt: string | null;
  createdAt: string;
  durationSec: number | null;
  provider: 'gmeet' | 'teams' | null;
  rev: string;
  media: {
    /** A primary recording is stored on the server (and present on disk). */
    hasLocal: boolean;
    /** The primary recording carries a video stream. */
    isVideo: boolean;
    parts: PlanMeetingPart[];
  };
}

export interface OfflinePlanResponse {
  prefs: OfflinePrefs;
  buildId: string;
  meetings: PlanMeeting[];
}

export const GET = withAuth(async ({ user, request }) => {
  const rawIds = request.nextUrl.searchParams.get('ids');
  let ids: string[] | null = null;
  if (rawIds !== null) {
    ids = Array.from(new Set(rawIds.split(',').map((s) => s.trim()).filter(Boolean)));
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `At most ${MAX_IDS} ids per request` }, { status: 400 });
    }
    const bad = ids.find((id) => !ID_RE.test(id));
    if (bad !== undefined) {
      return NextResponse.json({ error: 'Invalid id in ids' }, { status: 400 });
    }
  }

  const prefs = await getOfflinePrefs(user.userId);
  const limit = Math.max(prefs.transcripts, prefs.audio, prefs.video);

  const rows = await listOfflinePlanRows(
    user.userId,
    user.email,
    ids !== null ? { ids } : { limit }
  );
  // One media resolve for the whole page, not one per meeting: the plan is
  // asked for up to 200 ids at a time. The plan row is skinny, so the
  // fallback path gets the two columns it reads (the offsets the resolver
  // would compute from `actuals` are not part of the plan).
  const media = await resolveMediaForMeetings(
    rows.map((r) => ({
      id: r.id,
      duration: r.duration,
      local_audio_path: r.local_audio_path,
      gmeet_context: { videoParts: Array.isArray(r.video_parts) ? r.video_parts : undefined },
    }))
  );
  const meetings = await mapLimit(rows, PROBE_CONCURRENCY, (row) =>
    toPlanMeeting(row, media.get(row.id) ?? [])
  );

  const body: OfflinePlanResponse = {
    prefs,
    buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev',
    meetings,
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
});

async function toPlanMeeting(
  row: OfflinePlanRow,
  media: ResolvedMedia[]
): Promise<PlanMeeting> {
  const parts: PlanMeetingPart[] = [];
  let hasLocal = false;
  let isVideo = false;

  // No canonical file ⇒ nothing to pin, and the extra files are not offered
  // on their own (they are only playable next to the primary).
  const canonical = media.find((m) => m.part === 1);
  if (canonical) {
    const bytes = await storedBytes(canonical.filename);
    hasLocal = bytes !== null;
    // ffprobe-backed (cached per filename): the stored extension is only a
    // hint for the primary — Drive names arrive without one.
    isVideo = hasLocal ? await hasVideoStream(canonical.filename) : false;
    parts.push({ part: 1, filename: canonical.filename, isVideo, bytes });

    // Part numbers are positional, so a file whose bytes haven't landed yet
    // is absent from the resolver's media rather than renumbering the rest.
    for (const m of media) {
      if (m.part === 1) continue;
      parts.push({
        part: m.part,
        filename: m.filename,
        isVideo: m.isVideo === true,
        bytes: await storedBytes(m.filename),
      });
    }
  }

  return {
    id: row.assemblyai_id,
    title: row.title,
    recordedAt: row.recorded_at ? new Date(row.recorded_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    durationSec: row.duration,
    provider: row.provider,
    rev: row.rev,
    media: { hasLocal, isVideo, parts },
  };
}

async function storedBytes(filename: string): Promise<number | null> {
  try {
    const st = await fsp.stat(resolveAudioPath(filename));
    return st.size;
  } catch {
    return null;
  }
}

/** Order-preserving map with bounded concurrency (no deps). */
async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

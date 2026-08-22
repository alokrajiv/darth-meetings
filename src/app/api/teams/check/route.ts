import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { parseTeamsJoinLink, isOwnTenant } from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';

export const runtime = 'nodejs';

/**
 * POST /api/teams/check — Teams twin of /api/gmeet/check.
 * Body: { events: Array<{ url, startTime?, endTime? }> } (max 100), where
 * `url` is the RAW Teams link found on the calendar event (canonicalization
 * happens here).
 *
 * Returns `results` aligned by index. Cache-first and cheap: no Graph calls
 * in this path — artifact presence comes from the poller's metadata cache,
 * dedupe from the indexed gmeet_context->'teams' lookups. External-tenant
 * events are flagged (the dialog renders them as guided manual import, spec
 * §10.1) and never resolved.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    events?: Array<{ url?: string; startTime?: string | null; endTime?: string | null }>;
  } | null;
  const events = (body?.events ?? [])
    .slice(0, 100)
    .map((e) => ({
      url: typeof e?.url === 'string' ? e.url : '',
      startTime: typeof e?.startTime === 'string' ? e.startTime : null,
    }));
  if (events.length === 0) return NextResponse.json({ results: [] });

  const parsed = events.map((e) => (e.url ? parseTeamsJoinLink(e.url) : null));

  const dedupeQueries: Array<{ joinWebUrl: string; startTime: string | null }> = [];
  const cacheQueries: Array<{ code: string; startTime: string | null }> = [];
  const queryIndex: number[] = []; // position in dedupe/cache arrays per event
  parsed.forEach((p, i) => {
    if (p && isOwnTenant(p)) {
      queryIndex.push(dedupeQueries.length);
      dedupeQueries.push({ joinWebUrl: p.joinWebUrl, startTime: events[i]!.startTime });
      cacheQueries.push({ code: teamsCacheCode(p.joinWebUrl), startTime: events[i]!.startTime });
    } else {
      queryIndex.push(-1);
    }
  });

  const [imported, cacheRows] = await Promise.all([
    findImportedByTeamsMeetings(dedupeQueries, { userId: user.userId, email: user.email }).catch(
      (err) => {
        console.warn('[teams/check] dedupe lookup failed:', err);
        return dedupeQueries.map(() => null);
      }
    ),
    getMeetingCacheByMeetings(cacheQueries).catch(() => cacheQueries.map(() => null)),
  ]);

  const results = parsed.map((p, i) => {
    if (!p) return null; // not a parseable Teams link
    const external = !isOwnTenant(p);
    if (external) {
      return { external: true as const, tenantId: p.tenantId };
    }
    const qi = queryIndex[i]!;
    const dupe = imported[qi] ?? null;
    const cache = cacheRows[qi] ?? null;
    return {
      external: false as const,
      /** `teams-<hash>` — the mute/reminder key the client can't compute
       * itself (server-side sha256 of the canonical URL). */
      code: teamsCacheCode(p.joinWebUrl),
      imported: dupe
        ? {
            assemblyaiId: dupe.accessible ? dupe.assemblyai_id : null,
            title: dupe.accessible ? dupe.title : null,
            ownerEmail: dupe.owner_email,
            accessible: dupe.accessible,
            mine: dupe.mine,
          }
        : null,
      meta: cache
        ? {
            hasTranscript: cache.transcript_parseable === true,
            hasRecording: cache.ready_recording_count > 0,
            utteranceCount: cache.utterance_count,
            wordCount: cache.word_count,
            speakers: cache.speakers,
            videoDurationMs: cache.video_duration_ms,
            confStart: cache.conf_start,
            confEnd: cache.conf_end,
          }
        : null,
    };
  });

  return NextResponse.json({ results });
});

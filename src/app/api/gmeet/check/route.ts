import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';
import { callerInvolvedCodes } from '@/db-ops/calendar-event-cache';

export const runtime = 'nodejs';

/**
 * POST /api/gmeet/check
 * Body: { meetings: Array<{ code, startTime? }> } (max 100).
 * Legacy body { meetingCodes: string[] } still accepted (code-only match).
 *
 * Cross-USER dedupe check for the sync list: which of these meeting
 * OCCURRENCES has anyone already imported? startTime scopes the match to
 * the specific date — recurring meetings share one code across the whole
 * series. Response is keyed `${code}|${startTime ?? ''}` (bare code for
 * legacy requests) and includes whether the caller can open it and
 * (best-effort) who owns it. Deliberately exposes only owner email +
 * title — enough for a "synced by X" marker.
 *
 * Also returns `meta` — the poller's metadata cache for these occurrences
 * (duration, size, turn/word counts, transcript-parseable flag), keyed the
 * same way. Display-only enrichment: the IDs in it never grant access, every
 * import still goes through the caller's own Google token.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    meetings?: Array<{ code?: string; startTime?: string | null }>;
    meetingCodes?: string[];
  } | null;
  const legacy = !body?.meetings;
  const meetings = (
    body?.meetings ??
    (body?.meetingCodes ?? []).map((code) => ({ code, startTime: null }))
  )
    .filter((m) => typeof m?.code === 'string' && m.code.trim().length > 0)
    .slice(0, 100)
    .map((m) => ({
      code: m.code!.trim(),
      startTime: typeof m.startTime === 'string' ? m.startTime : null,
    }));
  if (meetings.length === 0) return NextResponse.json({ imported: {}, meta: {} });

  const [rows, cacheRows, involved] = await Promise.all([
    findImportedByMeetingCodes(meetings, {
      userId: user.userId,
      email: user.email,
    }),
    getMeetingCacheByMeetings(meetings).catch(() => meetings.map(() => null)),
    // PRIVACY GATE (2026-08-24): codes are client-supplied and the cache is
    // global — without this, any authed user harvests conf times / Drive
    // ids / speaker counts / owner emails for arbitrary meeting codes.
    callerInvolvedCodes(
      user,
      meetings.map((m) => ({ code: m.code, instant: m.startTime }))
    ).catch(() => new Set<string>()),
  ]);
  const email = user.email.toLowerCase();
  const imported: Record<
    string,
    {
      assemblyaiId: string | null;
      title: string | null;
      ownerEmail: string | null;
      accessible: boolean;
      mine: boolean;
    }
  > = {};
  const meta: Record<
    string,
    {
      conferenceRecord: string | null;
      confStart: string | null;
      confEnd: string | null;
      recordingCount: number;
      videoFileId: string | null;
      videoSize: number | null;
      videoDurationMs: number | null;
      transcriptDocIds: string[] | null;
      transcriptParseable: boolean | null;
      utteranceCount: number | null;
      wordCount: number | null;
      speakerCount: number | null;
      /** Classified evidence (migration 026) — prefer these over raw counts:
       * recordingCount counts listed entries, files or not (D4). */
      readyRecordingCount: number;
      recordingState: string | null;
      transcriptState: string | null;
      transcriptSource: string | null;
    }
  > = {};
  meetings.forEach((m, i) => {
    const key = legacy ? m.code : `${m.code}|${m.startTime ?? ''}`;
    const c = cacheRows[i];
    // Involved = calendar evidence, or the cache row itself names the
    // caller as organizer (the cache-only arm).
    const ok =
      involved.has(m.code) || (c?.organizer_email && c.organizer_email.toLowerCase() === email);
    const r = rows[i];
    if (r) {
      imported[key] = {
        // Don't leak the transcript id unless the caller can actually open it.
        assemblyaiId: r.accessible ? r.assemblyai_id : null,
        title: r.accessible ? r.title : null,
        // "synced by X" only when the caller can open it or was in the room.
        ownerEmail: r.accessible || ok ? r.owner_email : null,
        accessible: r.accessible,
        mine: r.mine,
      };
    }
    if (c && ok) {
      meta[key] = {
        conferenceRecord: c.conference_record,
        confStart: c.conf_start,
        confEnd: c.conf_end,
        recordingCount: c.recording_count,
        videoFileId: c.video_file_id,
        videoSize: c.video_size,
        videoDurationMs: c.video_duration_ms,
        transcriptDocIds: c.transcript_doc_ids,
        transcriptParseable: c.transcript_parseable,
        utteranceCount: c.utterance_count,
        wordCount: c.word_count,
        speakerCount: c.speakers?.length ?? null,
        readyRecordingCount: c.ready_recording_count,
        recordingState: c.recording_state,
        transcriptState: c.transcript_state,
        transcriptSource: c.transcript_source,
      };
    }
  });
  return NextResponse.json({ imported, meta });
});

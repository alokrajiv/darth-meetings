import { findCalendarEventForImport } from '@/db-ops/calendar-event-cache';
import { getTeamsJoinUrlByMeeting } from '@/db-ops/gmeet-meeting-cache';
import type { LinkedEventInput } from '@/lib/server/upload-pipeline';

/**
 * Headless "which calendar event do you mean" resolution — the CLI's
 * `upload --event <ref>` / `link <id> <ref>` verbs and any agent that only
 * holds a reference, not a browser Google token.
 *
 * `ref` is either an exact event key ('<eventId>|<startIso>', the `key` of
 * every `GET /api/calendar/events` row — the unambiguous form, works for
 * events WITHOUT a meeting link too) or a meeting code (the `[code]` shown
 * by `calendar`; resolves to the caller's latest PAST occurrence of that
 * code, same rule as `POST /api/meetings/import`).
 *
 * Only the CALLER's own calendar cache is consulted (per-user rows from
 * their own sweeps — involvement implicit, same privacy stance as the
 * calendar layers). Teams occurrences additionally carry the join URL a
 * past probe stashed so link-event can stamp the provider.
 */
export type LinkedEventRef = Omit<LinkedEventInput, 'attendees'> & {
  eventKey: string;
  teamsUrl?: string;
  /** Always email-bearing (cache rows never store anonymous attendees). */
  attendees: Array<{ email: string; name?: string; responseStatus?: string }>;
};

export type LinkedEventRefResult =
  | { ok: true; event: LinkedEventRef }
  | { ok: false; status: number; error: string };

export function parseEventRef(raw: string | null | undefined): {
  meetingCode?: string;
  eventKey?: string;
} | null {
  const ref = raw?.trim();
  if (!ref || ref.length > 512) return null;
  return ref.includes('|') ? { eventKey: ref } : { meetingCode: ref };
}

export async function resolveLinkedEventRef(
  userId: string,
  raw: string | null | undefined
): Promise<LinkedEventRefResult> {
  const ref = parseEventRef(raw);
  if (!ref) return { ok: false, status: 400, error: 'event reference required' };
  const row = await findCalendarEventForImport(userId, ref);
  if (!row) {
    return {
      ok: false,
      status: 404,
      error:
        'No such event in your calendar cache. Use the [meeting-code] or the exact event key from `darth-cli meetings calendar --view all --json` (the `key` field) — the event must be on YOUR calendar and, for a meeting code, already started.',
    };
  }
  const startIso = new Date(row.event_start).toISOString();
  const endIso = row.event_end ? new Date(row.event_end).toISOString() : undefined;
  const event: LinkedEventRef = {
    eventKey: row.event_key,
    id: row.event_id,
    title: row.title ?? undefined,
    startTime: startIso,
    endTime: endIso,
    meetingCode: row.meeting_code ?? undefined,
    recurringEventId: row.recurring_event_id ?? undefined,
    iCalUID: row.ical_uid ?? undefined,
    organizerEmail: row.organizer_email ?? undefined,
    attendees: (row.attendees ?? [])
      .filter((a) => typeof a.email === 'string' && a.email.length > 0)
      .map((a) => ({ email: a.email, name: a.displayName, responseStatus: a.responseStatus })),
  };
  if (row.meeting_code?.startsWith('teams-')) {
    const url = await getTeamsJoinUrlByMeeting(row.meeting_code, startIso);
    if (url) event.teamsUrl = url;
  }
  return { ok: true, event };
}

import type { GmeetAttendee, GmeetContext } from '@/lib/format';

/**
 * Calendar-event linkage riding along with an import — the same shape the
 * upload-media stepper sends via its `x-linked-event` header (and mirrors
 * the Meet-import event payload, so gmeet_context comes out identical
 * downstream: people context, speaker-ID hints, series attach, dedupe).
 */
export interface LinkedEventPayload {
  id?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  meetingCode?: string;
  recurringEventId?: string;
  iCalUID?: string;
  organizerEmail?: string;
  attendees?: Array<{ email: string; name?: string; responseStatus?: string }>;
}

/** Everything an ingest call needs to stamp the linkage — mirrors what
 * POST /api/transcripts builds into gmeet_context for uploaded media. */
export interface LinkedEventIngestFields {
  gmeetContext: GmeetContext;
  attendees: GmeetAttendee[];
  /** Meeting start — becomes created_at/recorded_at so the transcript
   * groups under the meeting's day, exactly like an uploaded recording. */
  recordedAtIso: string | null;
  /** Title fallback when the user/document didn't provide one. */
  eventTitle: string | null;
}

/**
 * Validate an untrusted client-supplied linked event down to the known
 * shape. Returns null when nothing identifying survives (so callers can
 * treat "garbage" and "absent" identically).
 */
export function sanitizeLinkedEvent(raw: unknown): LinkedEventPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  const iso = (v: unknown): string | undefined => {
    const s = str(v);
    return s && !Number.isNaN(Date.parse(s)) ? s : undefined;
  };
  const out: LinkedEventPayload = {
    id: str(e.id),
    title: str(e.title),
    startTime: iso(e.startTime),
    endTime: iso(e.endTime),
    meetingCode: str(e.meetingCode),
    recurringEventId: str(e.recurringEventId),
    iCalUID: str(e.iCalUID),
    organizerEmail: str(e.organizerEmail),
    attendees: Array.isArray(e.attendees)
      ? (e.attendees as Array<Record<string, unknown>>)
          .filter((a) => a && typeof a === 'object' && typeof a.email === 'string')
          .slice(0, 100)
          .map((a) => ({
            email: a.email as string,
            name: str(a.name),
            responseStatus: str(a.responseStatus),
          }))
      : [],
  };
  // Nothing that identifies an event → treat as absent.
  if (!out.id && !out.title && !out.startTime && !out.meetingCode && !out.iCalUID) {
    return null;
  }
  return out;
}

export function linkedEventIngestFields(linked: LinkedEventPayload): LinkedEventIngestFields {
  const attendees: GmeetAttendee[] = (linked.attendees ?? []).map((a) => ({
    email: a.email,
    name: a.name,
    responseStatus: a.responseStatus,
  }));
  return {
    gmeetContext: {
      eventId: linked.id,
      eventTitle: linked.title?.slice(0, 300),
      startTime: linked.startTime,
      endTime: linked.endTime,
      meetingCode: linked.meetingCode,
      recurringEventId: linked.recurringEventId,
      iCalUID: linked.iCalUID,
      organizerEmail: linked.organizerEmail,
      attendees,
    },
    attendees,
    recordedAtIso: linked.startTime ?? null,
    eventTitle: linked.title?.slice(0, 300) ?? null,
  };
}

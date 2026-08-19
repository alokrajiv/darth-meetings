import { describe, expect, test } from 'bun:test';
import {
  linkedEventIngestFields,
  sanitizeLinkedEvent,
} from '@/lib/server/linked-event';

describe('sanitizeLinkedEvent', () => {
  test('passes a full well-formed event through', () => {
    const out = sanitizeLinkedEvent({
      id: 'ev1',
      title: 'Weekly sync',
      startTime: '2026-08-19T10:00:00+08:00',
      endTime: '2026-08-19T10:30:00+08:00',
      meetingCode: 'abc-defg-hij',
      recurringEventId: 'rec1',
      iCalUID: 'uid@google.com',
      organizerEmail: 'a@x.com',
      attendees: [{ email: 'b@x.com', name: 'B', responseStatus: 'accepted' }],
    });
    expect(out).not.toBeNull();
    expect(out!.id).toBe('ev1');
    expect(out!.attendees).toEqual([
      { email: 'b@x.com', name: 'B', responseStatus: 'accepted' },
    ]);
  });

  test('drops invalid timestamps and attendee entries without email', () => {
    const out = sanitizeLinkedEvent({
      id: 'ev1',
      startTime: 'not-a-date',
      attendees: [{ name: 'no-email' }, { email: 'ok@x.com' }, 'junk', null],
    });
    expect(out!.startTime).toBeUndefined();
    expect(out!.attendees).toEqual([
      { email: 'ok@x.com', name: undefined, responseStatus: undefined },
    ]);
  });

  test('returns null for garbage and for events with nothing identifying', () => {
    expect(sanitizeLinkedEvent(null)).toBeNull();
    expect(sanitizeLinkedEvent('str')).toBeNull();
    expect(sanitizeLinkedEvent({})).toBeNull();
    expect(sanitizeLinkedEvent({ attendees: [{ email: 'a@x.com' }] })).toBeNull();
  });

  test('caps attendees at 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ email: `p${i}@x.com` }));
    const out = sanitizeLinkedEvent({ id: 'ev', attendees: many });
    expect(out!.attendees).toHaveLength(100);
  });
});

describe('linkedEventIngestFields', () => {
  test('mirrors the upload path gmeet_context stamping', () => {
    const fields = linkedEventIngestFields({
      id: 'ev1',
      title: 'T'.repeat(400),
      startTime: '2026-08-19T10:00:00+08:00',
      meetingCode: 'abc-defg-hij',
      attendees: [{ email: 'b@x.com', name: 'B' }],
    });
    expect(fields.gmeetContext.eventId).toBe('ev1');
    expect(fields.gmeetContext.eventTitle).toHaveLength(300);
    expect(fields.gmeetContext.meetingCode).toBe('abc-defg-hij');
    expect(fields.gmeetContext.attendees).toEqual([
      { email: 'b@x.com', name: 'B', responseStatus: undefined },
    ]);
    expect(fields.recordedAtIso).toBe('2026-08-19T10:00:00+08:00');
    expect(fields.eventTitle).toHaveLength(300);
  });

  test('no start time → no recordedAt', () => {
    const fields = linkedEventIngestFields({ id: 'ev1' });
    expect(fields.recordedAtIso).toBeNull();
    expect(fields.eventTitle).toBeNull();
    expect(fields.attendees).toEqual([]);
  });
});

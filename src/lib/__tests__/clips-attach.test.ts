import { describe, expect, test } from 'bun:test';
import {
  attachMarker,
  attachMarkerOf,
  attachOffsetMs,
  combineRefusal,
  parseAttachTo,
  pendingAttachOf,
} from '../clips';

/**
 * Phase 3b source (c) — an upload that joins an existing meeting
 * (docs/recordings-phase3b-combine-spec.md §API).
 *
 * The pure half: what a client may say (`parseAttachTo`), what gets frozen on
 * the placeholder (`attachMarker`), and what the completion hook reads back
 * off a row that has been through promotion, jsonb and a restart
 * (`attachMarkerOf` / `pendingAttachOf`). The refusals the two routes answer
 * with are the SAME `combineRefusal` sentences the sheet greys out for, which
 * is the property the last block pins.
 */

const MEETING = '7b6c1c22-1111-4111-8111-aaaaaaaaaaaa';

describe('parseAttachTo — what a client may say', () => {
  test('absent is absent, not an error', () => {
    expect(parseAttachTo(undefined)).toBeUndefined();
    expect(parseAttachTo(null)).toBeUndefined();
    expect(parseAttachTo('')).toBeUndefined();
    expect(parseAttachTo('   ')).toBeUndefined();
  });

  test('a bare string is the one-shot route’s ?attachTo=<meeting id>', () => {
    expect(parseAttachTo(MEETING)).toEqual({ meetingId: MEETING });
    expect(parseAttachTo(` gmeet-abc123 `)).toEqual({ meetingId: 'gmeet-abc123' });
  });

  test('the object form carries the offset and the policy', () => {
    expect(parseAttachTo({ meetingId: MEETING, offsetMs: 110_000, textPolicy: 'gap_fill' })).toEqual({
      meetingId: MEETING,
      offsetMs: 110_000,
      textPolicy: 'gap_fill',
    });
    expect(parseAttachTo({ meetingId: MEETING, offset: '1:50:00' })).toEqual({
      meetingId: MEETING,
      offset: '1:50:00',
    });
  });

  test('junk is null — the route answers 400 rather than uploading unattached', () => {
    // A client that MEANT to attach must hear that it will not be, before the
    // bytes, not discover a standalone meeting an hour later.
    expect(parseAttachTo({})).toBeNull();
    expect(parseAttachTo({ meetingId: 'no' })).toBeNull(); // too short
    expect(parseAttachTo({ meetingId: 'has spaces in it' })).toBeNull();
    expect(parseAttachTo({ meetingId: MEETING, offsetMs: '110000' })).toBeNull();
    expect(parseAttachTo({ meetingId: MEETING, textPolicy: 'sometimes' })).toBeNull();
    expect(parseAttachTo(['meeting'])).toBeNull();
    expect(parseAttachTo(42)).toBeNull();
    expect(parseAttachTo('not/a/meeting/id')).toBeNull();
  });
});

describe('attachOffsetMs — never guessed, never silently zero', () => {
  test('nothing asked for means "they start together"', () => {
    expect(attachOffsetMs({ meetingId: MEETING })).toBe(0);
  });

  test('ms wins over the clock form, and the clock form is read', () => {
    expect(attachOffsetMs({ meetingId: MEETING, offsetMs: 110_000, offset: '9:99' })).toBe(110_000);
    expect(attachOffsetMs({ meetingId: MEETING, offset: '1:50' })).toBe(110_000);
    expect(attachOffsetMs({ meetingId: MEETING, offset: '1:50:00' })).toBe(6_600_000);
  });

  test('an unreadable offset is null — the route refuses instead of using 0', () => {
    expect(attachOffsetMs({ meetingId: MEETING, offset: 'half past' })).toBeNull();
    expect(attachOffsetMs({ meetingId: MEETING, offsetMs: -1 })).toBeNull();
    expect(attachOffsetMs({ meetingId: MEETING, offsetMs: Number.NaN })).toBeNull();
  });
});

describe('the marker frozen on the placeholder', () => {
  const now = new Date('2026-09-22T04:00:00.000Z');

  test('defaults: the whole upload, at 0, with its words', () => {
    const marker = attachMarker({ meetingId: MEETING }, 0, 'alok@trames.sg', now);
    expect(marker).toEqual({
      meetingId: MEETING,
      offsetMs: 0,
      textPolicy: 'include',
      at: '2026-09-22T04:00:00.000Z',
      by: 'alok@trames.sg',
    });
  });

  test('the uploader’s email is frozen — access is re-checked AS THEM later', () => {
    const marker = attachMarker(
      { meetingId: MEETING, textPolicy: 'gap_fill' },
      110_000,
      'kawen@trames.sg',
      now
    );
    expect(marker.by).toBe('kawen@trames.sg');
    expect(marker.textPolicy).toBe('gap_fill');
    expect(marker.offsetMs).toBe(110_000);
  });

  test('no uploader, no key — an absent `by` is never the string "null"', () => {
    expect(attachMarker({ meetingId: MEETING }, 0, null, now)).not.toHaveProperty('by');
  });
});

describe('reading the marker back off a row', () => {
  const marker = attachMarker({ meetingId: MEETING, textPolicy: 'exclude' }, 90_000, 'a@b.c');

  test('a round trip through jsonb survives', () => {
    const ctx = JSON.parse(JSON.stringify({ attachTo: marker })) as { attachTo: unknown };
    expect(attachMarkerOf(ctx)).toEqual(marker);
    expect(pendingAttachOf(ctx)).toEqual(marker);
  });

  test('no marker, a cleared marker and junk all read as nothing', () => {
    expect(attachMarkerOf(null)).toBeNull();
    expect(attachMarkerOf({})).toBeNull();
    expect(attachMarkerOf({ attachTo: null })).toBeNull(); // cleared on success
    expect(attachMarkerOf({ attachTo: 'gmeet-123' })).toBeNull();
    expect(attachMarkerOf({ attachTo: { offsetMs: 10 } })).toBeNull(); // no meeting
  });

  test('a marker missing its numbers still names its meeting', () => {
    // Hand-written / older shapes must not throw: the meeting id is the only
    // field that decides anything, the rest default the way the API does.
    expect(attachMarkerOf({ attachTo: { meetingId: MEETING } })).toEqual({
      meetingId: MEETING,
      offsetMs: 0,
      textPolicy: 'include',
      at: '',
    });
  });

  test('a REFUSED marker is read, but is not pending — it is never retried', () => {
    const refused = { ...marker, error: 'That meeting is in the trash.', failedAt: '2026-09-22T05:00:00Z' };
    expect(attachMarkerOf({ attachTo: refused })?.error).toBe('That meeting is in the trash.');
    expect(pendingAttachOf({ attachTo: refused })).toBeNull();
  });
});

describe('the refusal table the two upload routes answer with', () => {
  // Same codes, same sentences as the sheet's — one vocabulary for "no".
  test.each([
    ['disabled', 409],
    ['read-only', 403],
    ['no-clip', 409],
    ['too-many-clips', 409],
    ['offset-invalid', 400],
  ] as const)('%s carries a sentence a person can act on', (code) => {
    const refusal = combineRefusal(code);
    expect(refusal.code).toBe(code);
    expect(refusal.message.length).toBeGreaterThan(10);
    // Never an id, never a stack, never "error".
    expect(refusal.message).not.toContain(MEETING);
  });

  test('a meeting the caller cannot open is not named as such', () => {
    // The route answers 404 with a flat sentence rather than a code: an
    // unknown id and a forbidden one must be indistinguishable.
    const forbidden = 'That meeting is not available to you.';
    expect(forbidden).not.toContain('permission');
    expect(forbidden).not.toContain('exists');
  });

  test('the 501 on POST …/clips now says where an upload attaches instead', () => {
    const refusal = combineRefusal('upload-deferred');
    expect(refusal.message).toContain('upload dialog');
    expect(refusal.message).not.toContain('not wired up');
  });
});

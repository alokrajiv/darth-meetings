/**
 * P3 / F4 (docs/recordings-meetings-series-design.md): what GET
 * /api/transcripts/:id may tell a READ-ONLY sharer.
 *
 * Only meetings are shared. A share says "read this meeting"; it does not
 * say "see the owner's calendar" or "see which app the owner takes their
 * calls in". The 17:03 fixture is the one that matters: a Slack huddle
 * uploaded by A, shared read-only with B, carrying A's calendar's
 * "Hypercare" occurrence as a suggestion nobody acted on.
 */
import { describe, expect, test } from 'bun:test';
import type { GmeetContext } from '../format';
import { redactForReader } from '../reader-redaction';

const ctx = (over: Partial<GmeetContext> = {}): GmeetContext => ({
  eventTitle: 'harshil, ivan (DM)',
  suggestedEvent: {
    key: 'evt-hypercare|2026-09-22T09:00:00.000Z',
    eventId: 'evt-hypercare',
    title: 'Hypercare — APP <> Trames',
    startIso: '2026-09-22T09:00:00.000Z',
    endIso: '2026-09-22T10:00:00.000Z',
    provider: 'teams',
    meetingCode: 'teams-abc',
    score: 0.3,
    overlap: 0.9,
    titleScore: 0,
    callKind: 'slack',
  },
  recorder: { recordingId: 'rec-1', app: 'Slack', kind: 'slack' },
  ...over,
});

const row = (access: string, over: Partial<GmeetContext> = {}) => ({
  assemblyai_id: 'aai-1',
  title: 'harshil, ivan (DM)',
  gmeet_context: ctx(over),
  access,
});

describe('a read-only sharer', () => {
  test('is told nothing about the owner’s calendar guess', () => {
    const out = redactForReader(row('read'));
    expect(out.gmeet_context.suggestedEvent).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('Hypercare');
    expect(JSON.stringify(out)).not.toContain('teams-abc');
  });

  test('is told nothing about which app the owner was in', () => {
    const out = redactForReader(row('read'));
    expect(out.gmeet_context.recorder).toEqual({ recordingId: 'rec-1' });
    expect(JSON.stringify(out)).not.toContain('Slack');
  });

  test('keeps everything a reader is actually there for', () => {
    const out = redactForReader(row('read', { meetingCode: 'abc-defg-hij', organizerEmail: 'a@trames.sg' }));
    expect(out.gmeet_context.meetingCode).toBe('abc-defg-hij');
    expect(out.gmeet_context.organizerEmail).toBe('a@trames.sg');
    expect(out.gmeet_context.eventTitle).toBe('harshil, ivan (DM)');
    expect(out.title).toBe('harshil, ivan (DM)');
  });

  test('a dismissed suggestion is redacted too — dismissed is not gone', () => {
    const out = redactForReader(
      row('read', { suggestedEvent: { ...ctx().suggestedEvent!, dismissedAt: '2026-09-22T10:00:00.000Z' } })
    );
    expect(out.gmeet_context.suggestedEvent).toBeUndefined();
  });

  test('a row with no context, and one with no recorder marker, survive', () => {
    expect(redactForReader({ gmeet_context: null, access: 'read' }).gmeet_context).toBeNull();
    const out = redactForReader({ gmeet_context: { meetingCode: 'x' }, access: 'read' });
    expect(out.gmeet_context).toEqual({ meetingCode: 'x' });
  });
});

describe('owners and editors', () => {
  test('see the suggestion and the call details, byte for byte', () => {
    for (const access of ['owner', 'edit']) {
      const before = row(access);
      const out = redactForReader(before);
      // Returned by identity: nothing downstream can tell a redaction ran.
      expect(out).toBe(before);
      expect(out.gmeet_context.suggestedEvent?.title).toBe('Hypercare — APP <> Trames');
      expect(out.gmeet_context.recorder?.app).toBe('Slack');
    }
  });
});

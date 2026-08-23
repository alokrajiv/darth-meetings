import { describe, expect, test } from 'bun:test';
import {
  CHAT_WINDOW_AFTER_MS,
  CHAT_WINDOW_BEFORE_MS,
  FAILED_RETRY_MS,
  LINK_RETRY_MS,
  RECAP_SETTLE_MS,
  asTeamsChatEvidence,
  chatCallEndMs,
  chatEvidenceWindow,
  classifyChatCallEvents,
  needsChatLookup,
  type ChatCallEventsResponse,
  type TeamsChatEvidence,
} from '@/lib/teams-chat-evidence';
import { threadIdFromJoinUrl } from '@/lib/teams-link';

const META = { checkedAt: '2026-08-23T10:00:00.000Z', byEmail: 'alok@trames.sg' };

// The LP-Global fixture thread (Aug 17 occurrence, held 51 min, not recorded).
const LP_THREAD = '19:meeting_MWJiMDcwMTUtYTE4MC00MmE5LWFkZmQtNjBiMGMxYjc1ZGE0@thread.v2';
const CONTEXT = '%7b%22Tid%22%3a%229dd6657a-80c2-4122-9091-258f264d23a0%22%2c%22Oid%22%3a%228c05d801-9c1c-484c-9501-d5450d6eafa5%22%7d';
const LP_URL = `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(LP_THREAD)}/0?context=${CONTEXT}`;

describe('threadIdFromJoinUrl', () => {
  test('decodes the first path segment (own-tenant meeting thread)', () => {
    expect(threadIdFromJoinUrl(LP_URL)).toBe(LP_THREAD);
  });
  test('raw calendar link with add-on noise still yields the thread id', () => {
    expect(threadIdFromJoinUrl(`${LP_URL}&launchAgent=GSuiteAddOn&correlationId=x`)).toBe(
      LP_THREAD
    );
  });
  test('channel-meeting tacv2 threads work too', () => {
    const t = '19:r7DtQY1YIv2zvz4IPcUkUkPvm4_CYGpYuBkVHVifu3A1@thread.tacv2';
    expect(
      threadIdFromJoinUrl(
        `https://teams.microsoft.com/l/meetup-join/${encodeURIComponent(t)}/0?context=${CONTEXT}`
      )
    ).toBe(t);
  });
  test('not a meetup-join link → null', () => {
    expect(threadIdFromJoinUrl('https://teams.microsoft.com/l/message/foo')).toBeNull();
    expect(threadIdFromJoinUrl('https://example.com')).toBeNull();
  });
});

describe('chatEvidenceWindow', () => {
  test('[start − 20 min, end + 3 h]', () => {
    const w = chatEvidenceWindow('2026-08-17T07:30:00Z', '2026-08-17T08:30:00Z')!;
    expect(Date.parse(w.fromIso)).toBe(Date.parse('2026-08-17T07:30:00Z') - CHAT_WINDOW_BEFORE_MS);
    expect(Date.parse(w.toIso)).toBe(Date.parse('2026-08-17T08:30:00Z') + CHAT_WINDOW_AFTER_MS);
  });
  test('missing/invalid end falls back to start + 1 h', () => {
    const w = chatEvidenceWindow('2026-08-17T07:30:00Z', null)!;
    expect(Date.parse(w.toIso)).toBe(
      Date.parse('2026-08-17T08:30:00Z') + CHAT_WINDOW_AFTER_MS
    );
  });
  test('unparseable start → null', () => {
    expect(chatEvidenceWindow('nope')).toBeNull();
  });
});

describe('classifyChatCallEvents', () => {
  test('held + not recorded (the LP Aug 17 shape)', () => {
    const resp: ChatCallEventsResponse = {
      ok: true,
      summary: {
        held: true,
        callStart: '2026-08-17T07:28:00Z',
        callEnd: '2026-08-17T08:19:00Z',
        durationMs: 51 * 60_000,
        recorded: false,
        transcribed: false,
        humanMessages: 2,
      },
    };
    const v = classifyChatCallEvents(resp, META);
    expect(v.held).toBe(true);
    expect(v.recorded).toBe(false);
    expect(v.durationMs).toBe(51 * 60_000);
    expect(v.humanMessages).toBe(2);
    expect(v.byEmail).toBe('alok@trames.sg');
    expect(v.reason).toBeUndefined();
  });
  test('not held', () => {
    const v = classifyChatCallEvents(
      {
        ok: true,
        summary: {
          held: false,
          callStart: null,
          callEnd: null,
          durationMs: null,
          recorded: false,
          transcribed: false,
          humanMessages: 0,
        },
      },
      META
    );
    expect(v.held).toBe(false);
    expect(v.reason).toBeUndefined();
  });
  test('ok:false carries the reason with held unknown', () => {
    const v = classifyChatCallEvents({ ok: false, reason: 'forbidden' }, META);
    expect(v.held).toBeNull();
    expect(v.reason).toBe('forbidden');
  });
  test('malformed ok:true (no summary) is unknown, never "not held"', () => {
    const v = classifyChatCallEvents({ ok: true }, META);
    expect(v.held).toBeNull();
    expect(v.reason).toBe('graph_error');
  });
});

describe('asTeamsChatEvidence', () => {
  test('round-trips a persisted verdict', () => {
    const v = classifyChatCallEvents({ ok: false, reason: 'throttled' }, META);
    expect(asTeamsChatEvidence(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  test('garbage → null', () => {
    expect(asTeamsChatEvidence(null)).toBeNull();
    expect(asTeamsChatEvidence({ held: true })).toBeNull();
    expect(asTeamsChatEvidence('x')).toBeNull();
  });
});

describe('needsChatLookup', () => {
  const END = Date.parse('2026-08-17T08:19:00Z');
  const solid = (checkedAt: string): TeamsChatEvidence => ({
    checkedAt,
    byEmail: 'alok@trames.sg',
    held: true,
    callStart: '2026-08-17T07:28:00Z',
    callEnd: '2026-08-17T08:19:00Z',
    durationMs: 51 * 60_000,
    recorded: false,
    transcribed: false,
    humanMessages: 0,
  });

  test('no verdict → lookup', () => {
    expect(needsChatLookup(null, END, END + 3600_000)).toBe(true);
    expect(needsChatLookup(undefined, END, END + 3600_000)).toBe(true);
  });
  test('verdict taken <90 min after call end is re-checked once settled', () => {
    const early = solid(new Date(END + 10 * 60_000).toISOString());
    // Recap window not over yet → wait (don't burn lookups on it).
    expect(needsChatLookup(early, END, END + 60 * 60_000)).toBe(false);
    // Settled → re-check once.
    expect(needsChatLookup(early, END, END + RECAP_SETTLE_MS + 1)).toBe(true);
  });
  test('verdict taken after the recap window is final', () => {
    const late = solid(new Date(END + RECAP_SETTLE_MS + 60_000).toISOString());
    expect(needsChatLookup(late, END, END + 30 * 86_400_000)).toBe(false);
  });
  test('forbidden/throttled/graph_error retry after 7 days', () => {
    for (const reason of ['forbidden', 'throttled', 'graph_error']) {
      const failed: TeamsChatEvidence = { ...solid(META.checkedAt), held: null, reason };
      const checked = Date.parse(META.checkedAt);
      expect(needsChatLookup(failed, END, checked + FAILED_RETRY_MS - 1)).toBe(false);
      expect(needsChatLookup(failed, END, checked + FAILED_RETRY_MS)).toBe(true);
    }
  });
  test('not_linked retries much sooner (link state changes)', () => {
    const failed: TeamsChatEvidence = {
      ...solid(META.checkedAt),
      held: null,
      reason: 'not_linked',
    };
    const checked = Date.parse(META.checkedAt);
    expect(needsChatLookup(failed, END, checked + LINK_RETRY_MS - 1)).toBe(false);
    expect(needsChatLookup(failed, END, checked + LINK_RETRY_MS)).toBe(true);
  });
  test('unparseable checkedAt → lookup', () => {
    expect(needsChatLookup({ ...solid('garbage') }, END, END + 1)).toBe(true);
  });
});

describe('chatCallEndMs', () => {
  test('max of calendar end and the verdict callEnd', () => {
    const v: TeamsChatEvidence = {
      checkedAt: META.checkedAt,
      byEmail: null,
      held: true,
      callStart: '2026-08-17T07:28:00Z',
      callEnd: '2026-08-17T08:45:00Z', // ran long
      durationMs: null,
      recorded: false,
      transcribed: false,
      humanMessages: null,
    };
    expect(chatCallEndMs('2026-08-17T08:30:00Z', v)).toBe(Date.parse('2026-08-17T08:45:00Z'));
    expect(chatCallEndMs('2026-08-17T08:30:00Z', null)).toBe(Date.parse('2026-08-17T08:30:00Z'));
    expect(chatCallEndMs(null, null)).toBe(0);
  });
});

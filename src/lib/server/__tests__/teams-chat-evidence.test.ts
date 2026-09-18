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
  classifyChatCallEventsUnion,
  needsChatLookup,
  summarizeCallEvents,
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

// ---------------------------------------------------------------------------
// D3 (2026-09-18): union across linked readers + events[]-based verdicts.
// The APP Hypercare shape: alok's copy of the host-tenant chat holds the
// call, an external colleague's copy of the SAME thread is empty for the
// same window (they did not join that day).
// ---------------------------------------------------------------------------

const EMPTY_SUMMARY = {
  held: false,
  callStart: null,
  callEnd: null,
  durationMs: null,
  recorded: false,
  transcribed: false,
  humanMessages: 0,
};

const HYPERCARE_EVENTS = [
  { at: '2026-08-19T02:01:10Z', type: 'callStarted' },
  { at: '2026-08-19T02:44:00Z', type: 'callEnded' },
  // 5-second reconnect at the end — plagueis' summary.durationMs would be
  // THIS pair only (0 min).
  { at: '2026-08-19T02:44:30Z', type: 'callStarted' },
  { at: '2026-08-19T02:44:35Z', type: 'callEnded' },
  { at: '2026-08-19T02:50:00Z', type: 'callRecording' },
];

const emptyReader: ChatCallEventsResponse = { ok: true, events: [], summary: EMPTY_SUMMARY };
const fullReader: ChatCallEventsResponse = {
  ok: true,
  events: HYPERCARE_EVENTS,
  // Deliberately the unreliable plagueis summary: last pair only.
  summary: {
    held: true,
    callStart: '2026-08-19T02:44:30Z',
    callEnd: '2026-08-19T02:44:35Z',
    durationMs: 5_000,
    recorded: true,
    transcribed: false,
    humanMessages: 3,
  },
};

describe('classifyChatCallEventsUnion', () => {
  test('two readers — one empty copy, one with the call — verdict is HELD', () => {
    const v = classifyChatCallEventsUnion(
      [
        { email: 'aniq.danial@trames.sg', resp: emptyReader },
        { email: 'alok@trames.sg', resp: fullReader },
      ],
      { checkedAt: META.checkedAt, byEmail: 'aniq.danial@trames.sg' }
    );
    expect(v.held).toBe(true);
    expect(v.recorded).toBe(true);
    expect(v.transcribed).toBe(false);
    expect(v.reason).toBeUndefined();
    // Sum of BOTH started→ended pairs (42m50s + 5s), not the last pair.
    expect(v.durationMs).toBe((42 * 60 + 50) * 1000 + 5_000);
    expect(v.callStart).toBe('2026-08-19T02:01:10Z');
    expect(v.callEnd).toBe('2026-08-19T02:44:35Z');
    // Only the copy that carried call events is named; both counted.
    expect(v.byEmail).toBe('alok@trames.sg');
    expect(v.readerCount).toBe(2);
    expect(v.humanMessages).toBe(3);
  });
  test('the same two readers in the other order give the same verdict', () => {
    const a = classifyChatCallEventsUnion(
      [{ email: 'a@trames.sg', resp: fullReader }, { email: 'b@trames.sg', resp: emptyReader }],
      META
    );
    const b = classifyChatCallEventsUnion(
      [{ email: 'b@trames.sg', resp: emptyReader }, { email: 'a@trames.sg', resp: fullReader }],
      META
    );
    expect({ ...a, byEmail: null }).toEqual({ ...b, byEmail: null });
  });
  test('one reader alone with an empty copy is NOT HELD (honest, readerCount 1)', () => {
    const v = classifyChatCallEventsUnion([{ email: 'aniq.danial@trames.sg', resp: emptyReader }], META);
    expect(v.held).toBe(false);
    expect(v.readerCount).toBe(1);
    expect(v.reason).toBeUndefined();
  });
  test('duplicate events across copies are counted once', () => {
    const v = classifyChatCallEventsUnion(
      [{ email: 'a@trames.sg', resp: fullReader }, { email: 'b@trames.sg', resp: fullReader }],
      META
    );
    expect(v.durationMs).toBe((42 * 60 + 50) * 1000 + 5_000);
    expect(v.byEmail).toBe('a@trames.sg+b@trames.sg');
  });
  test('callRecording / callTranscript alone (callStarted outside the window) = held, duration unknown', () => {
    const v = classifyChatCallEventsUnion(
      [
        {
          email: 'a@trames.sg',
          resp: {
            ok: true,
            events: [
              { at: '2026-08-19T05:10:00Z', type: 'callEnded' },
              { at: '2026-08-19T05:12:00Z', type: 'callRecording' },
              { at: '2026-08-19T05:12:30Z', type: 'callTranscript' },
            ],
            summary: EMPTY_SUMMARY, // plagueis says not held — events say otherwise
          },
        },
      ],
      META
    );
    expect(v.held).toBe(true);
    expect(v.recorded).toBe(true);
    expect(v.transcribed).toBe(true);
    expect(v.durationMs).toBeNull();
  });
  test('a failed reader next to an ok one does not poison the verdict', () => {
    const v = classifyChatCallEventsUnion(
      [
        { email: 'x@trames.sg', resp: { ok: false, reason: 'forbidden' } },
        { email: 'y@trames.sg', resp: null }, // transport failure
        { email: 'alok@trames.sg', resp: fullReader },
      ],
      META
    );
    expect(v.held).toBe(true);
    expect(v.reason).toBeUndefined();
    expect(v.readerCount).toBe(1);
  });
  test('no ok reader: transient reason wins over forbidden, link reasons only when alone', () => {
    const mixed = classifyChatCallEventsUnion(
      [
        { email: 'a@trames.sg', resp: { ok: false, reason: 'forbidden' } },
        { email: 'b@trames.sg', resp: { ok: false, reason: 'throttled' } },
        { email: 'c@trames.sg', resp: { ok: false, reason: 'not_linked' } },
      ],
      META
    );
    expect(mixed.held).toBeNull();
    expect(mixed.reason).toBe('throttled');
    const linkOnly = classifyChatCallEventsUnion(
      [{ email: 'c@trames.sg', resp: { ok: false, reason: 'not_linked' } }],
      META
    );
    expect(linkOnly.reason).toBe('not_linked');
    const forbiddenAndLink = classifyChatCallEventsUnion(
      [
        { email: 'a@trames.sg', resp: { ok: false, reason: 'not_linked' } },
        { email: 'b@trames.sg', resp: { ok: false, reason: 'forbidden' } },
      ],
      META
    );
    expect(forbiddenAndLink.reason).toBe('forbidden');
  });
  test('legacy responses without events[] fall back to the summaries, OR-ed', () => {
    const v = classifyChatCallEventsUnion(
      [
        { email: 'a@trames.sg', resp: { ok: true, summary: EMPTY_SUMMARY } },
        {
          email: 'b@trames.sg',
          resp: {
            ok: true,
            summary: { ...EMPTY_SUMMARY, held: true, durationMs: 60_000, callStart: '2026-08-19T02:00:00Z', callEnd: '2026-08-19T02:01:00Z' },
          },
        },
      ],
      META
    );
    expect(v.held).toBe(true);
    expect(v.durationMs).toBe(60_000);
    expect(v.byEmail).toBe('b@trames.sg');
    expect(v.readerCount).toBe(2);
  });
});

describe('summarizeCallEvents', () => {
  test('sums every started→ended pair in time order', () => {
    const s = summarizeCallEvents([
      { at: '2026-08-19T03:00:00Z', type: 'callEnded' }, // ended before any start: ignored
      { at: '2026-08-19T02:00:00Z', type: 'callStarted' },
      { at: '2026-08-19T02:30:00Z', type: 'callEnded' },
      { at: '2026-08-19T02:35:00Z', type: 'callStarted' },
      { at: '2026-08-19T02:36:00Z', type: 'callStarted' }, // duplicate start: first wins
      { at: '2026-08-19T02:45:00Z', type: 'callEnded' },
      { at: '2026-08-19T02:46:00Z', type: 'somethingElse' },
    ]);
    // 30 min + 10 min; the stray 03:00 callEnded closes nothing (open is null then).
    expect(s.durationMs).toBe(40 * 60_000);
    expect(s.held).toBe(true);
    expect(s.callStart).toBe('2026-08-19T02:00:00Z');
    expect(s.callEnd).toBe('2026-08-19T03:00:00Z');
  });
  test('no call events → not held', () => {
    expect(summarizeCallEvents([{ at: '2026-08-19T02:00:00Z', type: 'membersAdded' }]).held).toBe(false);
  });
});

describe('asTeamsChatEvidence', () => {
  test('round-trips a persisted verdict', () => {
    const v = classifyChatCallEvents({ ok: false, reason: 'throttled' }, META);
    expect(asTeamsChatEvidence(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  test('keeps readerCount', () => {
    const v = classifyChatCallEventsUnion([{ email: 'a@trames.sg', resp: fullReader }], META);
    expect(asTeamsChatEvidence(JSON.parse(JSON.stringify(v)))?.readerCount).toBe(1);
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
  test('external pre-union "not held" (no readerCount) is re-asked once; unioned ones are final', () => {
    const late = new Date(END + RECAP_SETTLE_MS + 60_000).toISOString();
    const preUnion: TeamsChatEvidence = { ...solid(late), held: false };
    expect(needsChatLookup(preUnion, END, END + 30 * 86_400_000, { external: true })).toBe(true);
    // Own tenant: one copy is the whole chat — final as before.
    expect(needsChatLookup(preUnion, END, END + 30 * 86_400_000, { external: false })).toBe(false);
    // After the union ran (readerCount stamped, even if still not held): final.
    expect(needsChatLookup({ ...preUnion, readerCount: 1 }, END, END + 30 * 86_400_000, { external: true })).toBe(false);
    // Held verdicts are never re-asked on this rule.
    expect(needsChatLookup(solid(late), END, END + 30 * 86_400_000, { external: true })).toBe(false);
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

import { describe, expect, test } from 'bun:test';
import {
  findTeamsJoinUrl,
  isOwnTenant,
  parseTeamsJoinLink,
  pickOccurrenceArtifacts,
  type GraphRecording,
  type GraphTranscript,
} from '@/lib/teams-link';

const TID = '9dd6657a-80c2-4122-9091-258f264d23a0';
const OID = '8c05d801-9c1c-484c-9501-d5450d6eafa5';

// Shape captured from a real GSuite-add-on calendar event (spec §4.1).
const CONTEXT = `%7b%22Tid%22%3a%22${TID}%22%2c%22Oid%22%3a%22${OID}%22%7d`;
const CANONICAL = `https://teams.microsoft.com/l/meetup-join/19%3ameeting_MWJiOTC4YWQtZmVi%40thread.v2/0?context=${CONTEXT}`;
const RAW = `${CANONICAL}&launchAgent=GSuiteAddOn&correlationId=abc-def-123`;

describe('parseTeamsJoinLink', () => {
  test('strips trailing params down to the canonical URL', () => {
    const info = parseTeamsJoinLink(RAW);
    expect(info).not.toBeNull();
    expect(info!.joinWebUrl).toBe(CANONICAL);
    expect(info!.tenantId).toBe(TID);
    expect(info!.organizerOid).toBe(OID);
  });

  test('already-canonical URL passes through unchanged', () => {
    expect(parseTeamsJoinLink(CANONICAL)!.joinWebUrl).toBe(CANONICAL);
  });

  test('uppercase %7B/%7D encoding', () => {
    const upper = RAW.replace(/%7b/g, '%7B').replace(/%7d/g, '%7D');
    const info = parseTeamsJoinLink(upper);
    expect(info).not.toBeNull();
    expect(info!.tenantId).toBe(TID);
    expect(info!.joinWebUrl.endsWith('%7D')).toBe(true);
  });

  test('nested braces in context do not truncate early', () => {
    const nested = `https://teams.microsoft.com/l/meetup-join/19%3am%40thread.v2/0?context=%7b%22Tid%22%3a%22${TID}%22%2c%22x%22%3a%7b%22y%22%3a1%7d%2c%22Oid%22%3a%22${OID}%22%7d&launchAgent=z`;
    const info = parseTeamsJoinLink(nested);
    expect(info).not.toBeNull();
    expect(info!.organizerOid).toBe(OID);
    expect(info!.joinWebUrl.includes('launchAgent')).toBe(false);
  });

  test('rejects non-meetup URLs and missing context', () => {
    expect(parseTeamsJoinLink('https://meet.google.com/abc-defg-hij')).toBeNull();
    expect(
      parseTeamsJoinLink('https://teams.microsoft.com/l/meetup-join/19%3am%40thread.v2/0')
    ).toBeNull();
  });
});

describe('findTeamsJoinUrl', () => {
  test('finds the link inside event description prose', () => {
    const blob = `Join here: ${RAW}\n\nAgenda: weekly sync`;
    expect(findTeamsJoinUrl(blob)).toBe(RAW);
    expect(findTeamsJoinUrl('no links here')).toBeNull();
    expect(findTeamsJoinUrl(null)).toBeNull();
  });
});

describe('isOwnTenant', () => {
  test('compares against config tenant, case-insensitive', () => {
    const prev = process.env.MS_TENANT_ID;
    process.env.MS_TENANT_ID = TID;
    try {
      expect(isOwnTenant(parseTeamsJoinLink(RAW)!)).toBe(true);
      const foreign = { ...parseTeamsJoinLink(RAW)!, tenantId: 'e37c2b3a-0000-0000-0000-000000000000' };
      expect(isOwnTenant(foreign)).toBe(false);
      process.env.MS_TENANT_ID = TID.toUpperCase();
      expect(isOwnTenant(parseTeamsJoinLink(RAW)!)).toBe(true);
      process.env.MS_TENANT_ID = '';
      expect(isOwnTenant(parseTeamsJoinLink(RAW)!)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MS_TENANT_ID;
      else process.env.MS_TENANT_ID = prev;
    }
  });
});

describe('pickOccurrenceArtifacts', () => {
  // Model the verified LP-Global shape: one weekly series, 11 occurrences,
  // transcript createdDateTime a few minutes after event start, recording
  // sharing the occurrence's callId.
  const transcripts: GraphTranscript[] = [];
  const recordings: GraphRecording[] = [];
  const base = Date.parse('2026-05-29T09:00:00Z'); // weekly, 09:00–09:30 UTC
  const WEEK = 7 * 24 * 3600 * 1000;
  for (let w = 0; w < 11; w++) {
    const start = base + w * WEEK;
    transcripts.push({
      id: `t${w}`,
      callId: `call-${w}`,
      createdDateTime: new Date(start + 4 * 60 * 1000).toISOString(), // +4 min
      endDateTime: new Date(start + 28 * 60 * 1000).toISOString(),
    });
    recordings.push({
      id: `r${w}`,
      callId: `call-${w}`,
      createdDateTime: new Date(start + 3 * 60 * 1000).toISOString(),
      endDateTime: new Date(start + 28 * 60 * 1000).toISOString(),
    });
  }

  const eventStart = (w: number) => new Date(base + w * WEEK).toISOString();
  const eventEnd = (w: number) => new Date(base + w * WEEK + 30 * 60 * 1000).toISOString();

  test('picks the right occurrence out of 11, paired by callId', () => {
    for (const w of [0, 5, 10]) {
      const { transcript, recording } = pickOccurrenceArtifacts(
        transcripts,
        recordings,
        eventStart(w),
        eventEnd(w)
      );
      expect(transcript?.id).toBe(`t${w}`);
      expect(recording?.id).toBe(`r${w}`);
    }
  });

  test('a week with no artifacts matches nothing', () => {
    const { transcript, recording } = pickOccurrenceArtifacts(
      transcripts,
      recordings,
      new Date(base + 20 * WEEK).toISOString(),
      new Date(base + 20 * WEEK + 30 * 60 * 1000).toISOString()
    );
    expect(transcript).toBeUndefined();
    expect(recording).toBeUndefined();
  });

  test('meeting that overran: artifact ending hours after event end still matches', () => {
    const t: GraphTranscript[] = [
      {
        id: 'late',
        callId: 'c',
        createdDateTime: new Date(base + 10 * 60 * 1000).toISOString(),
        endDateTime: new Date(base + 4 * 3600 * 1000).toISOString(),
      },
    ];
    expect(pickOccurrenceArtifacts(t, [], eventStart(0), eventEnd(0)).transcript?.id).toBe('late');
  });

  test('artifact starting just before the event (−15 min edge) matches; earlier does not', () => {
    const near: GraphTranscript = {
      id: 'near',
      createdDateTime: new Date(base - 14 * 60 * 1000).toISOString(),
      endDateTime: new Date(base - 10 * 60 * 1000).toISOString(),
    };
    const far: GraphTranscript = {
      id: 'far',
      createdDateTime: new Date(base - 60 * 60 * 1000).toISOString(),
      endDateTime: new Date(base - 40 * 60 * 1000).toISOString(),
    };
    expect(pickOccurrenceArtifacts([near], [], eventStart(0), eventEnd(0)).transcript?.id).toBe(
      'near'
    );
    expect(pickOccurrenceArtifacts([far], [], eventStart(0), eventEnd(0)).transcript).toBeUndefined();
  });

  test('recording-only occurrence (no transcript) still returns the recording', () => {
    const { transcript, recording } = pickOccurrenceArtifacts(
      [],
      recordings,
      eventStart(3),
      eventEnd(3)
    );
    expect(transcript).toBeUndefined();
    expect(recording?.id).toBe('r3');
  });

  test('two artifacts in window: closest to event start wins', () => {
    const both: GraphTranscript[] = [
      { id: 'a', createdDateTime: new Date(base + 5 * 60 * 1000).toISOString() },
      { id: 'b', createdDateTime: new Date(base + 3 * 3600 * 1000).toISOString() },
    ];
    expect(pickOccurrenceArtifacts(both, [], eventStart(0), eventEnd(0)).transcript?.id).toBe('a');
  });
});

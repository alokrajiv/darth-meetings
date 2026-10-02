/**
 * "This occurrence already has a meeting — add my recording to it"
 * (owner, 2026-10-02) — the pure half: the mode, the occurrence matcher, the
 * dialog's copy, the alignment arithmetic, the annotation re-key a join's
 * re-materialise needs, and where two recordings overlap.
 */
import { describe, expect, test } from 'bun:test';
import {
  annotationRekey,
  candidateOwnerLabel,
  hasOccurrenceKey,
  isIdentityRekey,
  joinChoiceCopy,
  joinedOffsetFromAlign,
  occurrenceJoinsOf,
  occurrenceKeyOf,
  parseLinkMode,
  pickJoinCandidate,
  rekeyEdits,
  rekeySpeakerLabels,
  rekeySuggestions,
  sameOccurrence,
  type OccurrenceMeetingCandidate,
  type OccurrenceMeetingFacts,
} from '@/lib/occurrence-join';
import { clipOverlaps, MIN_REPORTED_OVERLAP_MS } from '@/lib/clips';

const R_KAWEN = '11111111-1111-4111-8111-111111111111';
const R_IVAN = '22222222-2222-4222-8222-222222222222';

describe('the mode', () => {
  test('join / separate, absent = server default, junk = null', () => {
    expect(parseLinkMode('join')).toBe('join');
    expect(parseLinkMode('separate')).toBe('separate');
    expect(parseLinkMode(undefined)).toBeUndefined();
    expect(parseLinkMode(null)).toBeUndefined();
    expect(parseLinkMode('')).toBeUndefined();
    expect(parseLinkMode('merge')).toBeNull();
    expect(parseLinkMode(1)).toBeNull();
  });
});

describe('the occurrence', () => {
  const stored = (over: Partial<OccurrenceMeetingFacts> = {}): OccurrenceMeetingFacts => ({
    event_id: null,
    ical_uid: null,
    meeting_code: null,
    join_web_url: null,
    occurrence_start: '2026-10-02T06:00:00.000Z',
    ...over,
  });

  test('the key reads every shape the link paths carry', () => {
    expect(
      occurrenceKeyOf({ id: 'ev1_20261002T060000Z', startTime: '2026-10-02T14:00:00+08:00', meetingCode: 'abc-defg-hij' })
    ).toEqual({
      eventId: 'ev1_20261002T060000Z',
      iCalUID: null,
      meetingCode: 'abc-defg-hij',
      joinWebUrl: null,
      startTime: '2026-10-02T06:00:00.000Z',
    });
    // A meeting's gmeet_context: eventId + the Teams join URL.
    const k = occurrenceKeyOf({ eventId: 'e', teams: { joinWebUrl: 'https://teams/x' }, startTime: 'nope' });
    expect(k.eventId).toBe('e');
    expect(k.joinWebUrl).toBe('https://teams/x');
    expect(k.startTime).toBeNull();
  });

  test('a provider key without a start names a series, not an occurrence', () => {
    expect(hasOccurrenceKey(occurrenceKeyOf({ meetingCode: 'abc-defg-hij' }))).toBe(false);
    expect(hasOccurrenceKey(occurrenceKeyOf({ meetingCode: 'abc-defg-hij', startTime: '2026-10-02T06:00:00Z' }))).toBe(
      true
    );
    expect(hasOccurrenceKey(occurrenceKeyOf({ id: 'ev' }))).toBe(true);
    expect(hasOccurrenceKey(occurrenceKeyOf({}))).toBe(false);
  });

  test('the same calendar event instance is the same occurrence', () => {
    const key = occurrenceKeyOf({ id: 'ev1', startTime: '2026-10-02T06:00:00Z' });
    expect(sameOccurrence(stored({ event_id: 'ev1' }), key)).toBe(true);
    // Same id but a different week (a series-master id on both sides) — no.
    expect(
      sameOccurrence(stored({ event_id: 'ev1', occurrence_start: '2026-10-09T06:00:00.000Z' }), key)
    ).toBe(false);
    expect(sameOccurrence(stored({ event_id: 'ev2' }), key)).toBe(false);
  });

  test('a Meet code / Teams cache code / join URL / iCalUID needs the start to agree', () => {
    const at = '2026-10-02T06:05:00Z';
    for (const [facts, key] of [
      [{ meeting_code: 'teams-abc123' }, { meetingCode: 'teams-abc123', startTime: at }],
      [{ join_web_url: 'https://teams/j' }, { joinWebUrl: 'https://teams/j', startTime: at }],
      [{ ical_uid: 'uid@google' }, { iCalUID: 'uid@google', startTime: at }],
    ] as const) {
      expect(sameOccurrence(stored(facts), occurrenceKeyOf(key))).toBe(true);
      // The next week's occurrence of the same recurring call is another meeting.
      expect(
        sameOccurrence(stored({ ...facts, occurrence_start: '2026-10-09T06:00:00.000Z' }), occurrenceKeyOf(key))
      ).toBe(false);
      // No start on the link: never a join (stricter than "already imported?").
      expect(sameOccurrence(stored(facts), occurrenceKeyOf({ ...key, startTime: undefined }))).toBe(false);
    }
  });
});

describe('the dialog’s choice', () => {
  const cand = (over: Partial<OccurrenceMeetingCandidate> = {}): OccurrenceMeetingCandidate => ({
    meetingId: 'm-kawen',
    url: '/transcript/m-kawen',
    title: 'Data team weekly',
    ownerName: 'Ka Wen Koh',
    ownerEmail: 'kawen@trames.sg',
    mine: false,
    access: 'edit',
    recordingCount: 1,
    joinable: true,
    blockedCode: null,
    blockedReason: null,
    ...over,
  });

  test('names the owner, offers Add (default) and Keep separate', () => {
    const copy = joinChoiceCopy(cand());
    expect(copy.headline).toBe('This occurrence already has a meeting by Ka Wen Koh');
    expect(copy.title).toBe('Data team weekly');
    expect(copy.join).toBe('Add my recording to it');
    expect(copy.separate).toBe('Keep mine separate');
  });

  test('the owner label: you, a name, an email, never empty', () => {
    expect(candidateOwnerLabel(cand({ mine: true }))).toBe('you');
    expect(candidateOwnerLabel(cand({ ownerName: null }))).toBe('kawen@trames.sg');
    expect(candidateOwnerLabel(cand({ ownerName: ' ', ownerEmail: null }))).toBe('a colleague');
  });

  test('the default join takes the first JOINABLE candidate in the server’s order', () => {
    const full = cand({ meetingId: 'm-full', joinable: false, blockedCode: 'full' });
    expect(pickJoinCandidate([full, cand()])?.meetingId).toBe('m-kawen');
    expect(pickJoinCandidate([full])).toBeNull();
    expect(pickJoinCandidate([])).toBeNull();
  });
});

describe('the marker', () => {
  test('reads the map, tolerates junk', () => {
    const m = { at: 'x', byUserId: 'u', by: 'ivan@trames.sg', how: 'link', text: 'pending', alignment: 'unaligned' };
    expect(occurrenceJoinsOf({ occurrenceJoins: { [R_IVAN]: m } })[R_IVAN]?.text).toBe('pending');
    expect(occurrenceJoinsOf({ occurrenceJoins: [] })).toEqual({});
    expect(occurrenceJoinsOf(null)).toEqual({});
  });
});

describe('alignment', () => {
  test('the correlation offset lands where the primary’s zero is', () => {
    expect(joinedOffsetFromAlign({ offsetMs: 0, fromMs: 0 }, 95_000)).toBe(95_000);
    // A primary that is itself a window of a longer recording.
    expect(joinedOffsetFromAlign({ offsetMs: 0, fromMs: 60_000 }, 95_000)).toBe(35_000);
    // Started before the meeting's zero: not a clip offset — left for the sheet.
    expect(joinedOffsetFromAlign({ offsetMs: 0, fromMs: 0 }, -4_000)).toBeNull();
    expect(joinedOffsetFromAlign({ offsetMs: 0, fromMs: 0 }, Number.NaN)).toBeNull();
  });
});

describe('annotations survive the join’s re-materialise', () => {
  // Ka Wen's meeting before: one recording, bare labels, position keys.
  const before = [
    { start: 0, end: 4000, speaker: 'A', text: 'Morning all', confidence: 1, words: [] },
    { start: 5000, end: 9000, speaker: 'B', text: 'Hi', confidence: 1, words: [] },
    { start: 20000, end: 25000, speaker: 'A', text: 'Next item', confidence: 1, words: [] },
  ];
  // After Ivan joins: namespaced labels, his utterances interleaved.
  const after = [
    { start: 0, end: 4000, speaker: `${R_KAWEN}:A`, text: 'Morning all', confidence: 1, words: [] },
    { start: 1000, end: 3000, speaker: `${R_IVAN}:A`, text: 'morning', confidence: 1, words: [] },
    { start: 5000, end: 9000, speaker: `${R_KAWEN}:B`, text: 'Hi', confidence: 1, words: [] },
    { start: 20000, end: 25000, speaker: `${R_KAWEN}:A`, text: 'Next item', confidence: 1, words: [] },
  ];
  const r = annotationRekey(before as never, after as never);

  test('positions and labels are read off exact partners', () => {
    expect([...r.index]).toEqual([
      ['0', '0'],
      ['1', '2'],
      ['2', '3'],
    ]);
    expect(r.labels.get('A')).toBe(`${R_KAWEN}:A`);
    expect(r.labels.get('B')).toBe(`${R_KAWEN}:B`);
    expect(isIdentityRekey(r)).toBe(false);
    expect(isIdentityRekey(annotationRekey(before as never, before as never))).toBe(true);
  });

  test('edits follow their sentence; a namespaced key stays; an orphan is dropped', () => {
    const edits = rekeyEdits(
      {
        '1': { text: 'Hi everyone', speaker: 'A' },
        '2': { text: 'Next item, please' },
        '9': { text: 'nowhere' },
        [`${R_IVAN}:0`]: { text: 'Morning' },
      },
      r
    );
    expect(edits).toEqual({
      '2': { text: 'Hi everyone', speaker: `${R_KAWEN}:A` },
      '3': { text: 'Next item, please' },
      [`${R_IVAN}:0`]: { text: 'Morning' },
    });
  });

  test('speaker names and suggestions move to the namespaced labels', () => {
    expect(
      rekeySpeakerLabels(
        [
          { originalSpeaker: 'A', customName: 'Ka Wen Koh', description: '' },
          { originalSpeaker: 'Z', customName: 'Nobody', description: '' },
        ],
        r
      ).map((l) => l.originalSpeaker)
    ).toEqual([`${R_KAWEN}:A`, 'Z']);
    expect(Object.keys(rekeySuggestions({ B: { name: 'Ivan', confidence: 0.8 } }, r) ?? {})).toEqual([
      `${R_KAWEN}:B`,
    ]);
    expect(rekeySuggestions(null, r)).toBeNull();
  });
});

describe('overlap — two people recorded the same minutes', () => {
  const clip = (over: Record<string, unknown>) => ({
    ord: 0,
    recordingId: R_KAWEN,
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    recordingDurationMs: 1_800_000,
    textPolicy: 'include' as const,
    ...over,
  });

  test('the shared window is found once, timeline order', () => {
    const out = clipOverlaps([
      clip({ ord: 1, recordingId: R_IVAN, offsetMs: 600_000, recordingDurationMs: 1_800_000 }),
      clip({}),
    ]);
    expect(out).toEqual([
      { a: { ord: 0, recordingId: R_KAWEN }, b: { ord: 1, recordingId: R_IVAN }, fromMs: 600_000, toMs: 1_800_000 },
    ]);
  });

  test('back-to-back, a hand-over blip, one recording, audio-only and unknown lengths are not overlaps', () => {
    expect(clipOverlaps([clip({}), clip({ ord: 1, recordingId: R_IVAN, offsetMs: 1_800_000 })])).toEqual([]);
    expect(
      clipOverlaps([clip({}), clip({ ord: 1, recordingId: R_IVAN, offsetMs: 1_800_000 - MIN_REPORTED_OVERLAP_MS + 1 })])
    ).toEqual([]);
    expect(clipOverlaps([clip({}), clip({ ord: 1, offsetMs: 100_000 })])).toEqual([]);
    expect(clipOverlaps([clip({}), clip({ ord: 1, recordingId: R_IVAN, textPolicy: 'exclude' })])).toEqual([]);
    expect(clipOverlaps([clip({}), clip({ ord: 1, recordingId: R_IVAN, recordingDurationMs: null })])).toEqual([]);
  });
});

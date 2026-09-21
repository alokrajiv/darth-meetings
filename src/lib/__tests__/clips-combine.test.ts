/**
 * Phase 3b — the pure half of "several recordings, one meeting"
 * (docs/recordings-phase3b-combine-spec.md).
 *
 * Everything here is a function the SHEET and the ROUTE both call, so a row
 * the sheet greys out is a row the route refuses and vice versa. No database,
 * no server imports.
 */
import { describe, expect, test } from 'bun:test';
import {
  alignAdvice,
  alignVerdict,
  ALIGN_MIN_CONFIDENCE,
  candidateClipForTime,
  clipEntryExtent,
  clipSourceLabel,
  combineRefusal,
  MAX_CLIPS_PER_MEETING,
  meetingSpanFromDurations,
  meetingSpanMs,
  nextClipOrd,
  nominalOffsetMsBetween,
  recordingCountOf,
  storedClipsInContext,
  validateAddClip,
  validateDeleteClip,
  validatePatchClip,
  type ClipEntry,
  type ClipWindow,
} from '@/lib/clips';
import { splitSpeakerLabel, prefixSpeakerLabel } from '@/lib/recording-clips';

const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';

const clip = (over: Partial<ClipWindow> = {}): ClipWindow => ({
  ord: 0,
  recordingId: R1,
  fromMs: 0,
  toMs: null,
  offsetMs: 0,
  ...over,
});

const entry = (over: Partial<ClipEntry> = {}): ClipEntry => ({
  ord: 0,
  recordingId: R1,
  fromMs: 0,
  toMs: null,
  offsetMs: 0,
  textPolicy: 'include',
  transcribed: true,
  durationMs: null,
  sourceLabel: 'Teams recording',
  ownerEmail: null,
  ownerName: null,
  mine: true,
  primary: true,
  recordingDurationMs: null,
  recordingStartedAt: null,
  ...over,
});

describe('the mirror carries the text policy', () => {
  test('a gap_fill clip survives a round trip through gmeet_context.clips', () => {
    const stored = storedClipsInContext({
      clips: [
        { ord: 0, recordingId: R1, fromMs: 0, toMs: null, offsetMs: 0 },
        { ord: 1, recordingId: R2, fromMs: 0, toMs: null, offsetMs: 6_600_000, textPolicy: 'gap_fill' },
      ],
    });
    expect(stored).not.toBeNull();
    expect(stored![1]!.textPolicy).toBe('gap_fill');
    // `include` is the default and is deliberately NOT written: every row on
    // prod carries a mirror-less or policy-less clip and must keep reading
    // the same.
    expect(stored![0]!.textPolicy).toBeUndefined();
  });

  test('a junk policy reads as include, not as a malformed mirror', () => {
    const stored = storedClipsInContext({
      clips: [{ ord: 0, recordingId: R1, fromMs: 0, toMs: null, offsetMs: 0, textPolicy: 'nope' }],
    });
    // The whole point: a meeting must never go invisible to the resolver
    // because somebody wrote junk into its context.
    expect(stored).toHaveLength(1);
    expect(stored![0]!.textPolicy).toBeUndefined();
  });
});

describe('the span of a meeting over several recordings', () => {
  test('an open-ended clip runs to the end of ITS OWN recording', () => {
    const clips = [
      clip({ ord: 0, recordingId: R1, toMs: null, offsetMs: 0 }),
      clip({ ord: 1, recordingId: R2, toMs: null, offsetMs: 6_600_000 }),
    ];
    const durations = new Map([
      [R1, 17_700_000], // the 4h55 Teams video
      [R2, 6_900_000], // a 1h55 phone clip placed at 1:50:00
    ]);
    const span = meetingSpanFromDurations(clips, (id) => durations.get(id) ?? null);
    // The phone clip ends at 1:50:00 + 1:55:00 = 3:45:00 — well inside the
    // video, so the meeting is still the video's length.
    expect(span).toBe(17_700_000);
  });

  test('the phone that ran on past the video extends the meeting', () => {
    const clips = [
      clip({ ord: 0, recordingId: R1, toMs: null, offsetMs: 0 }),
      clip({ ord: 1, recordingId: R2, toMs: null, offsetMs: 3_000_000 }),
    ];
    const durations = new Map([
      [R1, 3_600_000],
      [R2, 1_800_000],
    ]);
    expect(meetingSpanFromDurations(clips, (id) => durations.get(id) ?? null)).toBe(4_800_000);
    // The single-duration form is the one-recording case of the same thing.
    expect(meetingSpanMs([clip({ toMs: null })], 3_600_000)).toBe(3_600_000);
  });
});

describe('adding a recording', () => {
  const base = {
    clips: [clip()],
    recordingId: R2,
    ownedByCaller: true,
    transcribed: true,
    fromMs: 0,
    toMs: null,
    offsetMs: 6_600_000,
    textPolicy: 'include' as const,
  };

  test('the happy path', () => {
    expect(validateAddClip(base)).toBeNull();
  });

  test('PRIVACY: a recording the caller does not own is refused, always', () => {
    const r = validateAddClip({ ...base, ownedByCaller: false });
    expect(r?.code).toBe('not-owned');
    // The sentence tells the editor what to do instead — ask the owner.
    expect(r?.message).toContain('owner');
  });

  test('the same recording twice is refused', () => {
    expect(validateAddClip({ ...base, recordingId: R1 })?.code).toBe('already-clipped');
  });

  test('a recording still transcribing may join as audio only, and no other way', () => {
    expect(validateAddClip({ ...base, transcribed: false })?.code).toBe('not-transcribed');
    expect(validateAddClip({ ...base, transcribed: false, textPolicy: 'gap_fill' })?.code).toBe(
      'not-transcribed'
    );
    expect(validateAddClip({ ...base, transcribed: false, textPolicy: 'exclude' })).toBeNull();
  });

  test('six clips is the cap', () => {
    const many = Array.from({ length: MAX_CLIPS_PER_MEETING }, (_, i) =>
      clip({ ord: i, recordingId: `${i}` })
    );
    expect(validateAddClip({ ...base, clips: many })?.code).toBe('too-many-clips');
  });

  test('a meeting with no clip has nothing to add to', () => {
    expect(validateAddClip({ ...base, clips: [] })?.code).toBe('no-clip');
  });

  test('the window and the offset have to make sense', () => {
    expect(validateAddClip({ ...base, fromMs: 500, toMs: 400 })?.code).toBe('window-invalid');
    expect(validateAddClip({ ...base, fromMs: 0, toMs: 5_000 })?.code).toBe('window-invalid');
    expect(validateAddClip({ ...base, offsetMs: -1 })?.code).toBe('offset-invalid');
  });

  test('ords only ever grow — a clip keeps its identity when another is added', () => {
    expect(nextClipOrd([clip({ ord: 0 }), clip({ ord: 3 })])).toBe(4);
    expect(nextClipOrd([])).toBe(0);
  });
});

describe('editing and removing a clip', () => {
  const clips = [clip({ ord: 0 }), clip({ ord: 1, recordingId: R2, offsetMs: 1000 })];

  test('a policy change on an un-transcribed recording is still audio-only', () => {
    expect(
      validatePatchClip({
        clips,
        ord: 1,
        fromMs: 0,
        toMs: null,
        offsetMs: 1000,
        textPolicy: 'include',
        transcribed: false,
      })?.code
    ).toBe('not-transcribed');
  });

  test('an ord that is not there is a 404, not a validation error', () => {
    expect(
      validatePatchClip({
        clips,
        ord: 9,
        fromMs: 0,
        toMs: null,
        offsetMs: 0,
        textPolicy: 'include',
        transcribed: true,
      })?.code
    ).toBe('clip-not-found');
  });

  test('un-combine removes a clip; the LAST one is protected', () => {
    expect(validateDeleteClip(clips, 1)).toBeNull();
    expect(validateDeleteClip([clip({ ord: 0 })], 0)?.code).toBe('last-clip');
    expect(validateDeleteClip(clips, 7)?.code).toBe('clip-not-found');
  });
});

describe('which part a t: chip plays', () => {
  // A Teams video 0–60 min, a phone clip filling 20–40 min, and an
  // audio-only alternate over the whole thing.
  const clips = [
    entry({ ord: 0, recordingId: R1, toMs: 3_600_000, offsetMs: 0, textPolicy: 'include' }),
    entry({
      ord: 1,
      recordingId: R2,
      toMs: 1_200_000,
      offsetMs: 1_200_000,
      textPolicy: 'gap_fill',
      primary: false,
    }),
    entry({
      ord: 2,
      recordingId: R3,
      toMs: 3_600_000,
      offsetMs: 0,
      textPolicy: 'exclude',
      primary: false,
    }),
  ];

  test('include wins over gap_fill, which wins over exclude', () => {
    expect(candidateClipForTime(clips, 1_500_000)?.recordingId).toBe(R1);
    expect(candidateClipForTime(clips.slice(1), 1_500_000)?.recordingId).toBe(R2);
    expect(candidateClipForTime(clips.slice(2), 1_500_000)?.recordingId).toBe(R3);
  });

  test('a moment no clip covers picks nothing rather than guessing', () => {
    expect(candidateClipForTime(clips, 4_000_000)).toBeNull();
  });

  test('a gap_fill clip is picked where the include clip has stopped', () => {
    const shortVideo = [
      entry({ ord: 0, recordingId: R1, toMs: 600_000, offsetMs: 0 }),
      entry({
        ord: 1,
        recordingId: R2,
        toMs: 1_200_000,
        offsetMs: 600_000,
        textPolicy: 'gap_fill',
        primary: false,
      }),
    ];
    expect(candidateClipForTime(shortVideo, 900_000)?.recordingId).toBe(R2);
  });

  test('an open-ended clip with a known recording length ends where it ends', () => {
    const open = entry({ toMs: null, fromMs: 60_000, offsetMs: 0, recordingDurationMs: 600_000 });
    expect(clipEntryExtent(open)).toEqual([0, 540_000]);
    expect(candidateClipForTime([open], 500_000)).not.toBeNull();
    expect(candidateClipForTime([open], 600_000)).toBeNull();
  });
});

describe('source labels', () => {
  test('the recording-strip vocabulary, never a bare filename as a title', () => {
    expect(clipSourceLabel({ sourceKind: 'teams', mine: true })).toBe('Teams recording');
    expect(clipSourceLabel({ sourceKind: 'meet', mine: true })).toBe('Meet recording');
    expect(clipSourceLabel({ sourceKind: 'recorder', mine: true })).toBe('Recorded on your Mac');
    expect(
      clipSourceLabel({ sourceKind: 'recorder', mine: false, ownerName: 'Atira Wijaya' })
    ).toBe('Recorded on Atira’s Mac');
    expect(
      clipSourceLabel({ sourceKind: 'upload', mine: true, originalFilename: 'corridor.m4a' })
    ).toBe('Upload · corridor.m4a');
    // Somebody else's upload names them, so the clip list says whose bytes
    // these are (spec §Privacy: "the clip list names the recording's owner").
    expect(
      clipSourceLabel({
        sourceKind: 'upload',
        mine: false,
        ownerEmail: 'kawen@trames.sg',
        originalFilename: 'teams-day.mp4',
      })
    ).toBe('kawen’s upload · teams-day.mp4');
  });

  test('an unknown kind still says something rather than nothing', () => {
    expect(clipSourceLabel({ sourceKind: null, mine: true })).toBe('Upload');
  });
});

describe('the speaker namespace', () => {
  test('a prefixed label round-trips', () => {
    const label = prefixSpeakerLabel(R2, 'A');
    expect(label).toBe(`${R2}:A`);
    expect(splitSpeakerLabel(label)).toEqual({ recordingId: R2, speaker: 'A' });
  });

  test('a bare label is a single-recording meeting and keeps its letter', () => {
    expect(splitSpeakerLabel('A')).toEqual({ recordingId: null, speaker: 'A' });
  });

  test('a real name with a colon in it is NOT a namespace', () => {
    // Meet/Teams imports carry real names as speaker labels.
    expect(splitSpeakerLabel('Kawen: Koh')).toEqual({ recordingId: null, speaker: 'Kawen: Koh' });
  });
});

describe('the align answer', () => {
  test('confidence decides what the UI is allowed to say', () => {
    expect(alignVerdict(0.9)).toBe('good');
    expect(alignVerdict(0.5)).toBe('weak');
    expect(alignVerdict(ALIGN_MIN_CONFIDENCE - 0.01)).toBe('none');
    expect(alignAdvice(0.9)).toBeNull();
    expect(alignAdvice(0.2)).toContain('by ear');
    expect(alignAdvice(0.5)).toContain('weak');
  });

  test('the nominal offset is the difference between the two clocks', () => {
    expect(
      nominalOffsetMsBetween('2026-09-03T02:00:00Z', '2026-09-03T03:50:00Z')
    ).toBe(6_600_000);
    // Either clock missing means there is no nominal — the search widens to
    // ±30 min instead of pretending to 0.
    expect(nominalOffsetMsBetween(null, '2026-09-03T03:50:00Z')).toBeNull();
    expect(nominalOffsetMsBetween('nonsense', '2026-09-03T03:50:00Z')).toBeNull();
  });
});

describe('counting recordings', () => {
  test('two windows of ONE recording are one recording', () => {
    expect(recordingCountOf([clip({ ord: 0 }), clip({ ord: 1, offsetMs: 1000 })])).toBe(1);
    expect(recordingCountOf([clip({ ord: 0 }), clip({ ord: 1, recordingId: R2 })])).toBe(2);
  });
});

describe('refusal text', () => {
  test('every code has a sentence a person can act on', () => {
    for (const code of [
      'disabled',
      'read-only',
      'recording-not-found',
      'not-owned',
      'already-clipped',
      'not-transcribed',
      'too-many-clips',
      'last-clip',
      'clip-not-found',
      'window-invalid',
      'offset-invalid',
      'policy-invalid',
      'no-clip',
      'upload-deferred',
    ] as const) {
      const r = combineRefusal(code);
      expect(r.code).toBe(code);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

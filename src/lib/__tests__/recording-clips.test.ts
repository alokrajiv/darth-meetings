import { describe, expect, test } from 'bun:test';
import type { TranscriptResponse } from '../format';
import {
  compareClipsOnTimeline,
  GAP_FILL_TOLERANCE_MS,
  isCompatClipSet,
  isUtteranceKey,
  resolveClips,
  type ResolvableClip,
} from '../recording-clips';

// Realistic AAI payload shapes: `text` is the raw join of the utterance
// texts, `words` carry their own speaker, times are ms from the start of the
// file AssemblyAI heard (lib/format.ts TranscriptResponse).
const REC_A = '11111111-1111-5111-8111-111111111111';
const REC_B = '22222222-2222-5222-8222-222222222222';

const payloadA: TranscriptResponse = {
  id: 'aai-job-a',
  status: 'completed',
  text: 'Morning everyone. Shall we start with the SI-BL backlog? Sure, I have the numbers.',
  created: '2026-09-20T02:00:00Z',
  completed: '2026-09-20T02:11:00Z',
  audio_duration: 18,
  language_code: 'en',
  confidence: 0.93,
  speech_model_used: 'universal',
  // 6–14 s is a silence, which is what the gap_fill cases below fill.
  utterances: [
    { speaker: 'A', text: 'Morning everyone.', start: 0, end: 2000 },
    { speaker: 'A', text: 'Shall we start with the SI-BL backlog?', start: 3000, end: 6000 },
    { speaker: 'B', text: 'Sure, I have the numbers.', start: 14_000, end: 17_500 },
  ],
  words: [
    { text: 'Morning', start: 0, end: 900, confidence: 0.99, speaker: 'A' },
    { text: 'everyone.', start: 950, end: 2000, confidence: 0.98, speaker: 'A' },
    { text: 'Shall', start: 3000, end: 3300, confidence: 0.97, speaker: 'A' },
    { text: 'backlog?', start: 5400, end: 6000, confidence: 0.95, speaker: 'A' },
    { text: 'Sure,', start: 14_000, end: 14_400, confidence: 0.99, speaker: 'B' },
    { text: 'numbers.', start: 16_800, end: 17_500, confidence: 0.96, speaker: 'B' },
  ],
};

const payloadB: TranscriptResponse = {
  id: 'aai-job-b',
  status: 'completed',
  text: 'Can you hear me now? Yes, much better.',
  created: '2026-09-20T02:00:00Z',
  completed: '2026-09-20T02:09:00Z',
  audio_duration: 9,
  language_code: 'en',
  confidence: 0.88,
  speech_model_used: 'universal',
  utterances: [
    { speaker: 'A', text: 'Can you hear me now?', start: 0, end: 1500 },
    { speaker: 'B', text: 'Yes, much better.', start: 4000, end: 6000 },
  ],
  words: [
    { text: 'Can', start: 0, end: 200, confidence: 0.9, speaker: 'A' },
    { text: 'now?', start: 1200, end: 1500, confidence: 0.9, speaker: 'A' },
    { text: 'Yes,', start: 4000, end: 4300, confidence: 0.94, speaker: 'B' },
  ],
};

const MEETING = {
  id: 'ee0dd6b0-0e1e-4a9f-9f0a-55f0f4b1c000',
  createdAt: '2026-09-20T02:30:00Z',
  completedAt: '2026-09-20T02:45:00Z',
};

function clip(over: Partial<ResolvableClip> = {}): ResolvableClip {
  return {
    ord: 0,
    recordingId: REC_A,
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    textPolicy: 'include',
    payload: payloadA,
    ...over,
  };
}

describe('compat mode — the byte-identity contract', () => {
  test('one default clip returns the stored payload by REFERENCE', () => {
    const out = resolveClips([clip()], MEETING);
    expect(out.compat).toBe(true);
    // Not "deep equal" — the same object. A map or a re-join here would
    // re-serialise the JSON and break /content, the offline caches and
    // darth-cli all at once.
    expect(out.content).toBe(payloadA);
    expect(JSON.stringify(out.content)).toBe(JSON.stringify(payloadA));
  });

  test('edit keys stay plain "<index>" strings', () => {
    expect(resolveClips([clip()], MEETING).utteranceKeys).toEqual(['0', '1', '2']);
  });

  test('speakers are NOT prefixed', () => {
    const out = resolveClips([clip()], MEETING);
    expect(out.content?.utterances?.map((u) => u.speaker)).toEqual(['A', 'A', 'B']);
  });

  test('a clip with no payload yet is still compat, with null content', () => {
    const out = resolveClips([clip({ payload: null })], MEETING);
    expect(out.compat).toBe(true);
    expect(out.content).toBeNull();
    expect(out.utteranceKeys).toEqual([]);
  });

  test('isCompatClipSet rejects anything but one untouched clip', () => {
    expect(isCompatClipSet([clip()])).toBe(true);
    expect(isCompatClipSet([clip({ fromMs: 1 })])).toBe(false);
    expect(isCompatClipSet([clip({ toMs: 10_000 })])).toBe(false);
    expect(isCompatClipSet([clip({ offsetMs: 500 })])).toBe(false);
    expect(isCompatClipSet([clip({ textPolicy: 'gap_fill' })])).toBe(false);
    expect(isCompatClipSet([clip(), clip({ ord: 1 })])).toBe(false);
    expect(isCompatClipSet([])).toBe(false);
  });

  // §5a: the clip alone decides. "The transcription did not cover the
  // canonical media" used to force the merge branch; it no longer can, and
  // resolveClips has no override left for a caller to pass.
  test('nothing outside the clip can take a 1:1 meeting out of compat', () => {
    expect(resolveClips.length).toBe(2); // (clips, meeting) — no opts
    const out = resolveClips([clip()], MEETING);
    expect(out.compat).toBe(true);
    expect(out.content).toBe(payloadA);
    expect(out.content?.utterances?.[0]?.speaker).toBe('A');
  });
});

describe('the edit-map key space', () => {
  test('accepts exactly the keys resolveClips mints', () => {
    // Compat — what every transcript_edits row in prod is keyed by.
    for (const k of resolveClips([clip()], MEETING).utteranceKeys) {
      expect(isUtteranceKey(k)).toBe(true);
    }
    // Non-compat — `<recordingId>:<index>`.
    const merged = resolveClips(
      [clip({ ord: 0 }), clip({ ord: 1, recordingId: REC_B, payload: payloadB, offsetMs: 20_000 })],
      MEETING
    );
    expect(merged.utteranceKeys.length).toBeGreaterThan(0);
    for (const k of merged.utteranceKeys) expect(isUtteranceKey(k)).toBe(true);
  });

  test('rejects anything else — the route validates writes with this', () => {
    expect(isUtteranceKey('')).toBe(false);
    expect(isUtteranceKey('-1')).toBe(false);
    expect(isUtteranceKey('1.5')).toBe(false);
    expect(isUtteranceKey('speaker')).toBe(false);
    expect(isUtteranceKey(`${REC_A}:`)).toBe(false);
    expect(isUtteranceKey(`${REC_A}:x`)).toBe(false);
    expect(isUtteranceKey(`not-a-uuid:0`)).toBe(false);
    expect(isUtteranceKey(`${REC_A}:0:0`)).toBe(false);
    expect(isUtteranceKey(' 0')).toBe(false);
  });
});

describe('meeting-timeline order (§5a: offset_ms, then ord)', () => {
  test('compareClipsOnTimeline sorts by offset first and uses ord only to break ties', () => {
    const clips = [
      { ord: 0, offsetMs: 9000 },
      { ord: 2, offsetMs: 0 },
      { ord: 1, offsetMs: 0 },
    ];
    expect([...clips].sort(compareClipsOnTimeline)).toEqual([
      { ord: 1, offsetMs: 0 },
      { ord: 2, offsetMs: 0 },
      { ord: 0, offsetMs: 9000 },
    ]);
  });
});

describe('two recordings, one meeting', () => {
  const clips: ResolvableClip[] = [
    clip({ ord: 0 }),
    clip({ ord: 1, recordingId: REC_B, payload: payloadB, offsetMs: 20_000 }),
  ];

  test('clips concatenate in ord order with their offsets applied', () => {
    const out = resolveClips(clips, MEETING);
    expect(out.compat).toBe(false);
    expect(out.content?.utterances?.map((u) => [u.start, u.end])).toEqual([
      [0, 2000],
      [3000, 6000],
      [14_000, 17_500],
      [20_000, 21_500],
      [24_000, 26_000],
    ]);
  });

  test('speaker labels are namespaced so A of one recording is not A of the other', () => {
    const out = resolveClips(clips, MEETING);
    expect(out.content?.utterances?.map((u) => u.speaker)).toEqual([
      `${REC_A}:A`,
      `${REC_A}:A`,
      `${REC_A}:B`,
      `${REC_B}:A`,
      `${REC_B}:B`,
    ]);
  });

  test('edit keys carry the recording and the index inside ITS transcription', () => {
    const out = resolveClips(clips, MEETING);
    expect(out.utteranceKeys).toEqual([
      `${REC_A}:0`,
      `${REC_A}:1`,
      `${REC_A}:2`,
      `${REC_B}:0`,
      `${REC_B}:1`,
    ]);
  });

  test('derived text is the join of what the meeting actually shows', () => {
    const out = resolveClips(clips, MEETING);
    expect(out.content?.text).toBe(
      'Morning everyone. Shall we start with the SI-BL backlog? Sure, I have the numbers. Can you hear me now? Yes, much better.'
    );
  });

  test('derived payload: meeting identity, span, and only the facts both jobs agree on', () => {
    const out = resolveClips(clips, MEETING);
    expect(out.content?.id).toBe(MEETING.id);
    expect(out.content?.created).toBe(MEETING.createdAt);
    expect(out.content?.completed).toBe(MEETING.completedAt);
    expect(out.content?.status).toBe('completed');
    expect(out.content?.audio_duration).toBe(26);
    expect(out.content?.language_code).toBe('en'); // both 'en'
    expect(out.content?.confidence).toBeUndefined(); // 0.93 vs 0.88
  });

  test('a language mismatch leaves language_code off rather than lying', () => {
    const out = resolveClips(
      [clips[0]!, { ...clips[1]!, payload: { ...payloadB, language_code: 'id' } }],
      MEETING
    );
    expect(out.content?.language_code).toBeUndefined();
  });

  test('status degrades to the worst of the contributing jobs', () => {
    const erroring = { ...payloadB, status: 'error' as const };
    expect(
      resolveClips([clips[0]!, { ...clips[1]!, payload: erroring }], MEETING).content?.status
    ).toBe('error');
    const running = { ...payloadB, status: 'processing' as const };
    expect(
      resolveClips([clips[0]!, { ...clips[1]!, payload: running }], MEETING).content?.status
    ).toBe('processing');
  });
});

describe('window edges — from_ms inclusive, to_ms exclusive', () => {
  test('an utterance starting exactly at from_ms is in; one at to_ms is out', () => {
    const out = resolveClips([clip({ fromMs: 3000, toMs: 10_000, offsetMs: 0 })], MEETING);
    expect(out.content?.utterances?.map((u) => u.text)).toEqual([
      'Shall we start with the SI-BL backlog?',
    ]);
    // ONE recording ⇒ one diarization space ⇒ plain index keys, keyed to the
    // position in the MATERIALISED list this meeting shows (Phase 3a). A
    // split re-keys the edits at split time (lib/clips.ts `rekeyEditMap`);
    // the recording-scoped key space is for two recordings, not two windows.
    expect(out.utteranceKeys).toEqual(['0']);
  });

  test('from_ms shifts the window to offset_ms on the meeting timeline', () => {
    const out = resolveClips([clip({ fromMs: 3000, toMs: null, offsetMs: 0 })], MEETING);
    expect(out.content?.utterances?.map((u) => [u.start, u.end])).toEqual([
      [0, 3000],
      [11_000, 14_500],
    ]);
  });

  test('offset_ms places the window anywhere on the meeting timeline', () => {
    const out = resolveClips([clip({ fromMs: 3000, toMs: null, offsetMs: 60_000 })], MEETING);
    expect(out.content?.utterances?.[0]?.start).toBe(60_000);
  });

  test('an empty window yields no utterances and no content', () => {
    const out = resolveClips([clip({ fromMs: 90_000, toMs: 95_000 })], MEETING);
    expect(out.content?.utterances).toEqual([]);
    expect(out.content?.text).toBe('');
  });
});

// Phase 3a (docs/recordings-phase3-clips-spec.md "Model"): DEC-1 says one
// recording is one job and one diarization space, so however many WINDOWS of
// it a meeting takes, "A" means the same person throughout. Prefixing and the
// recording-scoped key space are earned only by a second recording (3b).
describe('one recording, several windows — the split source', () => {
  // What a shrink leaves behind: 0–3 s and 14 s→end, with the 3–14 s window
  // now a meeting of its own. M keeps its original timeline (the hole is at
  // 3–14 s), so every `t:<ms>` in its notes still points at the right moment.
  const shrunk: ResolvableClip[] = [
    clip({ ord: 0, fromMs: 0, toMs: 3000, offsetMs: 0 }),
    clip({ ord: 1, fromMs: 14_000, toMs: null, offsetMs: 14_000 }),
  ];

  test('speaker labels stay exactly as AssemblyAI diarized them', () => {
    const out = resolveClips(shrunk, MEETING);
    expect(out.compat).toBe(false);
    expect(out.content?.utterances?.map((u) => u.speaker)).toEqual(['A', 'B']);
    expect(out.content?.words?.every((w) => w.speaker === 'A' || w.speaker === 'B')).toBe(true);
  });

  test('edit keys are the positions in the list the meeting actually shows', () => {
    const out = resolveClips(shrunk, MEETING);
    // Utterance 1 of the recording went to the other meeting; what is left is
    // re-keyed 0,1 — which is what the row stores and what the page renders.
    expect(out.content?.utterances?.map((u) => u.text)).toEqual([
      'Morning everyone.',
      'Sure, I have the numbers.',
    ]);
    expect(out.utteranceKeys).toEqual(['0', '1']);
    for (const k of out.utteranceKeys) expect(isUtteranceKey(k)).toBe(true);
  });

  test('the hole is kept: the remaining windows sit where they always were', () => {
    const out = resolveClips(shrunk, MEETING);
    expect(out.content?.utterances?.map((u) => [u.start, u.end])).toEqual([
      [0, 2000],
      [14_000, 17_500],
    ]);
  });

  test('the split-off meeting starts at 0 and keys from 0', () => {
    const out = resolveClips([clip({ ord: 0, fromMs: 3000, toMs: 14_000, offsetMs: 0 })], MEETING);
    expect(out.content?.utterances?.map((u) => [u.start, u.text])).toEqual([
      [0, 'Shall we start with the SI-BL backlog?'],
    ]);
    expect(out.utteranceKeys).toEqual(['0']);
    expect(out.content?.utterances?.[0]?.speaker).toBe('A');
  });
});

describe('words ride the same window', () => {
  test('windowed and shifted like their utterances, labels untouched', () => {
    const out = resolveClips([clip({ fromMs: 3000, toMs: 10_000, offsetMs: 1000 })], MEETING);
    expect(out.content?.words).toEqual([
      { text: 'Shall', start: 1000, end: 1300, confidence: 0.97, speaker: 'A' },
      { text: 'backlog?', start: 3400, end: 4000, confidence: 0.95, speaker: 'A' },
    ]);
  });

  test('a payload with no words produces no words key', () => {
    const noWords = { ...payloadA, words: undefined };
    const out = resolveClips([clip({ payload: noWords, fromMs: 1 })], MEETING);
    expect(out.content?.words).toBeUndefined();
  });
});

describe('overlapping clips under each text_policy', () => {
  // The SI-BL shape: a primary recording over the whole meeting and a phone
  // clip covering the middle of it.
  const primary = clip({ ord: 0, textPolicy: 'include' });
  const phone = (textPolicy: ResolvableClip['textPolicy']): ResolvableClip => ({
    ord: 1,
    recordingId: REC_B,
    fromMs: 0,
    toMs: null,
    offsetMs: 4000, // B's 0 lands at 4 s → its two utterances at 4–5.5 s and 8–10 s
    textPolicy,
    payload: payloadB,
  });

  test('include — both mics contribute, merged in time order', () => {
    const out = resolveClips([primary, phone('include')], MEETING);
    expect(out.content?.utterances?.map((u) => [u.start, u.text])).toEqual([
      [0, 'Morning everyone.'],
      [3000, 'Shall we start with the SI-BL backlog?'],
      [4000, 'Can you hear me now?'],
      [8000, 'Yes, much better.'],
      [14_000, 'Sure, I have the numbers.'],
    ]);
    expect(out.utteranceKeys).toEqual([
      `${REC_A}:0`,
      `${REC_A}:1`,
      `${REC_B}:0`,
      `${REC_B}:1`,
      `${REC_A}:2`,
    ]);
  });

  test('exclude — the clip is playable but contributes no text', () => {
    const out = resolveClips([primary, phone('exclude')], MEETING);
    expect(out.content?.utterances?.map((u) => u.text)).toEqual([
      'Morning everyone.',
      'Shall we start with the SI-BL backlog?',
      'Sure, I have the numbers.',
    ]);
    expect(out.content?.utterances?.every((u) => u.speaker.startsWith(`${REC_A}:`))).toBe(true);
  });

  test('gap_fill — only where the primary has no speech within ±1.5 s', () => {
    const out = resolveClips([primary, phone('gap_fill')], MEETING);
    // B's first utterance (4000–5500) sits inside the primary's 3000–6000 →
    // dropped. Its second (8000–10 000) sits in the 6–14 s silence, 2 s clear
    // of both neighbours → kept.
    expect(out.content?.utterances?.map((u) => [u.start, u.text])).toEqual([
      [0, 'Morning everyone.'],
      [3000, 'Shall we start with the SI-BL backlog?'],
      [8000, 'Yes, much better.'],
      [14_000, 'Sure, I have the numbers.'],
    ]);
  });

  test('gap_fill tolerance is exactly ±1.5 s from the primary speech', () => {
    const filler = (offsetMs: number): ResolvableClip => ({
      ord: 1,
      recordingId: REC_B,
      fromMs: 0,
      toMs: 1600,
      offsetMs,
      textPolicy: 'gap_fill',
      payload: payloadB,
    });
    // Primary speech ends at 6000. A filler starting 1499 ms later is
    // suppressed; 1500 ms later is kept.
    const tooClose = resolveClips([primary, filler(6000 + GAP_FILL_TOLERANCE_MS - 1)], MEETING);
    expect(tooClose.content?.utterances?.map((u) => u.text)).not.toContain('Can you hear me now?');
    const clear = resolveClips([primary, filler(6000 + GAP_FILL_TOLERANCE_MS)], MEETING);
    expect(clear.content?.utterances?.map((u) => u.text)).toContain('Can you hear me now?');
  });

  test('gap_fill yields to every include clip, whatever the clip order', () => {
    const fillerFirst: ResolvableClip = { ...phone('gap_fill'), ord: 0 };
    const primaryLast: ResolvableClip = { ...primary, ord: 1 };
    const out = resolveClips([fillerFirst, primaryLast], MEETING);
    expect(out.content?.utterances?.map((u) => u.text)).not.toContain('Can you hear me now?');
  });

  test('gap_fill drops the words of the utterances it dropped', () => {
    const out = resolveClips([primary, phone('gap_fill')], MEETING);
    expect(out.content?.words?.map((w) => w.text)).not.toContain('Can');
    expect(out.content?.words?.map((w) => w.text)).toContain('Yes,');
  });

  test('non-overlapping clips come out in TIMELINE order, whatever their ord', () => {
    const out = resolveClips(
      [
        // A's first 6 s, placed at 6–12 s on the meeting timeline, authored
        // first …
        clip({ ord: 0, toMs: 6000, offsetMs: 6000 }),
        // … and B, placed at 0–6 s, authored second.
        clip({ ord: 1, recordingId: REC_B, payload: payloadB, offsetMs: 0 }),
      ],
      MEETING
    );
    // §5a: `ord` is identity, not position — the clip that starts earlier is
    // read first even though it was added later. (The windows only touch, so
    // the overlap sort never runs: this is the clip order itself.)
    expect(out.content?.utterances?.map((u) => [u.start, u.speaker])).toEqual([
      [0, `${REC_B}:A`],
      [4000, `${REC_B}:B`],
      [6000, `${REC_A}:A`],
      [9000, `${REC_A}:A`],
    ]);
    expect(out.utteranceKeys).toEqual([`${REC_B}:0`, `${REC_B}:1`, `${REC_A}:0`, `${REC_A}:1`]);
  });
});

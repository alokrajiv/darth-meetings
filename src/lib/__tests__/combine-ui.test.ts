import { describe, expect, test } from 'bun:test';
import {
  POLICY_CHOICES,
  alignTimeline,
  alignVerdictLine,
  candidateFacts,
  clipRows,
  combineSummary,
  groupCandidates,
  localMsInPart,
  meetingMsOfPart,
  nudgeLabel,
  nudgeOffset,
  ownerDisplay,
  pendingAttachLine,
  playerParts,
  policyLabel,
  shortSourceTag,
  slotsLeftText,
  sourceTagOfEntry,
  sourceTagsByRecording,
} from '@/lib/combine-ui';
import {
  alignAdvice,
  alignVerdict,
  clipShortLabel,
  clipSourceKindOf,
  clipSourceLabel,
  type ClipCandidate,
  type ClipEntry,
  type PendingAttach,
} from '@/lib/clips';

/**
 * The display half of "several recordings, one meeting" (Phase 3b). Every
 * sentence the sheet, the card, the align step and the player put on screen is
 * a pure function, so it is checked here rather than by looking at a browser.
 *
 * TZ-independent on purpose: nothing below formats a wall-clock time.
 */

function entry(over: Partial<ClipEntry> & Pick<ClipEntry, 'ord' | 'recordingId'>): ClipEntry {
  return {
    fromMs: 0,
    toMs: null,
    offsetMs: 0,
    textPolicy: 'include',
    transcribed: true,
    durationMs: 600_000,
    sourceLabel: 'Upload · teams-day.m4a',
    sourceKind: 'upload',
    shortLabel: 'teams-day.m4a',
    ownerEmail: 'alok@trames.sg',
    ownerName: 'Alok Rajiv',
    mine: true,
    primary: false,
    recordingDurationMs: 600_000,
    recordingStartedAt: null,
    mediaPart: null,
    mediaParts: [],
    ...over,
  };
}

const TEAMS = entry({
  ord: 0,
  recordingId: 'r-teams',
  sourceLabel: 'Teams recording',
  sourceKind: 'teams',
  shortLabel: 'Teams',
  primary: true,
  durationMs: 600_000,
  recordingDurationMs: 600_000,
  mediaPart: 1,
  mediaParts: [1],
});
const PHONE = entry({
  ord: 1,
  recordingId: 'r-phone',
  sourceLabel: 'Atira’s upload · corridor.m4a',
  sourceKind: 'upload',
  shortLabel: 'corridor.m4a',
  offsetMs: 110_000,
  durationMs: 300_000,
  recordingDurationMs: 300_000,
  textPolicy: 'gap_fill',
  mine: false,
  ownerName: 'Atira Sarat',
  ownerEmail: 'atira.sarat@trames.sg',
  mediaPart: 2,
  mediaParts: [2],
});

describe('shortSourceTag', () => {
  test('keeps the filename of an upload, whoever owns it', () => {
    expect(shortSourceTag('Upload · corridor.m4a')).toBe('corridor.m4a');
    expect(shortSourceTag('Atira’s upload · corridor.m4a')).toBe('corridor.m4a');
  });

  test('names the Mac, not the sentence about it', () => {
    expect(shortSourceTag('Recorded on your Mac')).toBe('your Mac');
    expect(shortSourceTag('Recorded on Atira’s Mac')).toBe('Atira’s Mac');
  });

  test('drops the word "recording" but keeps the owner', () => {
    expect(shortSourceTag('Teams recording')).toBe('Teams');
    expect(shortSourceTag('Meet recording')).toBe('Meet');
    expect(shortSourceTag('Atira’s Teams recording')).toBe('Atira’s Teams');
  });

  test('anything it does not recognise survives verbatim — never a guess', () => {
    expect(shortSourceTag('Imported transcription')).toBe('Imported transcription');
    expect(shortSourceTag('Pasted transcript')).toBe('Pasted transcript');
    expect(shortSourceTag('Upload')).toBe('Upload');
    expect(shortSourceTag('')).toBe('');
  });

  test('tags are keyed by recording so an utterance can find its own', () => {
    const tags = sourceTagsByRecording([TEAMS, PHONE]);
    expect(tags.get('r-teams')).toBe('Teams');
    expect(tags.get('r-phone')).toBe('corridor.m4a');
    expect(tags.get('nobody')).toBeUndefined();
  });
});

describe('the served shortLabel, not a re-read of the sentence', () => {
  test('`clipShortLabel` shortens the same FACTS `clipSourceLabel` spells out', () => {
    const cases: Array<[Parameters<typeof clipShortLabel>[0], string, string]> = [
      [{ sourceKind: 'teams', mine: true }, 'Teams recording', 'Teams'],
      [
        { sourceKind: 'teams', mine: false, ownerName: 'Atira Sarat' },
        'Atira’s Teams recording',
        'Atira’s Teams',
      ],
      [{ sourceKind: 'meet', mine: true }, 'Meet recording', 'Meet'],
      [{ sourceKind: 'recorder', mine: true }, 'Recorded on your Mac', 'your Mac'],
      [
        { sourceKind: 'recorder', mine: false, ownerEmail: 'atira@trames.sg' },
        'Recorded on atira’s Mac',
        'atira’s Mac',
      ],
      [{ sourceKind: 'text', mine: true }, 'Pasted transcript', 'Pasted transcript'],
      [{ sourceKind: 'aai-import', mine: true }, 'Imported transcription', 'Imported transcription'],
      [
        { sourceKind: 'upload', mine: true, originalFilename: 'corridor.m4a' },
        'Upload · corridor.m4a',
        'corridor.m4a',
      ],
      [{ sourceKind: 'upload', mine: true }, 'Upload', 'Upload'],
      [
        { sourceKind: 'upload', mine: false, ownerName: 'Atira Sarat' },
        'Atira’s upload',
        'Atira’s upload',
      ],
    ];
    for (const [facts, sentence, short] of cases) {
      expect(clipSourceLabel(facts)).toBe(sentence);
      expect(clipShortLabel(facts)).toBe(short);
      // …and the old reverse-parse agrees on every shape it was written for,
      // which is what makes it a safe fallback.
      expect(shortSourceTag(sentence)).toBe(short);
    }
  });

  test('a name containing " · " is where the reverse-parse breaks and the facts do not', () => {
    const facts = { sourceKind: 'recorder' as const, mine: false, ownerName: 'A · B Lim' };
    expect(clipShortLabel(facts)).toBe('A’s Mac');
    // The sentence is "Recorded on A’s Mac" — but a filename-bearing sentence
    // from the same owner would be mis-split by the " · " rule, so the short
    // form has to come from the facts.
    expect(shortSourceTag('Atira’s upload · a · b.m4a')).toBe('a · b.m4a');
    expect(
      clipShortLabel({ sourceKind: 'upload', mine: false, ownerName: 'Atira', originalFilename: 'a · b.m4a' })
    ).toBe('a · b.m4a');
  });

  test('sourceKind is narrowed, never guessed', () => {
    expect(clipSourceKindOf('teams')).toBe('teams');
    expect(clipSourceKindOf('aai-import')).toBe('aai-import');
    expect(clipSourceKindOf('gopro')).toBeNull();
    expect(clipSourceKindOf(null)).toBeNull();
  });

  test('an entry uses its shortLabel; one without falls back to the sentence', () => {
    expect(sourceTagOfEntry(PHONE)).toBe('corridor.m4a');
    expect(sourceTagOfEntry({ ...PHONE, shortLabel: '' })).toBe('corridor.m4a');
    expect(
      sourceTagOfEntry({ shortLabel: 'the phone', sourceLabel: 'Atira’s upload · corridor.m4a' })
    ).toBe('the phone');
  });
});

describe('combineSummary', () => {
  test('one recording says nothing at all — prod reads exactly as before', () => {
    expect(combineSummary([TEAMS])).toBeNull();
    expect(combineSummary([])).toBeNull();
    expect(combineSummary(null)).toBeNull();
  });

  test('two clips on ONE recording are still one recording', () => {
    const second = entry({ ord: 1, recordingId: 'r-teams', offsetMs: 300_000 });
    expect(combineSummary([TEAMS, second])).toBeNull();
  });

  test('two recordings read as the spec writes them', () => {
    const s = combineSummary([TEAMS, PHONE])!;
    expect(s.heading).toBe('2 recordings');
    expect(s.recordingCount).toBe(2);
    expect(s.parts[0]!.text).toBe('Teams recording (10m 00s)');
    expect(s.parts[1]!.text).toBe('Atira’s upload · corridor.m4a (5m 00s from 1:50)');
    expect(s.text).toBe(
      'Teams recording (10m 00s) · Atira’s upload · corridor.m4a (5m 00s from 1:50)'
    );
  });

  test('timeline order, not ord order', () => {
    const late = entry({ ord: 0, recordingId: 'r-late', offsetMs: 500_000, sourceLabel: 'Meet recording' });
    const early = entry({ ord: 5, recordingId: 'r-early', offsetMs: 0, sourceLabel: 'Teams recording' });
    expect(combineSummary([late, early])!.parts.map((p) => p.ord)).toEqual([5, 0]);
  });

  test('an unknown length leaves the length out rather than inventing one', () => {
    const unknown = entry({ ord: 1, recordingId: 'r-x', durationMs: null, offsetMs: 60_000 });
    const s = combineSummary([TEAMS, unknown])!;
    expect(s.parts[1]!.duration).toBeNull();
    expect(s.parts[1]!.text).toBe('Upload · teams-day.m4a (from 1:00)');
  });
});

describe('clipRows', () => {
  test('names the owner of every clip', () => {
    const rows = clipRows([TEAMS, PHONE]);
    expect(rows.map((r) => r.owner)).toEqual(['you', 'Atira Sarat']);
  });

  test('the last clip cannot be removed, and the row says why', () => {
    const only = clipRows([TEAMS]);
    expect(only[0]!.removeBlockedReason).toContain('only recording');
    const both = clipRows([TEAMS, PHONE]);
    expect(both.every((r) => r.removeBlockedReason === null)).toBe(true);
  });

  test('a recording still transcribing may not leave "Audio only"', () => {
    const pending = entry({ ord: 1, recordingId: 'r-p', transcribed: false, textPolicy: 'exclude' });
    const rows = clipRows([TEAMS, pending]);
    expect(rows[0]!.policyBlockedReason).toBeNull();
    expect(rows[1]!.policyBlockedReason).toContain('Audio only');
  });

  test('ownerDisplay falls back email → "someone else", never to an empty string', () => {
    expect(ownerDisplay({ mine: true, ownerName: null, ownerEmail: null })).toBe('you');
    expect(ownerDisplay({ mine: false, ownerName: null, ownerEmail: 'k@trames.sg' })).toBe('k@trames.sg');
    expect(ownerDisplay({ mine: false, ownerName: '  ', ownerEmail: '' })).toBe('someone else');
  });
});

describe('policies', () => {
  test('the three the spec names, in the order it names them', () => {
    expect(POLICY_CHOICES.map((p) => p.value)).toEqual(['include', 'gap_fill', 'exclude']);
    expect(POLICY_CHOICES.map((p) => p.label)).toEqual(['Text', 'Fill gaps only', 'Audio only']);
  });

  test('policyLabel is total', () => {
    expect(policyLabel('gap_fill')).toBe('Fill gaps only');
    expect(policyLabel('exclude')).toBe('Audio only');
    expect(policyLabel('include')).toBe('Text');
  });
});

describe('groupCandidates', () => {
  function candidate(over: Partial<ClipCandidate> & Pick<ClipCandidate, 'recordingId'>): ClipCandidate {
    return {
      sourceLabel: 'Upload · corridor.m4a',
      startedAt: null,
      durationMs: 300_000,
      transcribed: true,
      mine: true,
      ownerEmail: 'alok@trames.sg',
      ownerName: 'Alok Rajiv',
      meeting: null,
      unlinked: true,
      addable: true,
      blockedReason: null,
      nominalOffsetMs: null,
      ...over,
    };
  }

  test('meetings first, unlinked second, empty groups dropped', () => {
    const fromMeeting = candidate({
      recordingId: 'a',
      unlinked: false,
      meeting: { id: 'm1', url: '/transcript/m1', title: 'Hypercare' },
    });
    const bare = candidate({ recordingId: 'b' });
    expect(groupCandidates([bare, fromMeeting]).map((g) => g.key)).toEqual(['meeting', 'unlinked']);
    expect(groupCandidates([bare]).map((g) => g.key)).toEqual(['unlinked']);
    expect(groupCandidates([])).toEqual([]);
  });

  test('a recording the caller may NOT add is kept, not hidden', () => {
    const theirs = candidate({
      recordingId: 'c',
      mine: false,
      addable: false,
      blockedReason: 'That recording belongs to someone else.',
      unlinked: false,
      meeting: { id: 'm2', url: '/transcript/m2', title: 'Their call' },
    });
    const groups = groupCandidates([theirs]);
    expect(groups[0]!.candidates[0]!.addable).toBe(false);
    expect(groups[0]!.candidates[0]!.blockedReason).toBeTruthy();
  });

  test('candidateFacts says what it is and whose', () => {
    expect(candidateFacts(candidate({ recordingId: 'a' }))).toBe('5m 00s · transcribed');
    expect(candidateFacts(candidate({ recordingId: 'a', transcribed: false }))).toBe(
      '5m 00s · still transcribing'
    );
    expect(
      candidateFacts(candidate({ recordingId: 'a', mine: false, ownerName: 'Kawen', durationMs: null }))
    ).toBe('transcribed · Kawen');
  });

  test('slotsLeftText counts down to a full meeting', () => {
    expect(slotsLeftText(4)).toBe('4 more recordings can be added.');
    expect(slotsLeftText(1)).toBe('1 more recording can be added.');
    expect(slotsLeftText(0)).toContain('full');
  });
});

describe('alignTimeline', () => {
  test('the new lane moves with the offset; the existing ones do not', () => {
    const at0 = alignTimeline({
      entries: [TEAMS],
      candidate: { label: 'corridor.m4a', durationMs: 300_000 },
      offsetMs: 0,
    });
    expect(at0.spanMs).toBe(600_000);
    expect(at0.lanes[0]!.leftPct).toBe(0);
    expect(at0.lanes[1]!.leftPct).toBe(0);
    expect(at0.lanes[1]!.widthPct).toBeCloseTo(50, 5);

    const at110 = alignTimeline({
      entries: [TEAMS],
      candidate: { label: 'corridor.m4a', durationMs: 300_000 },
      offsetMs: 110_000,
    });
    expect(at110.lanes[0]!.leftPct).toBe(0);
    expect(at110.lanes[1]!.leftPct).toBeCloseTo((110_000 / 600_000) * 100, 5);
    expect(at110.overlapMs).toBe(300_000);
    expect(at110.noOverlap).toBe(false);
  });

  test('a new recording past the end stretches the span and reads as no overlap', () => {
    const t = alignTimeline({
      entries: [TEAMS],
      candidate: { label: 'late.m4a', durationMs: 60_000 },
      offsetMs: 900_000,
    });
    expect(t.spanMs).toBe(960_000);
    expect(t.noOverlap).toBe(true);
    expect(t.overlapMs).toBe(0);
  });

  test('an open-ended recording is flagged rather than given a made-up width', () => {
    const t = alignTimeline({
      entries: [TEAMS],
      candidate: { label: 'unknown', durationMs: null },
      offsetMs: 60_000,
    });
    expect(t.lanes.at(-1)!.openEnded).toBe(true);
    expect(t.lanes.at(-1)!.widthPct).toBeGreaterThan(0);
  });

  test('a negative offset is clamped — the contract refuses one', () => {
    const t = alignTimeline({
      entries: [TEAMS],
      candidate: { label: 'x', durationMs: 60_000 },
      offsetMs: -5_000,
    });
    expect(t.lanes.at(-1)!.leftPct).toBe(0);
  });

  test('an empty meeting still draws something rather than dividing by zero', () => {
    const t = alignTimeline({ entries: [], candidate: { label: 'x', durationMs: 0 }, offsetMs: 0 });
    expect(t.spanMs).toBeGreaterThan(0);
    expect(t.lanes).toHaveLength(1);
    expect(Number.isFinite(t.lanes[0]!.widthPct)).toBe(true);
  });
});

describe('nudges', () => {
  test('the faces read as signs, not hyphens', () => {
    expect(nudgeLabel(-1_000)).toBe('−1s');
    expect(nudgeLabel(10_000)).toBe('+10s');
    expect(nudgeLabel(-60_000)).toBe('−1m');
  });

  test('an offset never goes negative', () => {
    expect(nudgeOffset(5_000, -10_000)).toBe(0);
    expect(nudgeOffset(110_000, 1_000)).toBe(111_000);
  });
});

describe('alignVerdictLine', () => {
  test('under the floor: no number is applied and the words say so', () => {
    const c = 0.2;
    const line = alignVerdictLine({
      verdict: alignVerdict(c),
      offsetMs: 110_000,
      confidence: c,
      driftPpm: null,
      overlapMs: null,
      advice: alignAdvice(c),
    });
    expect(line.tone).toBe('none');
    expect(line.applies).toBe(false);
    expect(line.text).toBe('Could not line these up — set the offset by ear.');
  });

  test('a weak match is offered with the warning attached', () => {
    const c = 0.5;
    const line = alignVerdictLine({
      verdict: alignVerdict(c),
      offsetMs: 110_000,
      confidence: c,
      driftPpm: -47.3,
      overlapMs: 300_000,
      advice: alignAdvice(c),
    });
    expect(line.tone).toBe('warn');
    expect(line.applies).toBe(true);
    expect(line.facts).toBe('1:50 · 50% sure · -47 ppm drift · 5m 00s of shared audio');
  });

  test('a good match names the offset', () => {
    const c = 0.8;
    const line = alignVerdictLine({
      verdict: alignVerdict(c),
      offsetMs: 6_600_000,
      confidence: c,
      driftPpm: null,
      overlapMs: null,
      advice: alignAdvice(c),
    });
    expect(line.tone).toBe('ok');
    expect(line.text).toBe('These line up at 1:50:00.');
    expect(line.facts).toBe('1:50:00 · 80% sure');
  });
});

describe('playerParts', () => {
  test('a one-recording meeting offers NO parts — today’s player, untouched', () => {
    expect(playerParts([TEAMS])).toEqual([]);
    expect(playerParts([])).toEqual([]);
    expect(playerParts(null)).toEqual([]);
  });

  test('parts are the clips, in timeline order, labelled by source', () => {
    const parts = playerParts([PHONE, TEAMS]);
    expect(parts.map((p) => p.label)).toEqual(['Teams', 'corridor.m4a']);
    expect(parts.map((p) => p.ord)).toEqual([0, 1]);
  });

  test('?part=N is the SERVED number, not a count of recordings', () => {
    const parts = playerParts([TEAMS, PHONE]);
    expect(parts.map((p) => p.part)).toEqual([1, 2]);
    expect(parts.map((p) => p.parts)).toEqual([[1], [2]]);
  });

  test('a Meet stop/restart primary pushes the added recording past its own files', () => {
    // The primary holds three files, so the phone the server numbered 4 is
    // asked for at 4 — no `primaryExtraFiles` hint, no client arithmetic.
    const meet = entry({ ...TEAMS, mediaPart: 1, mediaParts: [1, 2, 3] });
    const phone = entry({ ...PHONE, mediaPart: 4, mediaParts: [4] });
    const parts = playerParts([meet, phone]);
    expect(parts.map((p) => p.part)).toEqual([1, 4]);
    expect(parts[0]!.parts).toEqual([1, 2, 3]);
  });

  test('a NON-primary recording with two files: the one the client could never see', () => {
    // Meet stopped and restarted as the SECOND recording — parts 2 and 3 —
    // so a third capture is 4. The old derivation said 3 and played the
    // wrong file; the server's numbering is the only thing that knows.
    const phone = entry({ ...PHONE, mediaPart: 2, mediaParts: [2, 3] });
    const third = entry({
      ord: 2,
      recordingId: 'r-mac',
      sourceLabel: 'Recorded on your Mac',
      sourceKind: 'recorder',
      shortLabel: 'your Mac',
      offsetMs: 500_000,
      mediaPart: 4,
      mediaParts: [4],
    });
    expect(playerParts([TEAMS, phone, third]).map((p) => p.part)).toEqual([1, 2, 4]);
  });

  test('two clips on the same recording share its part number', () => {
    const second = entry({
      ord: 2,
      recordingId: 'r-teams',
      offsetMs: 400_000,
      sourceLabel: 'Teams recording',
      shortLabel: 'Teams',
      mediaPart: 1,
      mediaParts: [1],
    });
    const parts = playerParts([TEAMS, PHONE, second]);
    expect(parts.map((p) => p.part)).toEqual([1, 2, 1]);
  });

  test('a recording with no playable file gets NO chip — never a number that 404s', () => {
    const withheld = entry({ ...PHONE, mediaPart: null, mediaParts: [] });
    const parts = playerParts([TEAMS, withheld]);
    expect(parts.map((p) => p.recordingId)).toEqual(['r-teams']);
  });

  test('an entry list with no part numbers at all falls back to one file each', () => {
    // A response cached before `mediaPart` existed. Right for every meeting
    // whose recordings hold a single file, which is all of them today.
    const old = [
      entry({ ...TEAMS, mediaPart: null, mediaParts: [] }),
      entry({ ...PHONE, mediaPart: null, mediaParts: [] }),
    ];
    expect(playerParts(old).map((p) => p.part)).toEqual([1, 2]);
  });

  test('switching part keeps the meeting time', () => {
    const [teams, phone] = playerParts([TEAMS, PHONE]);
    // 3:00 into the meeting is 3:00 into Teams and 1:10 into the phone.
    expect(localMsInPart(teams!, 180_000)).toBe(180_000);
    expect(localMsInPart(phone!, 180_000)).toBe(70_000);
    expect(meetingMsOfPart(phone!, 70_000)).toBe(180_000);
    expect(meetingMsOfPart(teams!, 180_000)).toBe(180_000);
  });

  test('a moment before a part starts clamps to its beginning, never negative', () => {
    const [, phone] = playerParts([TEAMS, PHONE]);
    expect(localMsInPart(phone!, 0)).toBe(0);
  });

  test('a windowed clip clamps to the end of its window', () => {
    const windowed = entry({
      ord: 1,
      recordingId: 'r-w',
      fromMs: 60_000,
      toMs: 120_000,
      offsetMs: 0,
      durationMs: 60_000,
      mediaPart: 2,
      mediaParts: [2],
    });
    const [, part] = playerParts([TEAMS, windowed]);
    expect(localMsInPart(part!, 30_000)).toBe(30_000);
    expect(localMsInPart(part!, 999_000)).toBe(60_000);
  });
});

describe('pendingAttachLine', () => {
  function pending(over: Partial<PendingAttach> = {}): PendingAttach {
    return {
      sourceLabel: 'Upload',
      offsetMs: 0,
      textPolicy: 'gap_fill',
      state: 'transcribing',
      mine: true,
      since: '2026-09-22T02:00:00.000Z',
      ...over,
    };
  }

  test('says what is happening, and never a filename', () => {
    expect(pendingAttachLine(pending()).text).toBe('A recording is being added: Upload · transcribing…');
    expect(pendingAttachLine(pending({ state: 'uploading' })).text).toBe(
      'A recording is being added: Upload · uploading…'
    );
  });

  test('names where it will land when that is not the start', () => {
    expect(pendingAttachLine(pending({ offsetMs: 110_000 })).text).toBe(
      'A recording is being added: Upload at 1:50 · transcribing…'
    );
  });

  test('a failed upload says nothing was added, and stops spinning', () => {
    const line = pendingAttachLine(pending({ state: 'failed' }));
    expect(line.tone).toBe('err');
    expect(line.busy).toBe(false);
    expect(line.text).toContain('nothing was added');
  });
});

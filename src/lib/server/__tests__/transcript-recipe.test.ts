import { describe, expect, test } from 'bun:test';
import {
  applyAnchorsRecipe,
  applyLineRegexRecipe,
  applyRecipeWithValidation,
  MAX_HEADER_REGEX_CHARS,
  type AnchorsRecipe,
  type LineRegexRecipe,
} from '@/lib/server/transcript-recipe';

// ---------------------------------------------------------------------------
// line-regex: own-line
// ---------------------------------------------------------------------------

describe('line-regex own-line', () => {
  // A "Name ~ M:SS" format the deterministic fast path does NOT know.
  const ownLine = `Quarterly review notes
Alice ~ 0:05
hello there
this continues
Bob ~ 0:12
hi
Alice ~ 0:20
follow up
Alice ~ 0:25
more from alice
Bob ~ 1:02
closing
`;
  const recipe: LineRegexRecipe = {
    kind: 'line-regex',
    headerRegex: String.raw`^(?<speaker>[A-Za-z ]{1,60}?)\s*~\s*(?<m>\d{1,3}):(?<s>\d{2})$`,
    headerStyle: 'own-line',
  };

  test('turns, continuation lines, timestamps, same-speaker merge', () => {
    const r = applyLineRegexRecipe(ownLine, recipe);
    expect(r.rawTurnCount).toBe(5);
    expect(r.utterances).toEqual([
      { speaker: 'Alice', text: 'hello there this continues', startMs: 5000 },
      { speaker: 'Bob', text: 'hi', startMs: 12000 },
      // two consecutive Alice turns merge, keeping the FIRST timestamp
      { speaker: 'Alice', text: 'follow up more from alice', startMs: 20000 },
      { speaker: 'Bob', text: 'closing', startMs: 62000 },
    ]);
    // 12 non-blank lines, only the title line unconsumed.
    expect(r.matchedLineRatio).toBeCloseTo(11 / 12, 5);
    expect(r.unmatchedSamples).toEqual(['Quarterly review notes']);
  });

  test('passes route validation bars', () => {
    const v = applyRecipeWithValidation(ownLine, recipe);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.utterances).toHaveLength(4);
  });

  test('optional hour group: participating vs absent', () => {
    const text = `[1:02:03] Alice
speech one
[02:03] Bob
speech two
[03:04] Alice
speech three
[04:05] Bob
speech four
[05:06] Alice
speech five
`;
    const r = applyLineRegexRecipe(text, {
      kind: 'line-regex',
      headerRegex: String.raw`^\[(?:(?<h>\d+):)?(?<m>\d{1,2}):(?<s>\d{2})\]\s(?<speaker>.+)$`,
      headerStyle: 'own-line',
    });
    expect(r.utterances[0]!.startMs).toBe((3600 + 2 * 60 + 3) * 1000);
    expect(r.utterances[1]!.startMs).toBe((2 * 60 + 3) * 1000); // h group absent → 0 hours
  });

  test('no timestamp groups at all → startMs null', () => {
    const text = `** Alice **
one
** Bob **
two
** Alice **
three
** Bob **
four
** Alice **
five
`;
    const r = applyLineRegexRecipe(text, {
      kind: 'line-regex',
      headerRegex: String.raw`^\*\* (?<speaker>[A-Za-z]+) \*\*$`,
      headerStyle: 'own-line',
    });
    expect(r.rawTurnCount).toBe(5);
    expect(r.utterances.every((u) => u.startMs === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// line-regex: inline-prefix
// ---------------------------------------------------------------------------

describe('line-regex inline-prefix', () => {
  const chat = `Alice>> hello there
and this wraps to a second line
Bob>> hi back
Alice>> ok
Bob>> done
Alice>> bye
`;

  test('remainder-of-line text (no text group) + continuations', () => {
    const r = applyLineRegexRecipe(chat, {
      kind: 'line-regex',
      headerRegex: String.raw`^(?<speaker>[A-Za-z]+)>>\s?`,
      headerStyle: 'inline-prefix',
    });
    expect(r.rawTurnCount).toBe(5);
    expect(r.utterances[0]).toEqual({
      speaker: 'Alice',
      text: 'hello there and this wraps to a second line',
      startMs: null,
    });
    expect(r.utterances[1]).toEqual({ speaker: 'Bob', text: 'hi back', startMs: null });
    expect(r.matchedLineRatio).toBe(1);
  });

  test('(?<text>) named group wins for the turn text', () => {
    const r = applyLineRegexRecipe(chat, {
      kind: 'line-regex',
      headerRegex: String.raw`^(?<speaker>[A-Za-z]+)>>\s?(?<text>.*)$`,
      headerStyle: 'inline-prefix',
    });
    expect(r.utterances[0]!.text).toBe('hello there and this wraps to a second line');
    expect(r.utterances[4]!.text).toBe('bye');
  });

  test('timestamp groups parse (m/s)', () => {
    const text = `(00:05) Alice: hello
(00:12) Bob: hi
(00:20) Alice: ok
(00:31) Bob: sure
(00:44) Alice: bye
`;
    const r = applyLineRegexRecipe(text, {
      kind: 'line-regex',
      headerRegex: String.raw`^\((?<m>\d{2}):(?<s>\d{2})\) (?<speaker>[A-Za-z]+): (?<text>.*)$`,
      headerStyle: 'inline-prefix',
    });
    expect(r.utterances.map((u) => u.startMs)).toEqual([5000, 12000, 20000, 31000, 44000]);
  });

  test('a mid-line match does NOT count as an inline-prefix header', () => {
    const text = `intro line mentioning Alice>> inside speech
more prose here
`;
    const r = applyLineRegexRecipe(text, {
      kind: 'line-regex',
      headerRegex: String.raw`(?<speaker>[A-Za-z]+)>>\s?`, // deliberately unanchored
      headerStyle: 'inline-prefix',
    });
    expect(r.rawTurnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// line-regex: validation + guards
// ---------------------------------------------------------------------------

describe('line-regex validation and guards', () => {
  const prose = `The quarterly review covered a wide range of topics.
Revenue grew by twelve percent compared to the previous quarter.
The team discussed the roadmap for the next two quarters.
Several risks were identified around the migration timeline.
Action items were assigned to the respective owners.
The next review is scheduled for the end of the month.
Attendance was higher than usual this time.
Alice: one stray chat-looking line
Bob: another stray line
`;

  test('low coverage / too few turns → validation rejects with a report', () => {
    const v = applyRecipeWithValidation(prose, {
      kind: 'line-regex',
      headerRegex: String.raw`^(?<speaker>[A-Za-z]+): (?<text>.*)$`,
      headerStyle: 'inline-prefix',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.failure).toContain('2 turns');
      expect(v.failure).toContain('example unmatched lines');
    }
  });

  test('regex source longer than the cap throws / rejects', () => {
    const long = `^(?<speaker>${'a'.repeat(MAX_HEADER_REGEX_CHARS)})$`;
    expect(() =>
      applyLineRegexRecipe(prose, { kind: 'line-regex', headerRegex: long, headerStyle: 'own-line' })
    ).toThrow(/too long/);
    const v = applyRecipeWithValidation(prose, {
      kind: 'line-regex',
      headerRegex: long,
      headerStyle: 'own-line',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failure).toContain('too long');
  });

  test('invalid regex source rejects instead of crashing', () => {
    const v = applyRecipeWithValidation(prose, {
      kind: 'line-regex',
      headerRegex: '(?<speaker>[unclosed',
      headerStyle: 'own-line',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failure).toContain('does not compile');
  });

  test('missing (?<speaker>) group rejects', () => {
    const v = applyRecipeWithValidation(prose, {
      kind: 'line-regex',
      headerRegex: String.raw`^[A-Za-z]+:`,
      headerStyle: 'inline-prefix',
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failure).toContain('speaker');
  });

  test('unknown recipe kind / missing recipe reject', () => {
    expect(applyRecipeWithValidation(prose, { kind: 'magic' }).ok).toBe(false);
    expect(applyRecipeWithValidation(prose, null).ok).toBe(false);
  });

  test('unsafe flags (g/y) are stripped so per-line exec stays stateless', () => {
    const text = `A: one
B: two
A: three
B: four
A: five
`;
    const r = applyLineRegexRecipe(text, {
      kind: 'line-regex',
      headerRegex: String.raw`^(?<speaker>[AB]): (?<text>.*)$`,
      headerStyle: 'inline-prefix',
      flags: 'gy',
    });
    expect(r.rawTurnCount).toBe(5); // with 'g' preserved, lastIndex would skip lines
  });
});

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

describe('anchors recipe', () => {
  const prose =
    'Alice opened the meeting by welcoming everyone to the review. ' +
    'Bob then presented the quarterly numbers in detail. ' +
    'He also flagged the rising infra costs. ' +
    'Alice asked about the margin trend going into next quarter. ' +
    'Bob promised a follow-up analysis next week.';

  test('happy path: sequential location, slicing, merge of consecutive same speaker', () => {
    const recipe: AnchorsRecipe = {
      kind: 'anchors',
      turns: [
        { speaker: 'Alice', anchor: 'Alice opened the meeting' },
        { speaker: 'Bob', anchor: 'Bob then presented' },
        { speaker: 'Bob', anchor: 'He also flagged' },
        { speaker: 'Alice', anchor: 'Alice asked about' },
        { speaker: 'Bob', anchor: 'Bob promised' },
      ],
    };
    const r = applyAnchorsRecipe(prose, recipe);
    expect(r.locatedCount).toBe(5);
    expect(r.locatedRatio).toBe(1);
    // Two consecutive Bob turns merge into one.
    expect(r.utterances).toEqual([
      {
        speaker: 'Alice',
        text: 'Alice opened the meeting by welcoming everyone to the review.',
        startMs: null,
      },
      {
        speaker: 'Bob',
        text: 'Bob then presented the quarterly numbers in detail. He also flagged the rising infra costs.',
        startMs: null,
      },
      {
        speaker: 'Alice',
        text: 'Alice asked about the margin trend going into next quarter.',
        startMs: null,
      },
      { speaker: 'Bob', text: 'Bob promised a follow-up analysis next week.', startMs: null },
    ]);
    const v = applyRecipeWithValidation(prose, recipe);
    expect(v.ok).toBe(true);
  });

  test('unlocatable and out-of-order anchors are skipped (forward-only)', () => {
    const r = applyAnchorsRecipe(prose, {
      kind: 'anchors',
      turns: [
        { speaker: 'Bob', anchor: 'Bob then presented' },
        // Occurs BEFORE the previous match → forward-only indexOf misses it.
        { speaker: 'Alice', anchor: 'Alice opened the meeting' },
        { speaker: 'X', anchor: 'this text is nowhere in the source' },
        { speaker: 'Bob', anchor: 'Bob promised' },
      ],
    });
    expect(r.locatedCount).toBe(2);
    expect(r.locatedRatio).toBe(0.5);
    expect(r.unlocatedSamples).toEqual([
      'Alice opened the meeting',
      'this text is nowhere in the source',
    ]);
    expect(r.utterances.map((u) => u.speaker)).toEqual(['Bob']); // consecutive Bob turns merged
  });

  test('low located ratio → validation rejects with a report', () => {
    const v = applyRecipeWithValidation(prose, {
      kind: 'anchors',
      turns: [
        { speaker: 'Alice', anchor: 'Alice opened the meeting' },
        { speaker: 'Bob', anchor: 'Bob then presented' },
        { speaker: 'Alice', anchor: 'Alice asked about' },
        { speaker: 'X', anchor: 'nope, not present' },
        { speaker: 'Y', anchor: 'also missing entirely' },
      ],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.failure).toContain('3 of your 5 anchors');
      expect(v.failure).toContain('anchors not found');
    }
  });

  test('fewer than 3 located turns → validation rejects even at 100% ratio', () => {
    const v = applyRecipeWithValidation(prose, {
      kind: 'anchors',
      turns: [
        { speaker: 'Alice', anchor: 'Alice opened the meeting' },
        { speaker: 'Bob', anchor: 'Bob then presented' },
      ],
    });
    expect(v.ok).toBe(false);
  });

  test('turn-count guard: over 2000 turns throws / rejects', () => {
    const turns = Array.from({ length: 2001 }, (_, i) => ({
      speaker: 'A',
      anchor: `anchor ${i}`,
    }));
    expect(() => applyAnchorsRecipe(prose, { kind: 'anchors', turns })).toThrow(/too many turns/);
    const v = applyRecipeWithValidation(prose, { kind: 'anchors', turns });
    expect(v.ok).toBe(false);
  });

  test('empty turns array throws / rejects', () => {
    expect(() => applyAnchorsRecipe(prose, { kind: 'anchors', turns: [] })).toThrow(/no turns/);
  });

  test('whitespace in slices collapses; empty/blank anchors count as unlocated', () => {
    const text = 'Speaker one says hello.\n\n   Speaker two replies\nacross lines. Speaker one closes the call now.';
    const r = applyAnchorsRecipe(text, {
      kind: 'anchors',
      turns: [
        { speaker: 'Speaker 1', anchor: 'Speaker one says' },
        { speaker: 'Speaker 2', anchor: 'Speaker two replies' },
        { speaker: 'Speaker 1', anchor: 'Speaker one closes' },
        { speaker: 'Speaker 3', anchor: '   ' },
      ],
    });
    expect(r.locatedCount).toBe(3);
    expect(r.utterances[1]!.text).toBe('Speaker two replies across lines.');
    expect(r.unlocatedSamples).toEqual(['(empty anchor)']);
  });
});

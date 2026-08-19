import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryParseTranscriptText } from '@/lib/server/transcript-text-parse';

describe('incident format ("Name | MM:SS" header + text lines)', () => {
  // Heavy interleaved near-duplicates, exactly like live-caption exports —
  // these must survive verbatim (faithful import, no dedupe).
  const incident = `Aniq Danial | 00:00
Will be hear does it slow up by that
Speaker 2 | 00:04
Hello.
Aniq Danial | 00:05
Will be hear does it slow up by that yeah exactly
Speaker 2 | 00:08
Hello. Can you hear me
Anton | 00:11
Good afternoon. Okay let us get started
Speaker 2 | 00:15
Hello. Can you hear me now
Anton | 00:18
Good afternoon. Okay let us get started with the review
`;

  test('parses with the right format tag and timestamps', () => {
    const parsed = tryParseTranscriptText(incident);
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('Name | MM:SS');
    expect(parsed!.utterances[0]).toEqual({
      speaker: 'Aniq Danial',
      text: 'Will be hear does it slow up by that',
      startMs: 0,
    });
    expect(parsed!.utterances[1]!.startMs).toBe(4000);
  });

  test('near-duplicate interleaved lines are preserved verbatim, not deduped', () => {
    const parsed = tryParseTranscriptText(incident)!;
    const texts = parsed.utterances.map((u) => u.text);
    expect(texts).toContain('Will be hear does it slow up by that');
    expect(texts).toContain('Will be hear does it slow up by that yeah exactly');
    expect(texts).toContain('Hello. Can you hear me');
    expect(texts).toContain('Hello. Can you hear me now');
    expect(parsed.utterances).toHaveLength(7); // no same-speaker adjacency → no merges
  });

  test('multi-line speech attaches to the preceding header', () => {
    const multi = `Alice | 00:00
first line of the turn
second line of the same turn
Bob | 00:05
reply
Alice | 00:08
a
Bob | 00:10
b
Alice | 00:12
c
`;
    const parsed = tryParseTranscriptText(multi)!;
    expect(parsed.utterances[0]!.text).toBe('first line of the turn second line of the same turn');
  });
});

describe('MM:SS rollover and >59-minute handling', () => {
  test('MM:SS rolls over to HH:MM:SS mid-file', () => {
    const text = `Alice | 58:59
almost at the hour
Bob | 59:30
yes nearly there
Alice | 1:00:05
rolled over now
Bob | 1:02:10
indeed it did
Alice | 1:05:00
wrapping up
`;
    const parsed = tryParseTranscriptText(text)!;
    expect(parsed.format).toBe('Name | MM:SS');
    const starts = parsed.utterances.map((u) => u.startMs);
    expect(starts).toEqual([
      (58 * 60 + 59) * 1000,
      (59 * 60 + 30) * 1000,
      (3600 + 5) * 1000,
      (3600 + 2 * 60 + 10) * 1000,
      (3600 + 5 * 60) * 1000,
    ]);
  });

  test('two-part minutes beyond 59 stay minutes ("75:12" = 75 min)', () => {
    const text = `Alice | 63:01
one
Bob | 70:00
two
Alice | 75:12
three
Bob | 80:45
four
Alice | 91:00
five
`;
    const parsed = tryParseTranscriptText(text)!;
    expect(parsed.utterances[2]!.startMs).toBe((75 * 60 + 12) * 1000);
    expect(parsed.utterances[4]!.startMs).toBe((91 * 60) * 1000);
  });
});

describe('same-speaker merge behavior', () => {
  test('consecutive same-speaker utterances merge, keeping the FIRST timestamp', () => {
    const text = `Alice | 00:00
first
Alice | 00:03
second
Bob | 00:07
reply
Alice | 00:09
third
Bob | 00:12
ok
Bob | 00:14
right
`;
    const parsed = tryParseTranscriptText(text)!;
    expect(parsed.utterances).toEqual([
      { speaker: 'Alice', text: 'first second', startMs: 0 },
      { speaker: 'Bob', text: 'reply', startMs: 7000 },
      { speaker: 'Alice', text: 'third', startMs: 9000 },
      { speaker: 'Bob', text: 'ok right', startMs: 12000 },
    ]);
  });

  test('acceptance bar counts utterances BEFORE merging', () => {
    // 5 raw utterances collapsing to 2 turns must still be accepted.
    const text = `Alice | 00:00
a
Alice | 00:02
b
Alice | 00:04
c
Alice | 00:06
d
Bob | 00:08
e
`;
    const parsed = tryParseTranscriptText(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.utterances).toHaveLength(2);
  });
});

describe('rejection of non-transcript text', () => {
  test('prose paragraphs return null', () => {
    const prose = `The quarterly review covered a wide range of topics.
Revenue grew by twelve percent compared to the previous quarter.
The team discussed the roadmap for the next two quarters.
Several risks were identified around the migration timeline.
Action items were assigned to the respective owners.
The next review is scheduled for the end of the month.
Attendance was higher than usual this time.
`;
    expect(tryParseTranscriptText(prose)).toBeNull();
  });

  test('markdown (headings, lists, tables with pipes) returns null', () => {
    const md = `# Meeting notes

## Attendees
- Alice
- Bob

| item | owner |
| ---- | ----- |
| ship | Alice |
| test | Bob   |

Some **bold** summary text here.
`;
    expect(tryParseTranscriptText(md)).toBeNull();
  });

  test('random text returns null', () => {
    const junk = `zx 9q1
lorem ipsum dolor sit amet
4479 22 aa bb cc
next line of stuff
one | more
final
`;
    expect(tryParseTranscriptText(junk)).toBeNull();
  });

  test('fewer than 5 utterances returns null (falls back to the LLM)', () => {
    const short = `Aniq Danial | 00:00
Will be hear does it slow up by that
Speaker 2 | 00:04
Hello.
Anton | 00:06
Good afternoon.
`;
    expect(tryParseTranscriptText(short)).toBeNull();
  });
});

describe('SRT', () => {
  const srt = `1
00:00:01,000 --> 00:00:03,500
Alice: hello everyone

2
00:00:04,000 --> 00:00:05,000
Bob: hi there

3
00:00:06,250 --> 00:00:08,000
Alice: let us begin

4
00:00:09,000 --> 00:00:11,000
Bob: sounds good

5
00:00:12,000 --> 00:00:13,000
Alice: first topic

6
00:00:14,000 --> 00:00:15,000
Bob: go ahead
`;

  test('numeric-counter + comma-millisecond blocks parse', () => {
    const parsed = tryParseTranscriptText(srt);
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('SRT');
    expect(parsed!.utterances).toHaveLength(6);
    expect(parsed!.utterances[0]).toEqual({ speaker: 'Alice', text: 'hello everyone', startMs: 1000 });
    expect(parsed!.utterances[2]!.startMs).toBe(6250);
  });

  test('speaker-less SRT cues fall back to the previous speaker / Speaker 1', () => {
    const noSpeakers = `1
00:00:01,000 --> 00:00:02,000
first cue without any name

2
00:00:03,000 --> 00:00:04,000
second cue text

3
00:00:05,000 --> 00:00:06,000
third cue text

4
00:00:07,000 --> 00:00:08,000
fourth cue text

5
00:00:09,000 --> 00:00:10,000
fifth cue text
`;
    const parsed = tryParseTranscriptText(noSpeakers)!;
    // All Speaker 1 → merged into one turn keeping the first timestamp.
    expect(parsed.utterances).toHaveLength(1);
    expect(parsed.utterances[0]!.speaker).toBe('Speaker 1');
    expect(parsed.utterances[0]!.startMs).toBe(1000);
    expect(parsed.utterances[0]!.text).toContain('first cue without any name');
    expect(parsed.utterances[0]!.text).toContain('fifth cue text');
  });
});

describe('[MM:SS] Name: variant', () => {
  test('inline bracket-timestamp lines parse', () => {
    const text = `[00:00] Jane Tan: morning everyone
[00:04] John: shall we start?
[00:09] Jane Tan: yes let us go
[01:15] John: first item is the budget
[02:30] Jane Tan: approved last week
[59:59] John: closing remarks
[1:00:10] Jane Tan: thanks all
`;
    const parsed = tryParseTranscriptText(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('[MM:SS] Name:');
    expect(parsed!.utterances[0]).toEqual({
      speaker: 'Jane Tan',
      text: 'morning everyone',
      startMs: 0,
    });
    expect(parsed!.utterances[5]!.startMs).toBe((59 * 60 + 59) * 1000);
    expect(parsed!.utterances[6]!.startMs).toBe((3600 + 10) * 1000);
  });
});

describe('other supported variants', () => {
  test('Name (MM:SS): inline', () => {
    const text = `Jane Tan (00:00): morning everyone
John (00:04): shall we start?
Jane Tan (00:09): yes
John (00:15): first item
Jane Tan (00:30): noted
`;
    const parsed = tryParseTranscriptText(text)!;
    expect(parsed.format).toBe('Name (MM:SS):');
    expect(parsed.utterances[1]).toEqual({ speaker: 'John', text: 'shall we start?', startMs: 4000 });
  });

  test('HH:MM:SS Name: line-leading', () => {
    const text = `00:00:00 Jane Tan: morning everyone
00:00:04 John: shall we start?
00:00:09 Jane Tan: yes
00:01:15 John: first item
01:02:30 Jane Tan: closing
`;
    const parsed = tryParseTranscriptText(text)!;
    expect(parsed.format).toBe('HH:MM:SS Name:');
    expect(parsed.utterances[4]!.startMs).toBe((3600 + 2 * 60 + 30) * 1000);
  });

  test('WEBVTT delegates to parseTeamsVtt', () => {
    const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'teams-sample.vtt'), 'utf8');
    const parsed = tryParseTranscriptText(fixture);
    expect(parsed).not.toBeNull();
    expect(parsed!.format).toBe('WebVTT');
    expect(parsed!.utterances.length).toBeGreaterThan(4);
    expect(parsed!.utterances[0]!.startMs).toBe(3918);
  });
});

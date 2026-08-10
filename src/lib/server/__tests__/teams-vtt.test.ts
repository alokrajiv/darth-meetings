import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTeamsVtt } from '@/lib/server/teams-vtt';

const fixture = readFileSync(join(import.meta.dir, 'fixtures', 'teams-sample.vtt'), 'utf8');

describe('parseTeamsVtt on the real Teams fixture (LP-Global, 20 cues)', () => {
  const parsed = parseTeamsVtt(fixture);

  test('attendees are unique speakers in order of first appearance', () => {
    expect(parsed.attendees).toEqual(['Swaralee Kibe', 'Nicolas Montero']);
  });

  test('same-speaker cues with small gaps merge into turns', () => {
    // 20 raw cues, long opening monologue → far fewer display turns.
    expect(parsed.utterances.length).toBeGreaterThan(4);
    expect(parsed.utterances.length).toBeLessThan(20);
    expect(parsed.utterances[0]!.speaker).toBe('Swaralee Kibe');
  });

  test('timings are milliseconds from cue timestamps', () => {
    expect(parsed.utterances[0]!.start).toBe(3918); // 00:00:03.918
    const last = parsed.utterances[parsed.utterances.length - 1]!;
    expect(last.end).toBe(3 * 60_000 + 3_998); // 00:03:03.998
  });

  test('voice tags are stripped from text', () => {
    for (const u of parsed.utterances) {
      expect(u.text).not.toContain('<v');
      expect(u.text).not.toContain('</v>');
    }
    expect(parsed.utterances[0]!.text).toBe('No.');
  });

  test('merge respects the 600-char cap (long monologue is split)', () => {
    // The opening Swaralee stretch is >2000 chars of near-contiguous cues;
    // the cap keeps individual turns readable.
    for (const u of parsed.utterances) {
      expect(u.text.length).toBeLessThan(900); // 600 cap + one appended cue
    }
  });
});

describe('parseTeamsVtt edge cases', () => {
  test('cue without a voice tag falls back to "Speaker" and is not an attendee', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hello without attribution.

00:00:05.000 --> 00:00:06.000
<v Alice Tan>Hi there.</v>
`;
    const parsed = parseTeamsVtt(vtt);
    expect(parsed.utterances[0]!.speaker).toBe('Speaker');
    expect(parsed.utterances[0]!.text).toBe('Hello without attribution.');
    expect(parsed.attendees).toEqual(['Alice Tan']);
  });

  test('multi-line payloads join with a space', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Bob Lim>First line of the cue
continues on a second line.</v>
`;
    const parsed = parseTeamsVtt(vtt);
    expect(parsed.utterances[0]!.text).toBe('First line of the cue continues on a second line.');
  });

  test('hour-less timestamps (MM:SS.mmm) parse per the VTT spec', () => {
    const vtt = `WEBVTT

01:03.500 --> 01:04.000
<v Carol>Short form.</v>
`;
    const parsed = parseTeamsVtt(vtt);
    expect(parsed.utterances[0]!.start).toBe(63_500);
  });

  test('cue identifiers, NOTE blocks and CRLF are tolerated', () => {
    const vtt = `WEBVTT\r\n\r\nNOTE created by test\r\n\r\n42\r\n00:00:01.000 --> 00:00:02.000\r\n<v Dan>Yes.</v>\r\n`;
    const parsed = parseTeamsVtt(vtt);
    expect(parsed.utterances).toHaveLength(1);
    expect(parsed.utterances[0]!.speaker).toBe('Dan');
    expect(parsed.utterances[0]!.text).toBe('Yes.');
  });

  test('empty input yields empty result', () => {
    const parsed = parseTeamsVtt('WEBVTT\n');
    expect(parsed.attendees).toEqual([]);
    expect(parsed.utterances).toEqual([]);
  });
});

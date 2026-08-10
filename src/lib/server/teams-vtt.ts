import type { MeetTranscriptEntry } from '@/lib/format';
import type { ParsedMeetTranscript } from '@/lib/server/gmeet';
import { utterancesFromEntries } from '@/lib/utterances';

/**
 * Deterministic parser for Teams meeting transcripts (WebVTT with
 * `<v Speaker Name>` voice tags, as returned by Graph's
 * `/transcripts/{id}/content?$format=text/vtt`).
 *
 * Replaces the Claude-normalize pass for this path — the format is machine
 * generated and stable, so no model call is needed (import-text keeps its
 * Claude pass for arbitrary pasted formats). No `server-only` import: the
 * parser is pure and unit-tested directly.
 */

// "00:00:03.918 --> 00:00:04.078" — hours are optional per the VTT spec.
const TIMING_RE =
  /^(?:(\d{1,4}):)?(\d{1,2}):(\d{2})\.(\d{3})\s+-->\s+(?:(\d{1,4}):)?(\d{1,2}):(\d{2})\.(\d{3})/;

// "<v Speaker Name>" opening a cue payload; classes ("<v.loud Name>") allowed.
const VOICE_RE = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/;

function cueMs(h: string | undefined, m: string, s: string, ms: string): number {
  return (h ? Number(h) * 3_600_000 : 0) + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
}

/** Fallback label for cues without a voice tag (transcripts recorded while
 * the tenant attribution toggle was off). */
const UNATTRIBUTED = 'Speaker';

export function parseTeamsVtt(vtt: string): ParsedMeetTranscript {
  const lines = vtt.replace(/\r\n/g, '\n').split('\n');
  const entries: MeetTranscriptEntry[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = TIMING_RE.exec(lines[i]!);
    if (!m) {
      i++; // header, NOTE blocks, cue identifiers, blank lines
      continue;
    }
    const start = cueMs(m[1], m[2]!, m[3]!, m[4]!);
    const end = cueMs(m[5], m[6]!, m[7]!, m[8]!);
    i++;

    const payload: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '') {
      payload.push(lines[i]!.trim());
      i++;
    }
    const text = payload.join(' ').trim();
    if (!text) continue;

    const speaker = VOICE_RE.exec(text)?.[1]?.trim() || UNATTRIBUTED;
    const clean = text
      .replace(/<\/?v[^>]*>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (clean) entries.push({ speaker, text: clean, start, end });
  }

  const attendees: string[] = [];
  for (const e of entries) {
    if (e.speaker !== UNATTRIBUTED && !attendees.includes(e.speaker)) attendees.push(e.speaker);
  }
  return { attendees, utterances: utterancesFromEntries(entries) };
}

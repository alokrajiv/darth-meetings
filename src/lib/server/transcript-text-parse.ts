import { parseTeamsVtt } from '@/lib/server/teams-vtt';

/**
 * Deterministic fast-path parser for pasted/uploaded transcript text.
 * Detects the handful of machine-regular formats we actually see (Teams/Zoom
 * exports, caption files, "Name | MM:SS" tools) and turns them into
 * utterances WITHOUT a model call — the headless-Claude normalize pass stays
 * as the fallback for genuinely unknown formats.
 *
 * Detection order: WEBVTT → SRT → `Name | MM:SS` header lines →
 * `[MM:SS] Name:` inline → `Name (MM:SS):` inline → `MM:SS Name:` inline.
 * Acceptance bar (guards against false positives on prose): >=70% of
 * non-blank lines consumed by the detected pattern's header/text alternation
 * AND >=5 utterances (counted BEFORE same-speaker merging); else null and
 * the caller falls back to the LLM.
 *
 * Text is preserved verbatim — near-duplicate interleaved lines (common in
 * live-caption exports) are NOT deduped; that's a faithful import.
 *
 * No `server-only` marker: pure module, unit-tested directly with bun.
 */

export interface ParsedTextUtterance {
  speaker: string;
  text: string;
  /** ms from meeting start; null when the source line had no timestamp. */
  startMs: number | null;
}

export interface ParsedTranscriptText {
  utterances: ParsedTextUtterance[];
  /** Human-readable name of the detected format (surfaced in the dialog). */
  format: string;
}

const MIN_UTTERANCES = 5;
const MIN_COVERAGE = 0.7;

/** `MM:SS` or `HH:MM:SS`. Minutes may exceed 59 ("75:12" — some tools never
 * roll over to hours); others DO roll over mid-file, so both forms must
 * coexist in one document. */
const TS = String.raw`(\d{1,3}):(\d{2})(?::(\d{2}))?`;

function tsToMs(a: string, b: string, c?: string | null): number {
  return c != null
    ? (Number(a) * 3600 + Number(b) * 60 + Number(c)) * 1000
    : (Number(a) * 60 + Number(b)) * 1000;
}

interface LineFormat {
  name: string;
  header: RegExp;
  extract: (m: RegExpExecArray) => {
    speaker: string;
    startMs: number;
    /** Text on the header line itself; null = text lives on following lines. */
    inlineText: string | null;
  };
}

const LINE_FORMATS: LineFormat[] = [
  {
    // "Aniq Danial | 00:00" on its own line, speech on the following line(s).
    name: 'Name | MM:SS',
    header: new RegExp(String.raw`^(.{1,80}?)\s*\|\s*${TS}\s*$`),
    extract: (m) => ({
      speaker: m[1]!.trim(),
      startMs: tsToMs(m[2]!, m[3]!, m[4]),
      inlineText: null,
    }),
  },
  {
    // "[00:04] Jane Tan: morning everyone"
    name: '[MM:SS] Name:',
    header: new RegExp(String.raw`^\[${TS}\]\s*(.{1,80}?):\s*(.*)$`),
    extract: (m) => ({
      speaker: m[4]!.trim(),
      startMs: tsToMs(m[1]!, m[2]!, m[3]),
      inlineText: m[5] ?? '',
    }),
  },
  {
    // "Jane Tan (00:04): morning everyone"
    name: 'Name (MM:SS):',
    header: new RegExp(String.raw`^(.{1,80}?)\s*\(${TS}\)\s*:\s*(.*)$`),
    extract: (m) => ({
      speaker: m[1]!.trim(),
      startMs: tsToMs(m[2]!, m[3]!, m[4]),
      inlineText: m[5] ?? '',
    }),
  },
  {
    // "00:00:04 Jane Tan: morning everyone"
    name: 'HH:MM:SS Name:',
    header: new RegExp(String.raw`^${TS}\s+(.{1,80}?):\s*(.*)$`),
    extract: (m) => ({
      speaker: m[4]!.trim(),
      startMs: tsToMs(m[1]!, m[2]!, m[3]),
      inlineText: m[5] ?? '',
    }),
  },
];

function tryLineFormat(lines: string[], fmt: LineFormat): ParsedTextUtterance[] | null {
  const utterances: ParsedTextUtterance[] = [];
  let current: ParsedTextUtterance | null = null;
  let nonBlank = 0;
  let consumed = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    nonBlank++;
    const m = fmt.header.exec(line);
    if (m) {
      if (current && current.text) utterances.push(current);
      const { speaker, startMs, inlineText } = fmt.extract(m);
      current = {
        speaker: speaker.slice(0, 80) || 'Speaker 1',
        text: (inlineText ?? '').trim(),
        startMs,
      };
      consumed++;
    } else if (current) {
      // Continuation of the current utterance's speech.
      current.text = current.text ? `${current.text} ${line}` : line;
      consumed++;
    }
    // Lines before the first header (titles, boilerplate) stay unconsumed.
  }
  if (current && current.text) utterances.push(current);

  if (utterances.length < MIN_UTTERANCES) return null;
  if (nonBlank === 0 || consumed / nonBlank < MIN_COVERAGE) return null;
  return utterances;
}

// "00:00:01,000 --> 00:00:02,500" (comma millis; dot tolerated).
const SRT_TIMING =
  /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+\d{1,3}:\d{2}:\d{2}[,.]\d{3}/;
// Conservative "Name: speech" inside an SRT payload — capitalized 1-4 words.
const SRT_SPEAKER = /^([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,3}):\s+(.+)$/;
const SRT_VOICE = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/;

function trySrt(text: string): ParsedTextUtterance[] | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const nonBlank = lines.filter((l) => l.trim()).length;
  const utterances: ParsedTextUtterance[] = [];
  let consumed = 0;
  let lastSpeaker = 'Speaker 1';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    // Block: [numeric counter] timing-line text-lines… blank.
    let blockLines = 0;
    let j = i;
    if (/^\d+$/.test(line) && j + 1 < lines.length && SRT_TIMING.test(lines[j + 1]!.trim())) {
      blockLines++;
      j++;
    }
    const t = SRT_TIMING.exec(lines[j]!.trim());
    if (!t) {
      i++;
      continue;
    }
    blockLines++;
    j++;
    const startMs = tsToMs(t[1]!, t[2]!, t[3]) + Number(t[4]);

    const payload: string[] = [];
    while (j < lines.length && lines[j]!.trim() !== '') {
      payload.push(lines[j]!.trim());
      blockLines++;
      j++;
    }
    let cueText = payload.join(' ').trim();
    if (cueText) {
      let speaker: string | null = SRT_VOICE.exec(cueText)?.[1]?.trim() ?? null;
      cueText = cueText.replace(/<\/?v[^>]*>/g, '').replace(/<[^>]+>/g, '').trim();
      if (!speaker) {
        const s = SRT_SPEAKER.exec(cueText);
        if (s) {
          speaker = s[1]!;
          cueText = s[2]!;
        }
      }
      if (speaker) lastSpeaker = speaker;
      if (cueText) utterances.push({ speaker: lastSpeaker, text: cueText, startMs });
    }
    consumed += blockLines;
    i = j;
  }

  if (utterances.length < MIN_UTTERANCES) return null;
  if (nonBlank === 0 || consumed / nonBlank < MIN_COVERAGE) return null;
  return utterances;
}

function tryVtt(text: string): ParsedTextUtterance[] | null {
  if (!/^WEBVTT\b/.test(text.trimStart())) return null;
  const parsed = parseTeamsVtt(text);
  if (parsed.utterances.length < MIN_UTTERANCES) return null;
  return parsed.utterances.map((u) => ({ speaker: u.speaker, text: u.text, startMs: u.start }));
}

/** Merge consecutive same-speaker utterances into one turn — keep the FIRST
 * timestamp, join texts verbatim with a space. */
function mergeConsecutive(utts: ParsedTextUtterance[]): ParsedTextUtterance[] {
  const out: ParsedTextUtterance[] = [];
  for (const u of utts) {
    const prev = out[out.length - 1];
    if (prev && prev.speaker === u.speaker) {
      prev.text = `${prev.text} ${u.text}`;
    } else {
      out.push({ ...u });
    }
  }
  return out;
}

export function tryParseTranscriptText(text: string): ParsedTranscriptText | null {
  const vtt = tryVtt(text);
  // parseTeamsVtt already merges same-speaker cues (gap/length-capped) — no re-merge.
  if (vtt) return { utterances: vtt, format: 'WebVTT' };

  const srt = trySrt(text);
  if (srt) return { utterances: mergeConsecutive(srt), format: 'SRT' };

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const fmt of LINE_FORMATS) {
    const utts = tryLineFormat(lines, fmt);
    if (utts) return { utterances: mergeConsecutive(utts), format: fmt.name };
  }
  return null;
}

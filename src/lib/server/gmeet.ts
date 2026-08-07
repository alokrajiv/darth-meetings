import 'server-only';
import { saveAudioStreamToTemp } from '@/lib/server/audio-storage';
import type {
  MeetActuals,
  MeetParticipantInfo,
  MeetTranscriptEntry,
  MeetUtterance,
  TranscriptResponse,
} from '@/lib/format';

/**
 * Google Drive helpers for the Meet import flow.
 *
 * All calls use a short-lived OAuth access token acquired in the BROWSER via
 * Google Identity Services (scopes: drive.readonly + calendar.events.readonly)
 * and passed per-request. The token is used in memory only — never persisted,
 * never logged. Calendar listing happens client-side; the server only touches
 * Drive: file metadata, media download (streamed to disk), and Doc export for
 * the Meet transcript.
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

async function driveFetch(token: string, url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GoogleApiError(res.status, `Google API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  durationMs: number | null;
  canDownload: boolean;
}

export async function getDriveFileMeta(token: string, fileId: string): Promise<DriveFileMeta> {
  const url =
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}` +
    `?fields=${encodeURIComponent('id,name,mimeType,size,videoMediaMetadata(durationMillis),capabilities/canDownload')}` +
    `&supportsAllDrives=true`;
  const res = await driveFetch(token, url);
  const j = (await res.json()) as {
    id: string;
    name?: string;
    mimeType?: string;
    size?: string;
    videoMediaMetadata?: { durationMillis?: string };
    capabilities?: { canDownload?: boolean };
  };
  return {
    id: j.id,
    name: j.name ?? 'meet-recording',
    mimeType: j.mimeType ?? 'application/octet-stream',
    size: j.size != null ? Number(j.size) : null,
    durationMs:
      j.videoMediaMetadata?.durationMillis != null
        ? Number(j.videoMediaMetadata.durationMillis)
        : null,
    canDownload: j.capabilities?.canDownload !== false,
  };
}

/**
 * Stream a Drive file's bytes straight into a temp file in the audio dir —
 * constant memory, same landing spot as a raw-body upload, so the shared
 * ingest tail takes over from here.
 */
export async function downloadDriveFileToTemp(
  token: string,
  fileId: string
): Promise<{ tempFilename: string; bytes: number }> {
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(token, url);
  if (!res.body) {
    throw new GoogleApiError(502, 'Drive returned an empty response body');
  }
  return await saveAudioStreamToTemp(res.body as ReadableStream<Uint8Array>);
}

/** Export a Google Doc (the Meet transcript) as plain text. NOTE: for docs
 * with tabs this returns only the FIRST tab — use exportTranscriptText. */
export async function exportDocAsText(token: string, docId: string): Promise<string> {
  const url = `${DRIVE_FILES}/${encodeURIComponent(docId)}/export?mimeType=${encodeURIComponent('text/plain')}`;
  const res = await driveFetch(token, url);
  return await res.text();
}

interface DocsTab {
  tabProperties?: { title?: string };
  documentTab?: {
    body?: {
      content?: Array<{
        paragraph?: { elements?: Array<{ textRun?: { content?: string } }> };
      }>;
    };
  };
  childTabs?: DocsTab[];
}

function extractTabText(tab: DocsTab): string {
  const parts: string[] = [];
  for (const el of tab.documentTab?.body?.content ?? []) {
    if (!el.paragraph) continue;
    let line = '';
    for (const pe of el.paragraph.elements ?? []) {
      line += pe.textRun?.content ?? '';
    }
    parts.push(line);
  }
  return parts.join('');
}

/**
 * Get the transcript text out of a Meet doc, tab-aware.
 *
 * "Notes by Gemini" docs keep the transcript in a separate document TAB
 * ("Transcript") — and Drive's plain-text export only returns the first tab
 * (the notes). So: fetch the doc structure via the Docs API with
 * includeTabsContent, find a tab titled like "Transcript", and serialize it.
 * Falls back to the plain export for tab-less classic transcript docs (or if
 * the Docs API is unavailable).
 */
export async function exportTranscriptText(token: string, docId: string): Promise<string> {
  const doc = await tryJson<{ tabs?: DocsTab[] }>(
    token,
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?includeTabsContent=true`
  );
  if (doc?.tabs && doc.tabs.length > 0) {
    const queue: DocsTab[] = [...doc.tabs];
    while (queue.length > 0) {
      const tab = queue.shift()!;
      const title = tab.tabProperties?.title ?? '';
      if (/transcript/i.test(title)) {
        const text = extractTabText(tab);
        if (text.trim().length > 0) return text;
      }
      queue.push(...(tab.childTabs ?? []));
    }
    // Single-tab classic transcript doc: the only tab IS the transcript.
    if (doc.tabs.length === 1 && (doc.tabs[0]!.childTabs ?? []).length === 0) {
      const text = extractTabText(doc.tabs[0]!);
      if (text.trim().length > 0) return text;
    }
  }
  return await exportDocAsText(token, docId);
}

export interface ParsedMeetTranscript {
  attendees: string[];
  utterances: MeetUtterance[];
}

// A block timestamp line: "00:05:00" (Meet drops one every few minutes).
const TS_RE = /^(\d{1,2}):(\d{2}):(\d{2})$/;
// "Speaker Name: what they said". Names are short; the lazy quantifier keeps
// a colon inside the speech from swallowing half the line.
const SPEAKER_RE = /^(.{1,80}?): (.+)$/;
// ~14 chars/sec ≈ 170 wpm — used to estimate durations past the last
// block marker (display-only precision).
const CHARS_PER_SECOND = 14;

/**
 * Parse the plain-text export of a Google Meet transcript Doc.
 *
 * Expected shape (empirically stable):
 *
 *   <Title> (…) - Transcript
 *
 *   Attendees
 *   Name One, Name Two, …
 *
 *   Transcript
 *   00:00:00
 *   Name One: hello everyone
 *   Name Two: hi
 *   00:05:00
 *   Name One: …
 *
 * Only block-level timestamps exist, so per-utterance times are interpolated
 * within each block by character weight. Good enough for outline jumps and
 * ordering; not sample-accurate.
 */
export function parseMeetTranscriptDoc(text: string): ParsedMeetTranscript {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const attendees: string[] = [];
  interface RawUtterance {
    speaker: string;
    text: string;
    blockStart: number; // ms
  }
  const raw: RawUtterance[] = [];
  const blockStarts: number[] = [];

  let inAttendees = false;
  let currentBlockMs = 0;
  let sawAnyTimestamp = false;
  // Transcription restarts reset the clock to 00:00:00 mid-doc. Keep block
  // times monotonic by offsetting each restarted segment past the previous
  // one (assume the prior block ran its typical span).
  let lastRawMs = -1;
  let offsetMs = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      inAttendees = false;
      continue;
    }

    if (line === 'Attendees') {
      inAttendees = true;
      continue;
    }
    if (inAttendees) {
      for (const name of line.split(',')) {
        const n = name.trim();
        if (n.length > 0) attendees.push(n);
      }
      continue;
    }
    if (line === 'Transcript') continue;
    // Footer/system lines Meet appends around the speech.
    if (
      /^(Meeting ended|Recording (started|stopped|ended)|Transcription (started|stopped|ended)|This editable transcript)/i.test(
        line
      )
    ) {
      continue;
    }

    const ts = TS_RE.exec(line);
    if (ts) {
      const rawMs = (Number(ts[1]) * 3600 + Number(ts[2]) * 60 + Number(ts[3])) * 1000;
      if (rawMs < lastRawMs) {
        offsetMs = currentBlockMs + 5 * 60_000;
      }
      lastRawMs = rawMs;
      currentBlockMs = rawMs + offsetMs;
      if (!blockStarts.includes(currentBlockMs)) blockStarts.push(currentBlockMs);
      sawAnyTimestamp = true;
      continue;
    }

    const sp = SPEAKER_RE.exec(line);
    if (sp && sawAnyTimestamp) {
      raw.push({ speaker: sp[1]!.trim(), text: sp[2]!.trim(), blockStart: currentBlockMs });
    } else if (raw.length > 0 && sawAnyTimestamp) {
      // Continuation of the previous utterance (wrapped paragraph).
      raw[raw.length - 1]!.text += ` ${line}`;
    }
    // Anything before the first timestamp (title line, "Meeting ended…") is
    // dropped on purpose.
  }

  // Interpolate per-utterance times within each block by character weight.
  const utterances: MeetUtterance[] = [];
  blockStarts.sort((a, b) => a - b);
  for (let b = 0; b < blockStarts.length; b++) {
    const blockStart = blockStarts[b]!;
    const inBlock = raw.filter((u) => u.blockStart === blockStart);
    if (inBlock.length === 0) continue;

    const totalChars = inBlock.reduce((s, u) => s + u.text.length, 0) || 1;
    const nextStart = blockStarts[b + 1];
    const blockSpan =
      nextStart != null
        ? nextStart - blockStart
        : Math.round((totalChars / CHARS_PER_SECOND) * 1000);

    let cursor = blockStart;
    for (const u of inBlock) {
      const span = Math.max(500, Math.round((u.text.length / totalChars) * blockSpan));
      utterances.push({
        speaker: u.speaker,
        text: u.text,
        start: cursor,
        end: cursor + span,
      });
      cursor += span;
    }
  }

  return { attendees, utterances };
}

/**
 * Merge several parsed transcript segments into one timeline. Classic
 * tenants get one Doc PER transcription session (stop → start = new doc),
 * so a meeting where recording was toggled produces N docs that each start
 * at 00:00:00. Later segments are shifted past the previous segment's end —
 * the same 5-minute-gap heuristic the parser uses for in-doc clock restarts.
 */
export function mergeParsedTranscripts(parts: ParsedMeetTranscript[]): ParsedMeetTranscript {
  const attendees: string[] = [];
  const utterances: MeetUtterance[] = [];
  let offsetMs = 0;
  for (const part of parts) {
    for (const a of part.attendees) {
      if (!attendees.includes(a)) attendees.push(a);
    }
    let segmentEnd = offsetMs;
    for (const u of part.utterances) {
      const shifted = { ...u, start: u.start + offsetMs, end: u.end + offsetMs };
      utterances.push(shifted);
      if (shifted.end > segmentEnd) segmentEnd = shifted.end;
    }
    if (part.utterances.length > 0) offsetMs = segmentEnd + 5 * 60_000;
  }
  return { attendees, utterances };
}

/**
 * Export + parse one or more transcript Docs as a single transcript. A lone
 * doc id is the common case; multiple ids = one per transcription session
 * (see mergeParsedTranscripts).
 */
export async function parseTranscriptDocs(
  token: string,
  docIds: string[]
): Promise<ParsedMeetTranscript> {
  const parts: ParsedMeetTranscript[] = [];
  for (const docId of [...new Set(docIds)]) {
    const text = await exportTranscriptText(token, docId);
    parts.push(parseMeetTranscriptDoc(text));
  }
  return mergeParsedTranscripts(parts);
}

// ---------------------------------------------------------------------------
// Meet REST API "actuals" capture — snapshotted at import time because
// transcript entries expire 30 days after the meeting.
// ---------------------------------------------------------------------------

const MEET_API = 'https://meet.googleapis.com/v2';
const PEOPLE_API = 'https://people.googleapis.com/v1';

/** Best-effort JSON GET — returns null on any failure (these calls enrich,
 * they must never break an import). */
async function tryJson<T>(token: string, url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.debug('[gmeet] api miss', res.status, url.split('?')[0]);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.debug('[gmeet] api error', url.split('?')[0], err);
    return null;
  }
}

/** Find the conference record for a meeting code, nearest to `aroundIso`
 * (codes are reused across a recurring series). */
export async function findConferenceRecordName(
  token: string,
  meetingCode: string,
  aroundIso?: string
): Promise<string | null> {
  let filter = `space.meeting_code = "${meetingCode}"`;
  if (aroundIso) {
    const t = new Date(aroundIso).getTime();
    filter += ` AND start_time >= "${new Date(t - 6 * 3600_000).toISOString()}"`;
    filter += ` AND start_time <= "${new Date(t + 12 * 3600_000).toISOString()}"`;
  }
  const list = await tryJson<{
    conferenceRecords?: Array<{ name: string; startTime?: string }>;
  }>(token, `${MEET_API}/conferenceRecords?filter=${encodeURIComponent(filter)}`);
  const records = list?.conferenceRecords ?? [];
  if (records.length === 0) return null;
  if (!aroundIso) return records[0]!.name;
  const target = new Date(aroundIso).getTime();
  let best = records[0]!;
  let bestDelta = Infinity;
  for (const r of records) {
    const delta = r.startTime ? Math.abs(new Date(r.startTime).getTime() - target) : Infinity;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = r;
    }
  }
  return best.name;
}

/**
 * The record's artifact inventory in one shot — recording Drive files and
 * transcript Doc ids across all transcription sessions. Best-effort like the
 * rest of the Meet API helpers: an API miss reads as "no artifacts".
 */
export async function listRecordArtifacts(
  token: string,
  recordName: string
): Promise<{
  recordings: Array<{ fileId: string | null; startTime?: string; endTime?: string }>;
  transcriptDocIds: string[];
  /** The verbatim API responses — callers that archive structured data keep
   * every field Google returns, not just what we shape today. */
  raw: { recordings?: unknown; transcripts?: unknown };
}> {
  const [recs, trans] = await Promise.all([
    tryJson<{
      recordings?: Array<{
        driveDestination?: { file?: string };
        startTime?: string;
        endTime?: string;
      }>;
    }>(token, `${MEET_API}/${recordName}/recordings`),
    tryJson<{
      transcripts?: Array<{ startTime?: string; docsDestination?: { document?: string } }>;
    }>(token, `${MEET_API}/${recordName}/transcripts`),
  ]);
  const recordings = (recs?.recordings ?? [])
    .map((r) => ({
      fileId: r.driveDestination?.file ?? null,
      startTime: r.startTime,
      endTime: r.endTime,
    }))
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const transcriptDocIds = [
    ...new Set(
      [...(trans?.transcripts ?? [])]
        .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''))
        .map((t) => t.docsDestination?.document)
        .filter((d): d is string => !!d)
    ),
  ];
  return {
    recordings,
    transcriptDocIds,
    raw: {
      recordings: recs ?? undefined,
      transcripts: trans ?? undefined,
    },
  };
}

const MAX_TRANSCRIPT_ENTRIES = 4000;

/**
 * Pull everything durable-worthy off a conference record: actual start/end,
 * recording segments (their startTime is AAI's t=0 → the alignment anchor),
 * who actually joined (emails resolved via the People API directory — Meet
 * only gives `users/{id}` + displayName), and the structured transcript
 * entries with per-utterance timestamps.
 */
export async function captureMeetActuals(
  token: string,
  recordName: string
): Promise<MeetActuals> {
  const [record, recs, trans] = await Promise.all([
    tryJson<{ startTime?: string; endTime?: string }>(token, `${MEET_API}/${recordName}`),
    tryJson<{
      recordings?: Array<{
        driveDestination?: { file?: string };
        startTime?: string;
        endTime?: string;
      }>;
    }>(token, `${MEET_API}/${recordName}/recordings`),
    tryJson<{
      transcripts?: Array<{
        name: string;
        startTime?: string;
        docsDestination?: { document?: string };
      }>;
    }>(token, `${MEET_API}/${recordName}/transcripts`),
  ]);

  // Participants (paginated).
  interface RawParticipant {
    name: string;
    earliestStartTime?: string;
    latestEndTime?: string;
    signedinUser?: { user?: string; displayName?: string };
    anonymousUser?: { displayName?: string };
    phoneUser?: { displayName?: string };
  }
  const rawParticipants: RawParticipant[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 3; i++) {
    const page = await tryJson<{ participants?: RawParticipant[]; nextPageToken?: string }>(
      token,
      `${MEET_API}/${recordName}/participants?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    );
    rawParticipants.push(...(page?.participants ?? []));
    pageToken = page?.nextPageToken;
    if (!pageToken) break;
  }

  // Resolve signed-in users to directory emails via the People API. Meet's
  // `users/{id}` shares the id space with People's `people/{id}`.
  const emailById = new Map<string, string>();
  const ids = [
    ...new Set(
      rawParticipants
        .map((p) => p.signedinUser?.user)
        .filter((u): u is string => !!u)
        .map((u) => u.replace(/^users\//, ''))
    ),
  ];
  await Promise.all(
    ids.map(async (id) => {
      const person = await tryJson<{
        emailAddresses?: Array<{ value?: string; metadata?: { primary?: boolean } }>;
      }>(
        token,
        `${PEOPLE_API}/people/${id}?personFields=emailAddresses&sources=READ_SOURCE_TYPE_PROFILE&sources=READ_SOURCE_TYPE_DOMAIN_PROFILE`
      );
      const email =
        person?.emailAddresses?.find((e) => e.metadata?.primary)?.value ??
        person?.emailAddresses?.[0]?.value;
      if (email) emailById.set(id, email.toLowerCase());
    })
  );

  const participantByResource = new Map<string, MeetParticipantInfo>();
  const participants: MeetParticipantInfo[] = rawParticipants.map((p) => {
    const personId = p.signedinUser?.user?.replace(/^users\//, '');
    const info: MeetParticipantInfo = {
      displayName:
        p.signedinUser?.displayName ??
        p.anonymousUser?.displayName ??
        p.phoneUser?.displayName ??
        'Unknown',
      email: personId ? emailById.get(personId) : undefined,
      personId,
      kind: p.signedinUser ? 'signedin' : p.phoneUser ? 'phone' : 'anonymous',
      earliestStart: p.earliestStartTime,
      latestEnd: p.latestEndTime,
    };
    participantByResource.set(p.name, info);
    return info;
  });

  // Anchor: first recording's start (AAI's t=0) — else conference start.
  // Sorted: stop/start produces several recording segments and the API's
  // ordering isn't contractual.
  const recordings = (recs?.recordings ?? [])
    .map((r) => ({
      fileId: r.driveDestination?.file,
      startTime: r.startTime,
      endTime: r.endTime,
    }))
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  const anchorIso = recordings[0]?.startTime ?? record?.startTime;
  const anchorMs = anchorIso ? new Date(anchorIso).getTime() : null;

  // Transcription can be stopped and restarted mid-meeting — every session
  // becomes its OWN transcript resource (and, on classic tenants, its own
  // Doc). Keep them all, in wall-clock order; reading only the first silently
  // drops everything said after the first stop.
  const transcriptSessions = [...(trans?.transcripts ?? [])].sort((a, b) =>
    (a.startTime ?? '').localeCompare(b.startTime ?? '')
  );
  const transcriptDocIds = [
    ...new Set(
      transcriptSessions
        .map((t) => t.docsDestination?.document)
        .filter((d): d is string => !!d)
    ),
  ];
  // Structured transcript entries (paginated, capped) across ALL sessions.
  const entries: MeetTranscriptEntry[] = [];
  let entriesTruncated = false;
  for (const session of transcriptSessions) {
    if (entries.length >= MAX_TRANSCRIPT_ENTRIES) {
      entriesTruncated = true;
      break;
    }
    let entryPageToken: string | undefined;
    while (entries.length < MAX_TRANSCRIPT_ENTRIES) {
      const page = await tryJson<{
        transcriptEntries?: Array<{
          participant?: string;
          text?: string;
          startTime?: string;
          endTime?: string;
        }>;
        nextPageToken?: string;
      }>(
        token,
        `${MEET_API}/${session.name}/entries?pageSize=1000${entryPageToken ? `&pageToken=${entryPageToken}` : ''}`
      );
      if (!page) break;
      for (const e of page.transcriptEntries ?? []) {
        if (!e.text) continue;
        if (entries.length >= MAX_TRANSCRIPT_ENTRIES) {
          entriesTruncated = true;
          break;
        }
        const p = e.participant ? participantByResource.get(e.participant) : undefined;
        const startMs =
          anchorMs != null && e.startTime
            ? Math.max(0, new Date(e.startTime).getTime() - anchorMs)
            : 0;
        const endMs =
          anchorMs != null && e.endTime
            ? Math.max(startMs, new Date(e.endTime).getTime() - anchorMs)
            : startMs;
        entries.push({
          speaker: p?.displayName ?? 'Unknown',
          email: p?.email,
          text: e.text,
          startIso: e.startTime,
          endIso: e.endTime,
          start: startMs,
          end: endMs,
        });
      }
      entryPageToken = page.nextPageToken;
      if (!entryPageToken) break;
    }
  }

  return {
    conferenceRecordName: recordName,
    conferenceStart: record?.startTime,
    conferenceEnd: record?.endTime,
    recordings,
    transcriptDocIds,
    participants,
    transcriptEntries: entries.length > 0 ? entries : undefined,
    entriesTruncated: entriesTruncated || undefined,
    anchorIso,
  };
}

/**
 * Build display utterances from structured Meet API entries — preferred over
 * Doc parsing when available (precise per-utterance times vs 5-minute
 * blocks). Consecutive same-speaker entries with small gaps are merged so
 * the transcript reads as turns, not sentences.
 */
export function utterancesFromEntries(entries: MeetTranscriptEntry[]): MeetUtterance[] {
  const out: MeetUtterance[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.speaker === e.speaker &&
      e.start - prev.end <= 2000 &&
      prev.text.length < 600
    ) {
      prev.text += ` ${e.text}`;
      prev.end = e.end;
    } else {
      out.push({ speaker: e.speaker, text: e.text, start: e.start, end: e.end });
    }
  }
  return out;
}

/**
 * Wrap a parsed Meet transcript in the TranscriptResponse shape the rest of
 * the app already renders (imported_content cache). Speaker labels are the
 * REAL display names from Google — no diarization letters to map.
 */
export function synthesizeTranscriptResponse(
  id: string,
  parsed: ParsedMeetTranscript,
  opts: { createdIso?: string; completedIso?: string } = {}
): TranscriptResponse {
  const last = parsed.utterances[parsed.utterances.length - 1];
  return {
    id,
    status: 'completed',
    text: parsed.utterances.map((u) => u.text).join(' '),
    created: opts.createdIso ?? new Date().toISOString(),
    completed: opts.completedIso ?? opts.createdIso ?? new Date().toISOString(),
    audio_duration: last ? Math.round(last.end / 1000) : 0,
    utterances: parsed.utterances,
  };
}

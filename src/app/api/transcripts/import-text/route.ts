import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withAuth } from '@/lib/auth/with-auth';
import { runClaudeWithMeta, parseJsonFromClaude } from '@/lib/server/claude-agent';
import { recordAiRun } from '@/db-ops/ai-runs';
import { extractAttachmentText } from '@/lib/server/attachment-extract';
import { getStorageDir } from '@/lib/server/audio-storage';
import { ingestParsedUtterances } from '@/lib/server/ingest-parsed';

export const runtime = 'nodejs';
// The normalization runs a headless-Claude pass — give it room.
export const maxDuration = 600;

const MAX_INPUT_CHARS = 400_000;
const CHARS_PER_SECOND = 14; // fallback timing when the source has no timestamps

const NORMALIZE_PROMPT = `You are a meeting-transcript format normalizer.

Below is the raw content of a meeting transcript exported from some tool (Microsoft Teams, Zoom, Webex, a VTT/SRT caption file, a chat log, pasted notes — the format is unknown). Convert it to EXACTLY this JSON shape and output ONLY the JSON, no markdown fences, no commentary:

{"title": <string or null — the meeting title if the document states one>,
 "attendees": <array of participant name strings, [] if unknown>,
 "language": <BCP-47-ish language code of the speech, e.g. "en", or null>,
 "utterances": [{"speaker": <string>, "text": <string>, "start_ms": <integer or null>, "end_ms": <integer or null>}]}

Rules:
- Preserve utterance order exactly. Do not summarize, translate, correct, or invent anything — the text must be verbatim from the source (you may repair obvious mojibake/encoding artifacts).
- Caption formats (VTT/SRT) split one sentence across many cues: merge consecutive cues of the SAME speaker into one utterance when they clearly form continuous speech; use the first cue's start and last cue's end.
- Timestamps: convert whatever format the source uses (hh:mm:ss.mmm, mm:ss, "5m 2s", absolute clock times) to integer milliseconds from meeting start. If the source has none, use null.
- Speaker: the name as written in the source. If a line has no speaker, attribute it to the most recent speaker; if there is genuinely no speaker information at all, use "Speaker 1".
- Skip non-speech furniture: headers, page numbers, "recording started", timestamps-only lines, disclaimers.

Source content follows:

`;

interface NormalizedTranscript {
  title?: string | null;
  attendees?: string[];
  language?: string | null;
  utterances?: Array<{
    speaker?: string;
    text?: string;
    start_ms?: number | null;
    end_ms?: number | null;
  }>;
}

/**
 * POST /api/transcripts/import-text
 *
 * Import a transcript from ANY format. Body: JSON { text, title?, filename? }
 * for pasted content, or raw file bytes with an `x-filename` header (docx /
 * pdf / vtt / srt / txt — text is extracted server-side). A headless-Claude
 * pass normalizes the content to utterances; the result is stored as a
 * completed imported transcript (no audio), speakers named from the source.
 */
export const POST = withAuth(async ({ user, request }) => {
  const contentType = request.headers.get('content-type') ?? '';

  let sourceText = '';
  let title: string | null = null;
  let originalFilename: string | null = null;

  if (contentType.includes('application/json')) {
    let body: { text?: string; title?: string; filename?: string };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    sourceText = typeof body.text === 'string' ? body.text : '';
    title = body.title?.trim() || null;
    originalFilename = body.filename?.trim() || null;
  } else {
    const rawName = request.headers.get('x-filename');
    if (rawName) {
      try {
        originalFilename = decodeURIComponent(rawName);
      } catch {
        originalFilename = rawName;
      }
    }
    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length === 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400 });
    }
    if (buf.length > 50 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large (max 50 MB)' }, { status: 413 });
    }
    // Land the bytes in a temp file so the extractor's CLI tools can see it.
    const tmp = path.join(getStorageDir(), `tmp-import-${randomUUID()}`);
    const tmpWithExt = originalFilename
      ? `${tmp}${path.extname(originalFilename).toLowerCase()}`
      : tmp;
    await fsp.mkdir(getStorageDir(), { recursive: true });
    await fsp.writeFile(tmpWithExt, buf);
    try {
      const extraction = await extractAttachmentText(
        tmpWithExt,
        originalFilename,
        contentType.split(';')[0]?.trim() || null
      );
      sourceText = extraction.text ?? '';
    } finally {
      await fsp.unlink(tmpWithExt).catch(() => {});
    }
  }

  sourceText = sourceText.trim();
  if (sourceText.length < 20) {
    return NextResponse.json(
      { error: 'Could not read any text out of that input.' },
      { status: 422 }
    );
  }
  if (sourceText.length > MAX_INPUT_CHARS) {
    sourceText = sourceText.slice(0, MAX_INPUT_CHARS);
  }

  // Headless-Claude normalization pass.
  let normalized: NormalizedTranscript;
  let normalizeRun: Awaited<ReturnType<typeof runClaudeWithMeta>> | null = null;
  const normalizePrompt = NORMALIZE_PROMPT + sourceText;
  try {
    normalizeRun = await runClaudeWithMeta(normalizePrompt, { timeoutMs: 8 * 60 * 1000 });
    normalized = parseJsonFromClaude<NormalizedTranscript>(normalizeRun.text);
  } catch (err) {
    console.error('[import-text] normalization failed:', err);
    void recordAiRun({
      kind: 'import_normalize',
      triggeredBy: { userId: user.userId, email: user.email },
      status: 'error',
      error: String(err).slice(0, 1000),
      meta: normalizeRun?.meta ?? null,
      promptChars: normalizePrompt.length,
    });
    return NextResponse.json(
      { error: 'AI normalization failed', detail: String(err).slice(0, 300) },
      { status: 502 }
    );
  }

  const rawUtterances = (normalized.utterances ?? []).filter(
    (u) => typeof u.text === 'string' && u.text.trim().length > 0
  );
  if (rawUtterances.length === 0) {
    return NextResponse.json(
      { error: 'No utterances could be recognised in that content.' },
      { status: 422 }
    );
  }

  // Fill timing: keep source timestamps where sane, estimate the rest so
  // ordering and the outline still work.
  let cursor = 0;
  const utterances = rawUtterances.map((u) => {
    const est = Math.max(800, Math.round((u.text!.length / CHARS_PER_SECOND) * 1000));
    let start = typeof u.start_ms === 'number' && u.start_ms >= 0 ? Math.round(u.start_ms) : cursor;
    if (start < cursor - 60_000) start = cursor; // wildly backwards → resequence
    const end =
      typeof u.end_ms === 'number' && u.end_ms > start ? Math.round(u.end_ms) : start + est;
    cursor = end;
    return { speaker: (u.speaker ?? 'Speaker 1').trim().slice(0, 80) || 'Speaker 1', text: u.text!.trim(), start, end };
  });

  const syntheticId = `ext-${randomUUID().slice(0, 12)}`;
  const { row } = await ingestParsedUtterances(
    { userId: user.userId, email: user.email },
    {
      sourceId: syntheticId,
      title: title ?? normalized.title?.trim().slice(0, 200) ?? null,
      parsed: { attendees: normalized.attendees ?? [], utterances },
      originalFilename,
      languageCode: normalized.language ?? null,
      logTag: '[import-text]',
    }
  );

  void recordAiRun({
    transcriptId: row.id,
    assemblyaiId: syntheticId,
    kind: 'import_normalize',
    triggeredBy: { userId: user.userId, email: user.email },
    status: 'completed',
    meta: normalizeRun.meta,
    promptChars: normalizePrompt.length,
    resultChars: normalizeRun.text.length,
  });

  return NextResponse.json({ transcript: row }, { status: 201 });
});

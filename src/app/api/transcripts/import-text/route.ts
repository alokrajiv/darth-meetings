import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withAuth } from '@/lib/auth/with-auth';
import { runClaudeWithMeta, parseJsonFromClaude } from '@/lib/server/claude-agent';
import { recordAiRun } from '@/db-ops/ai-runs';
import { extractAttachmentText } from '@/lib/server/attachment-extract';
import { getStorageDir } from '@/lib/server/audio-storage';
import {
  createTextImportPlaceholder,
  ingestParsedUtterances,
} from '@/lib/server/ingest-parsed';
import { tryParseTranscriptText } from '@/lib/server/transcript-text-parse';
import { updateMetaForUser, updateStatusForUser, type TranscriptRow } from '@/db-ops/transcripts';
import { publishEvent } from '@/lib/server/event-bus';
import type { MeetUtterance } from '@/lib/format';

export const runtime = 'nodejs';
// Known formats import synchronously in milliseconds; the LLM fallback runs
// in the background — the request itself only creates a placeholder row.
export const maxDuration = 600;

const MAX_INPUT_CHARS = 400_000;
const CHARS_PER_SECOND = 14; // fallback timing when the source has no timestamps
// The LLM pass is mechanical reformatting — a fast model on low effort is
// plenty (the opus/medium default was the 2026-08-18 timeout incident).
const NORMALIZE_TIMEOUT_MS = 900 * 1000;

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
 * Fill timing: keep source timestamps where sane, estimate the rest so
 * ordering and the outline still work.
 */
function fillTiming(
  utts: Array<{ speaker: string; text: string; startMs?: number | null; endMs?: number | null }>
): MeetUtterance[] {
  let cursor = 0;
  return utts.map((u) => {
    const est = Math.max(800, Math.round((u.text.length / CHARS_PER_SECOND) * 1000));
    let start = typeof u.startMs === 'number' && u.startMs >= 0 ? Math.round(u.startMs) : cursor;
    if (start < cursor - 60_000) start = cursor; // wildly backwards → resequence
    const end = typeof u.endMs === 'number' && u.endMs > start ? Math.round(u.endMs) : start + est;
    cursor = end;
    return {
      speaker: u.speaker.trim().slice(0, 80) || 'Speaker 1',
      text: u.text.trim(),
      start,
      end,
    };
  });
}

/**
 * In-flight async normalizations keyed by sha256(userId + text): a second
 * identical request while one runs gets the SAME 202 row instead of
 * double-running the model (the incident's overlapping-retry failure mode).
 * On globalThis so dev hot-reloads don't strand entries; the deployment is a
 * single pm2 process, so in-process is sufficient.
 */
declare global {
  var __mwImportNormalizeInflight:
    | Map<string, Promise<{ id: number; assemblyaiId: string }>>
    | undefined;
}
const inFlight: Map<string, Promise<{ id: number; assemblyaiId: string }>> =
  globalThis.__mwImportNormalizeInflight ?? (globalThis.__mwImportNormalizeInflight = new Map());

/** Background LLM normalization filling a pre-created placeholder row. */
async function normalizeTextInBackground(
  user: { userId: string; email: string },
  row: TranscriptRow,
  sourceText: string,
  title: string | null,
  originalFilename: string | null
): Promise<void> {
  const sourceId = row.assemblyai_id;
  const normalizePrompt = NORMALIZE_PROMPT + sourceText;
  let normalizeRun: Awaited<ReturnType<typeof runClaudeWithMeta>> | null = null;
  try {
    normalizeRun = await runClaudeWithMeta(normalizePrompt, {
      timeoutMs: NORMALIZE_TIMEOUT_MS,
      model: process.env.MW_IMPORT_NORMALIZE_MODEL || 'sonnet',
      effort: process.env.MW_IMPORT_NORMALIZE_EFFORT || 'low',
    });
    const normalized = parseJsonFromClaude<NormalizedTranscript>(normalizeRun.text);
    const rawUtterances = (normalized.utterances ?? []).filter(
      (u) => typeof u.text === 'string' && u.text.trim().length > 0
    );
    if (rawUtterances.length === 0) {
      throw new Error('No utterances could be recognised in that content.');
    }
    const utterances = fillTiming(
      rawUtterances.map((u) => ({
        speaker: u.speaker ?? 'Speaker 1',
        text: u.text!,
        startMs: u.start_ms,
        endMs: u.end_ms,
      }))
    );

    // Same-id upsert fills the placeholder in place (content, duration,
    // speaker_count, title, status 'completed') and publishes 'created'.
    await ingestParsedUtterances(user, {
      sourceId,
      title: title ?? normalized.title?.trim().slice(0, 200) ?? null,
      parsed: { attendees: normalized.attendees ?? [], utterances },
      originalFilename,
      languageCode: normalized.language ?? null,
      logTag: '[import-text]',
    });
    publishEvent({ kind: 'status', assemblyaiId: sourceId });
    publishEvent({ kind: 'meta', assemblyaiId: sourceId });

    void recordAiRun({
      transcriptId: row.id,
      assemblyaiId: sourceId,
      kind: 'import_normalize',
      triggeredBy: { userId: user.userId, email: user.email },
      status: 'completed',
      meta: normalizeRun.meta,
      promptChars: normalizePrompt.length,
      resultChars: normalizeRun.text.length,
    });
  } catch (err) {
    console.error('[import-text] async normalization failed:', err);
    // Flip the placeholder to 'error' with the reason where the listing's
    // error rendering can surface it (description subline).
    await updateStatusForUser(user.userId, sourceId, { status: 'error' }).catch(() => {});
    await updateMetaForUser(user.userId, sourceId, {
      description: `AI normalization failed: ${String(err).slice(0, 300)}`,
    }).catch(() => {});
    void recordAiRun({
      transcriptId: row.id,
      assemblyaiId: sourceId,
      kind: 'import_normalize',
      triggeredBy: { userId: user.userId, email: user.email },
      status: 'error',
      error: String(err).slice(0, 1000),
      meta: normalizeRun?.meta ?? null,
      promptChars: normalizePrompt.length,
    });
  }
}

/**
 * POST /api/transcripts/import-text
 *
 * Import a transcript from ANY format. Body: JSON { text, title?, filename? }
 * for pasted content, or raw file bytes with an `x-filename` header (docx /
 * pdf / vtt / srt / txt — text is extracted server-side).
 *
 * Known machine-regular formats (VTT, SRT, "Name | MM:SS", …) are parsed
 * deterministically and ingest synchronously → 201 with `fastPath` set.
 * Unknown formats fall back to a background headless-Claude normalization →
 * 202 with a 'processing' placeholder row that fills in when the model
 * finishes (the listing shows it immediately and flips over SSE).
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

  // Deterministic fast path: known formats never touch the model.
  const parsed = tryParseTranscriptText(sourceText);
  if (parsed) {
    const utterances = fillTiming(parsed.utterances);
    const attendees = [...new Set(utterances.map((u) => u.speaker))].filter(
      (s) => !/^Speaker(\s+\d+)?$/i.test(s)
    );
    const syntheticId = `ext-${randomUUID().slice(0, 12)}`;
    const { row } = await ingestParsedUtterances(
      { userId: user.userId, email: user.email },
      {
        sourceId: syntheticId,
        title,
        parsed: { attendees, utterances },
        originalFilename,
        logTag: '[import-text]',
      }
    );
    return NextResponse.json({ transcript: row, fastPath: parsed.format }, { status: 201 });
  }

  // Unknown format → async LLM normalization behind a placeholder row.
  const dedupeKey = createHash('sha256')
    .update(user.userId)
    .update('\0')
    .update(sourceText)
    .digest('hex');

  const existing = inFlight.get(dedupeKey);
  if (existing) {
    try {
      const info = await existing;
      return NextResponse.json({ queued: true, ...info }, { status: 202 });
    } catch {
      // The original attempt failed before its placeholder existed — start fresh.
    }
  }

  const syntheticId = `ext-${randomUUID().slice(0, 12)}`;
  const placeholderPromise = createTextImportPlaceholder(
    { userId: user.userId },
    { sourceId: syntheticId, title, originalFilename }
  );
  const infoPromise = placeholderPromise.then((r) => ({
    id: r.id,
    assemblyaiId: r.assemblyai_id,
  }));
  inFlight.set(dedupeKey, infoPromise);

  // Fire-and-forget (same pattern as onTranscriptCompleted): the entry stays
  // in the map for the whole run so identical retries keep landing on this row.
  void (async () => {
    try {
      const row = await placeholderPromise;
      await normalizeTextInBackground(
        { userId: user.userId, email: user.email },
        row,
        sourceText,
        title,
        originalFilename
      );
    } catch (err) {
      console.error('[import-text] background normalization wrapper failed:', err);
    } finally {
      inFlight.delete(dedupeKey);
    }
  })();

  let info: { id: number; assemblyaiId: string };
  try {
    info = await infoPromise;
  } catch (err) {
    console.error('[import-text] placeholder creation failed:', err);
    return NextResponse.json({ error: 'Could not start the import' }, { status: 500 });
  }
  return NextResponse.json({ queued: true, ...info }, { status: 202 });
});

import { NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { withAuth } from '@/lib/auth/with-auth';
import {
  runClaudeWithMeta,
  parseJsonFromClaude,
  type ClaudeRunMeta,
  type ClaudeRunResult,
} from '@/lib/server/claude-agent';
import { applyRecipeWithValidation } from '@/lib/server/transcript-recipe';
import type { ParsedTextUtterance } from '@/lib/server/transcript-text-parse';
import { recordAiRun } from '@/db-ops/ai-runs';
import { extractAttachmentText } from '@/lib/server/attachment-extract';
import { getStorageDir } from '@/lib/server/audio-storage';
import {
  createTextImportPlaceholder,
  ingestParsedUtterances,
} from '@/lib/server/ingest-parsed';
import {
  linkedEventIngestFields,
  sanitizeLinkedEvent,
  type LinkedEventIngestFields,
} from '@/lib/server/linked-event';
import { tryParseTranscriptText } from '@/lib/server/transcript-text-parse';
import { resolveLinkedEventRef } from '@/lib/server/linked-event-ref';
import { updateMetaForUser, updateStatusForUser, type TranscriptRow } from '@/db-ops/transcripts';
import { publishEvent } from '@/lib/server/event-bus';
import type { MeetUtterance } from '@/lib/format';

export const runtime = 'nodejs';
// Known formats import synchronously in milliseconds; the LLM fallback runs
// in the background — the request itself only creates a placeholder row.
export const maxDuration = 600;

const MAX_INPUT_CHARS = 400_000;
const CHARS_PER_SECOND = 14; // fallback timing when the source has no timestamps
// The LLM pass only emits a tiny parsing RECIPE (never the transcript text —
// the verbatim-echo prompt was the 2026-08-18 timeout incident: output tokens
// scaled 1:1 with file size). A fast model on low effort is plenty; the
// generous timeout stays as a belt-and-suspenders bound.
const NORMALIZE_TIMEOUT_MS = 900 * 1000;

const RECIPE_PROMPT = `You are a meeting-transcript format analyst.

Below is the raw content of a meeting transcript exported from some tool (Microsoft Teams, Zoom, Webex, a caption file, a chat log, pasted notes — the format is unknown). DO NOT re-emit, transcribe, or reformat the content itself. Instead, analyze its STRUCTURE and return ONLY a small JSON "parsing recipe" that a program will apply to the original text to split it into speaker turns.

Output EXACTLY one JSON object, no markdown fences, no commentary:

{"title": <string or null — the meeting title if the document states one>,
 "attendees": <array of participant name strings, [] if unknown>,
 "language": <BCP-47-ish language code of the speech, e.g. "en", or null>,
 "recipe": <recipe object, option A, B or C below>}

Option A — "line-regex" (STRONGLY preferred: use it whenever the file has ANY per-line structure — speaker headers, timestamps, "Name: text" lines, chat-log prefixes):

{"kind": "line-regex",
 "headerRegex": <JavaScript regex source, no surrounding slashes, max 300 chars>,
 "headerStyle": "own-line" | "inline-prefix",
 "flags": <optional flags string, e.g. "i">,
 "evidence": [<1-2 example lines from the source that the regex matches — for debuggability>]}

- headerRegex MUST use named capture groups: (?<speaker>…) is required; add (?<h>…), (?<m>…), (?<s>…) for hour/minute/second timestamp digits when the format has timestamps; for inline-prefix you may add (?<text>…) for the speech on the header line.
- "own-line": the speaker/timestamp header is a line of its own; a line matching headerRegex starts a new turn and the following non-matching lines are that turn's speech.
- "inline-prefix": headerRegex matches at the START of a line (anchor it with ^); the rest of the line (or the (?<text>) group) is the turn's speech; following non-matching lines continue the same turn.
- The regex is applied to each individual trimmed line. Make it strict enough that ordinary speech lines do NOT match it.

Option B — "anchors" (ONLY when the text has no per-line structure at all, e.g. flowing prose):

{"kind": "anchors",
 "turns": [{"speaker": <string>, "anchor": <verbatim quote of the FIRST few words of that turn, max 80 chars>}, …]}

- List every speaker turn in source order. Each anchor must be copied character-for-character from the source (a program locates them with indexOf, scanning forward only) and should be distinctive enough to pin down that spot. Keep every anchor short (max 80 chars) — never quote more.
- If speakers are unnamed, use "Speaker 1", "Speaker 2", ….

Option C — "document" (ONLY when the content is NOT a conversation at all — meeting minutes, notes, an agenda, an action-item list, a report. There are no speaker turns to find, so don't invent them):

{"kind": "document"}

- The program imports the content as-is, split into paragraph blocks. Still fill title/attendees/language from what the document says (attendees = participant names it mentions).

Hard rules:
- NEVER output the transcript content. The ONLY source text allowed in your output is the short evidence lines / anchors described above.
- Your entire output must stay small — a recipe, not a transcript.

Source content follows:

`;

interface RecipeResponse {
  title?: string | null;
  attendees?: string[];
  language?: string | null;
  recipe?: unknown;
}

/** Combine per-attempt usage so both the first try and the corrective retry
 * land in ONE ai_run (sums the additive fields, keeps the final model/session). */
function combineRunMeta(runs: ClaudeRunResult[]): ClaudeRunMeta | null {
  if (runs.length === 0) return null;
  if (runs.length === 1) return runs[0]!.meta;
  const last = runs[runs.length - 1]!.meta;
  const sum = (pick: (m: ClaudeRunMeta) => number | null): number | null => {
    let any = false;
    let total = 0;
    for (const r of runs) {
      const v = pick(r.meta);
      if (v != null) {
        any = true;
        total += v;
      }
    }
    return any ? total : null;
  };
  return {
    sessionId: last.sessionId,
    model: last.model,
    costUsd: sum((m) => m.costUsd),
    durationMs: sum((m) => m.durationMs),
    apiDurationMs: sum((m) => m.apiDurationMs),
    numTurns: sum((m) => m.numTurns),
    inputTokens: sum((m) => m.inputTokens),
    outputTokens: sum((m) => m.outputTokens),
    cacheReadTokens: sum((m) => m.cacheReadTokens),
    cacheCreationTokens: sum((m) => m.cacheCreationTokens),
  };
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

/**
 * Background LLM normalization filling a pre-created placeholder row.
 *
 * The model only returns a small parsing RECIPE (line-regex or anchors, see
 * transcript-recipe.ts) which is applied to the source text in pure code. A
 * recipe that fails the validation bars gets ONE corrective retry (same
 * prompt + a short failure report); if that also fails the row flips to
 * 'error' with an honest message. Both attempts' usage lands in one ai_run.
 */
async function normalizeTextInBackground(
  user: { userId: string; email: string },
  row: TranscriptRow,
  sourceText: string,
  title: string | null,
  originalFilename: string | null,
  link: LinkedEventIngestFields | null
): Promise<void> {
  const sourceId = row.assemblyai_id;
  const basePrompt = RECIPE_PROMPT + sourceText;
  const runs: ClaudeRunResult[] = [];
  let promptCharsTotal = 0;
  try {
    let recipeUtterances: ParsedTextUtterance[] | null = null;
    let normalized: RecipeResponse = {};
    let prompt = basePrompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      promptCharsTotal += prompt.length;
      const run = await runClaudeWithMeta(prompt, {
        timeoutMs: NORMALIZE_TIMEOUT_MS,
        model: process.env.MW_IMPORT_NORMALIZE_MODEL || 'sonnet',
        effort: process.env.MW_IMPORT_NORMALIZE_EFFORT || 'low',
      });
      runs.push(run);

      let failure: string;
      try {
        normalized = parseJsonFromClaude<RecipeResponse>(run.text);
        const applied = applyRecipeWithValidation(sourceText, normalized.recipe);
        if (applied.ok) {
          recipeUtterances = applied.utterances;
          break;
        }
        failure = applied.failure;
      } catch (parseErr) {
        failure = `your response was not parseable JSON: ${String(
          parseErr instanceof Error ? parseErr.message : parseErr
        ).slice(0, 200)}`;
      }
      if (attempt === 0) {
        console.warn(`[import-text] recipe attempt 1 failed (${sourceId}): ${failure}`);
        prompt = `${basePrompt}\n\n---\nA previous attempt at this task returned a recipe that failed validation: ${failure}.\nAnalyze the structure again and return a corrected recipe — same JSON shape, ONLY the JSON object.`;
      } else {
        throw new Error(`Could not derive a working parsing recipe: ${failure}`);
      }
    }
    if (!recipeUtterances || recipeUtterances.length === 0) {
      throw new Error('No utterances could be recognised in that content.');
    }
    const utterances = fillTiming(recipeUtterances);

    // Same-id upsert fills the placeholder in place (content, duration,
    // speaker_count, title, status 'completed') and publishes 'created'.
    await ingestParsedUtterances(user, {
      sourceId,
      title:
        title ?? normalized.title?.trim().slice(0, 200) ?? link?.eventTitle ?? null,
      parsed: { attendees: normalized.attendees ?? [], utterances },
      originalFilename,
      recordedAtIso: link?.recordedAtIso ?? null,
      languageCode: normalized.language ?? null,
      gmeetContext: link?.gmeetContext ?? null,
      attendees: link?.attendees ?? [],
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
      meta: combineRunMeta(runs),
      promptChars: promptCharsTotal,
      resultChars: runs.reduce((n, r) => n + r.text.length, 0),
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
      meta: combineRunMeta(runs),
      promptChars: promptCharsTotal || basePrompt.length,
    });
  }
}

/**
 * POST /api/transcripts/import-text
 *
 * Import a transcript from ANY format. Body: JSON { text, title?, filename?,
 * linkedEvent? } for pasted content, or raw file bytes with an `x-filename`
 * header (docx / pdf / vtt / srt / txt — text is extracted server-side; an
 * optional `x-linked-event` header carries the linkage, same encoding as the
 * media-upload route). `linkedEvent` is the calendar event this transcript
 * belongs to — it's stamped into gmeet_context exactly like an uploaded
 * recording's link (title/recorded_at fallbacks, invitee context for speaker
 * naming, series auto-attach).
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
  let linkedEventRaw: unknown = null;

  if (contentType.includes('application/json')) {
    let body: { text?: string; title?: string; filename?: string; linkedEvent?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    sourceText = typeof body.text === 'string' ? body.text : '';
    title = body.title?.trim() || null;
    originalFilename = body.filename?.trim() || null;
    linkedEventRaw = body.linkedEvent ?? null;
  } else {
    const rawLinked = request.headers.get('x-linked-event');
    if (rawLinked) {
      try {
        linkedEventRaw = JSON.parse(decodeURIComponent(rawLinked));
      } catch {
        linkedEventRaw = null;
      }
    }
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

  let linkedEvent = sanitizeLinkedEvent(linkedEventRaw);
  // Headless pre-link by reference (darth-cli `upload --event <ref>` on a
  // text document) — same resolver as the media routes.
  const eventRef = request.nextUrl.searchParams.get('event');
  if (eventRef) {
    const resolved = await resolveLinkedEventRef(user.userId, eventRef);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    linkedEvent = resolved.event;
  }
  const link = linkedEvent ? linkedEventIngestFields(linkedEvent) : null;

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
        title: title ?? link?.eventTitle ?? null,
        parsed: { attendees, utterances },
        originalFilename,
        recordedAtIso: link?.recordedAtIso ?? null,
        gmeetContext: link?.gmeetContext ?? null,
        attendees: link?.attendees ?? [],
        logTag: '[import-text]',
      }
    );
    return NextResponse.json({ transcript: row, fastPath: parsed.format }, { status: 201 });
  }

  // Unknown format → async LLM normalization behind a placeholder row.
  const dedupeKey = createHash('sha256')
    .update(user.userId)
    .update('\0')
    // Same text linked to a different event is a distinct import.
    .update(linkedEvent?.id ?? '')
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
    { sourceId: syntheticId, title: title ?? link?.eventTitle ?? null, originalFilename }
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
        originalFilename,
        link
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

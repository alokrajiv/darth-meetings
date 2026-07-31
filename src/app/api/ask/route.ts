import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { runClaudeWithMeta } from '@/lib/server/claude-cli';
import { recordAiRun } from '@/db-ops/ai-runs';
import { listVisibleToUser } from '@/db-ops/transcripts';
import { searchVisibleTranscripts } from '@/db-ops/transcript-search';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/ask — conversational "Ask AI" over the caller's archive.
 * Body: { question: string, sessionId?: string }
 *
 * First turn: the prompt carries the caller's full visible meeting list
 * (small — titles/dates/descriptions) plus deep-search snippets for the
 * question. Follow-ups ride `claude -p --resume <sessionId>` so the model
 * keeps the whole conversation (and the archive context) without resending
 * it — that's what makes follow-ups cheap and coherent.
 *
 * Runs at effort LOW for latency: retrieval is done here in SQL; the model
 * only has to read, reason lightly, and answer with links.
 */
export const POST = withAuth(async ({ user, request }) => {
  const body = (await request.json().catch(() => null)) as {
    question?: string;
    sessionId?: string;
  } | null;
  const question = body?.question?.trim();
  if (!question || question.length < 3) {
    return NextResponse.json({ error: 'Ask a real question' }, { status: 400 });
  }
  if (question.length > 2000) {
    return NextResponse.json({ error: 'Question too long' }, { status: 400 });
  }

  // Retrieval — always: deep-search hits for the question terms (whole
  // phrase + significant words), capped tight.
  const words = [
    ...new Set(
      question
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((w) => w.length >= 4)
        .slice(0, 6)
    ),
  ];
  const hitLists = await Promise.all([
    searchVisibleTranscripts(user.userId, user.email, question, 10),
    ...words.map((w) => searchVisibleTranscripts(user.userId, user.email, w, 8)),
  ]);
  const seen = new Set<string>();
  const hitLines: string[] = [];
  for (const list of hitLists) {
    for (const h of list) {
      const key = `${h.assemblyai_id}:${h.snippet ?? h.matched_in}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hitLines.push(
        `- id=${h.assemblyai_id} matched in ${h.matched_in}${h.snippet ? `: "…${h.snippet.trim()}…"` : ''}`
      );
      if (hitLines.length >= 30) break;
    }
    if (hitLines.length >= 30) break;
  }

  let prompt: string;
  if (body?.sessionId) {
    // Follow-up: the session already holds the archive listing + prior turns.
    prompt =
      `Follow-up question: ${question}\n\n` +
      (hitLines.length
        ? `Fresh search hits for this question (same id/link rules as before):\n${hitLines.join('\n')}\n`
        : '');
  } else {
    const rows = await listVisibleToUser(user.userId, user.email);
    const listing = rows
      .filter((r) => r.status === 'completed')
      .slice(0, 300)
      .map((r) => {
        const date = (r.recorded_at ?? r.created_at).slice(0, 10);
        const mins = r.duration ? Math.round(r.duration / 60) : null;
        const desc = r.description?.trim()
          ? ` — ${r.description.trim().slice(0, 120)}`
          : '';
        return `- id=${r.assemblyai_id} | ${date}${mins ? ` | ${mins}m` : ''} | ${r.title || r.original_filename || 'Untitled'}${desc}`;
      })
      .join('\n');

    prompt = `You are the meeting-archive assistant for Trames' internal "Meeting Whisperer" tool. The user asks questions about their recorded meetings; you answer conversationally and point them at the right transcripts.

Rules:
- Link every meeting you mention as a markdown link: [<title>](/transcript/<id>) using the exact id given. Never invent ids.
- Ground answers ONLY in the meeting list and search snippets provided. If the evidence is thin, say what you'd search instead of guessing.
- Be brief: a couple of sentences plus the relevant links. This is a chat panel, not a report.
- The user may ask follow-ups later in this same session — keep context.

The user's meeting archive (completed meetings, newest first):
${listing}

Search hits for the current question (snippets from transcript text/summaries):
${hitLines.join('\n') || '(no text matches — reason from titles/dates)'}

Question: ${question}`;
  }

  const started = Date.now();
  try {
    const run = await runClaudeWithMeta(prompt, {
      timeoutMs: 4 * 60 * 1000,
      resumeSessionId: body?.sessionId,
      effort: 'low',
    });
    void recordAiRun({
      kind: 'ask',
      triggeredBy: { userId: user.userId, email: user.email },
      status: 'completed',
      meta: run.meta,
      promptChars: prompt.length,
      resultChars: run.text.length,
    });
    return NextResponse.json({
      answer: run.text,
      sessionId: run.meta.sessionId ?? body?.sessionId ?? null,
      costUsd: run.meta.costUsd,
      durationMs: run.meta.durationMs ?? Date.now() - started,
    });
  } catch (err) {
    void recordAiRun({
      kind: 'ask',
      triggeredBy: { userId: user.userId, email: user.email },
      status: 'error',
      error: String(err).slice(0, 1000),
      promptChars: prompt.length,
    });
    return NextResponse.json(
      { error: 'Ask failed', detail: String(err).slice(0, 300) },
      { status: 502 }
    );
  }
});

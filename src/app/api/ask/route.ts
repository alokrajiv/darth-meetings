import { NextResponse } from 'next/server';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { runClaudeWithMeta } from '@/lib/server/claude-agent';
import { recordAiRun } from '@/db-ops/ai-runs';
import { listVisibleToUser } from '@/db-ops/transcripts';
import { searchVisibleTranscripts } from '@/db-ops/transcript-search';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SYSTEM_PROMPT = `You are the meeting-archive assistant for Trames' internal "Meeting Whisperer" tool. The user asks questions about their recorded meetings; you answer conversationally and point them at the right transcripts.

Rules:
- Link every meeting you mention as a markdown link: [<title>](/transcript/<id>) using the exact id given. Never invent ids.
- Use the search_transcripts tool whenever the provided context doesn't already answer the question — search short specific terms (product names, acronyms like SAP/ERP, people) and variants, not whole sentences. Several quick searches beat one vague one.
- Ground answers ONLY in the meeting list and search results. If nothing turns up after searching, say so.
- Be brief: a couple of sentences plus the relevant links. This is a chat panel, not a report.
- The user may ask follow-ups later in this same session — keep context.`;

/**
 * Per-request in-process MCP server: gives the model a real search tool
 * scoped to the caller's visible transcripts (same ACL as the UI search).
 */
function archiveTools(userId: string, email: string) {
  return createSdkMcpServer({
    name: 'archive',
    tools: [
      tool(
        'search_transcripts',
        'Full-text search across the meeting archive: titles, descriptions, AI notes, and raw transcript text. Returns matching meetings with their id, where the match was found, and a snippet.',
        {
          query: z.string().describe('A word or short phrase — acronyms and names work well'),
          limit: z.number().int().min(1).max(20).optional(),
        },
        async ({ query: q, limit }) => {
          const hits = await searchVisibleTranscripts(userId, email, q, Math.min(limit ?? 8, 20));
          const text = hits.length
            ? hits
                .map(
                  (h) =>
                    `id=${h.assemblyai_id} | matched in ${h.matched_in}${h.snippet ? ` | "…${h.snippet.trim()}…"` : ''}`
                )
                .join('\n')
            : '(no matches)';
          return { content: [{ type: 'text', text }] };
        }
      ),
    ],
  });
}

/**
 * POST /api/ask — conversational "Ask AI" over the caller's archive.
 * Body: { question: string, sessionId?: string }
 *
 * Runs on the Claude Agent SDK (subscription auth, same as the old
 * `claude -p` path). First turn: the prompt carries the caller's full
 * visible meeting list plus seed deep-search snippets for the question;
 * the model can then search iteratively itself via the archive MCP tool.
 * Follow-ups resume the session so context carries over without resending.
 *
 * Runs at effort LOW for latency: the model reads, searches, and answers
 * with links — no heavy reasoning needed.
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
  // phrase + significant words), capped tight. Length-only filtering is a
  // trap: it drops exactly the acronyms people ask about (SAP, ERP, TAT)
  // while keeping question filler ("when", "about", "recently") that
  // matches every transcript. So: 3+ chars, minus stopwords.
  const STOPWORDS = new Set([
    'the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'had', 'did',
    'does', 'can', 'could', 'will', 'would', 'should', 'not', 'but', 'with',
    'from', 'into', 'over', 'out', 'our', 'your', 'you', 'they', 'them',
    'their', 'this', 'that', 'these', 'those', 'there', 'then', 'than',
    'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'all',
    'any', 'some', 'something', 'anything', 'someone', 'anyone', 'more',
    'most', 'other', 'about', 'again', 'last', 'just', 'like', 'also',
    'talk', 'talks', 'talked', 'talking', 'say', 'said', 'says', 'tell',
    'told', 'discuss', 'discussed', 'discussion', 'mention', 'mentioned',
    'meeting', 'meetings', 'call', 'calls', 'recent', 'recently', 'week',
    'month', 'today', 'yesterday', 'time',
  ]);
  const words = [
    ...new Set(
      question
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
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
        // postgres.js hands timestamps back as Date objects despite the
        // string-typed row interface — normalise before slicing.
        const date = new Date(r.recorded_at ?? r.created_at).toISOString().slice(0, 10);
        const mins = r.duration ? Math.round(r.duration / 60) : null;
        const desc = r.description?.trim()
          ? ` — ${r.description.trim().slice(0, 120)}`
          : '';
        return `- id=${r.assemblyai_id} | ${date}${mins ? ` | ${mins}m` : ''} | ${r.title || r.original_filename || 'Untitled'}${desc}`;
      })
      .join('\n');

    prompt = `The user's meeting archive (completed meetings, newest first):
${listing}

Seed search hits for the current question (snippets from transcript text/summaries — search for more yourself if these don't answer it):
${hitLines.join('\n') || '(no text matches yet — use search_transcripts with better terms)'}

Question: ${question}`;
  }

  const started = Date.now();
  try {
    const run = await runClaudeWithMeta(prompt, {
      timeoutMs: 4 * 60 * 1000,
      resumeSessionId: body?.sessionId,
      effort: 'low',
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { archive: archiveTools(user.userId, user.email) },
      allowedTools: ['mcp__archive__search_transcripts'],
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

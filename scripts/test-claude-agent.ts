/**
 * Standalone smoke test for src/lib/server/claude-agent.ts.
 * Run: bun scripts/test-claude-agent.ts
 * Uses the local authenticated Claude Code install (subscription auth).
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runClaudeWithMeta } from '../src/lib/server/claude-agent';

async function main() {
  // 1. Plain single-shot run
  const r1 = await runClaudeWithMeta('Reply with exactly the word: pong', {
    effort: 'low',
    timeoutMs: 120_000,
  });
  console.log('[1] text:', JSON.stringify(r1.text));
  console.log('[1] meta:', r1.meta);
  if (!/pong/i.test(r1.text)) throw new Error('plain run failed');
  if (!r1.meta.sessionId || r1.meta.costUsd == null) throw new Error('meta incomplete');

  // 2. Agentic run with an in-process MCP search tool
  const calls: string[] = [];
  const server = createSdkMcpServer({
    name: 'archive',
    tools: [
      tool(
        'search_transcripts',
        'Full-text search over meeting transcripts. Returns matching meetings with ids and snippets.',
        { query: z.string(), limit: z.number().optional() },
        async ({ query: q }) => {
          calls.push(q);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify([
                  { id: 'abc-123', title: 'SAP integration sync', snippet: 'we discussed SAP IDoc flows with Danone' },
                ]),
              },
            ],
          };
        }
      ),
    ],
  });

  const r2 = await runClaudeWithMeta(
    'When did we discuss SAP? Use the search_transcripts tool to find out, then answer in one sentence citing the meeting title.',
    {
      effort: 'low',
      timeoutMs: 180_000,
      mcpServers: { archive: server },
      allowedTools: ['mcp__archive__search_transcripts'],
      systemPrompt:
        'You are a meeting-archive assistant. Always use the search_transcripts tool before answering.',
    }
  );
  console.log('[2] tool calls made:', calls);
  console.log('[2] text:', r2.text.slice(0, 300));
  console.log('[2] meta:', r2.meta);
  if (calls.length === 0) throw new Error('model never called the search tool');
  if (!/SAP integration sync/i.test(r2.text)) throw new Error('answer did not use tool result');

  // 3. Resume the session from run 2 — follow-up must retain context
  const r3 = await runClaudeWithMeta(
    'Follow-up: repeat just the meeting title you found earlier, nothing else.',
    {
      effort: 'low',
      timeoutMs: 120_000,
      resumeSessionId: r2.meta.sessionId!,
      mcpServers: { archive: server },
      allowedTools: ['mcp__archive__search_transcripts'],
    }
  );
  console.log('[3] text:', JSON.stringify(r3.text));
  if (!/SAP integration sync/i.test(r3.text)) throw new Error('resume lost context');

  console.log('\nALL PASS');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

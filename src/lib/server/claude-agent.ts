import {
  query,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Headless Claude via the Claude Agent SDK. Successor to the old
 * `spawn('claude', ['-p'])` wrapper in claude-cli.ts: the SDK embeds the same
 * Claude Code harness (bundled CLI, spawned in-process), so LLM work still
 * rides the VM's authenticated subscription — no API key, no metered billing.
 * What the SDK adds over shelling out:
 *   - in-process MCP tools (Ask AI gets a real search tool instead of
 *     pre-baked SQL retrieval),
 *   - typed result envelope (no JSON stdout parsing),
 *   - session resume + abort as first-class options.
 *
 * NOTE: no 'server-only' marker on purpose — scripts/test-claude-agent.ts
 * exercises this module directly with bun outside the Next runtime. Never
 * import it from client components.
 */

const CLAUDE_MODEL = process.env.MW_CLAUDE_MODEL || undefined; // undefined = CLI default
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const CLAUDE_EFFORT = EFFORT_LEVELS.has(process.env.MW_CLAUDE_EFFORT || '')
  ? (process.env.MW_CLAUDE_EFFORT as Effort)
  : undefined;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ClaudeRunMeta {
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  durationMs: number | null;
  apiDurationMs: number | null;
  numTurns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface ClaudeRunResult {
  text: string;
  meta: ClaudeRunMeta;
}

export interface RunClaudeOpts {
  timeoutMs?: number;
  /** Resume an earlier headless session (context carries over). */
  resumeSessionId?: string;
  /** Per-call effort override (low|medium|high|xhigh|max) — beats the env. */
  effort?: string;
  /** In-process MCP servers (createSdkMcpServer) keyed by server name. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tool allowlist, e.g. ['mcp__archive__search_transcripts']. */
  allowedTools?: string[];
  /** Custom system prompt (replaces the Claude Code preset). */
  systemPrompt?: string;
}

export async function runClaudeWithMeta(
  prompt: string,
  opts: RunClaudeOpts = {}
): Promise<ClaudeRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timeout')), timeoutMs);

  const effort =
    opts.effort && EFFORT_LEVELS.has(opts.effort)
      ? (opts.effort as Effort)
      : CLAUDE_EFFORT;

  const options: Options = {
    model: CLAUDE_MODEL,
    effort,
    // Run from the storage dir, not the repo — headless mode denies tool
    // permission requests anyway, but don't even tempt it with a codebase.
    cwd: process.env.MW_STORAGE_DIR || process.cwd(),
    abortController: abort,
    resume: opts.resumeSessionId,
    mcpServers: opts.mcpServers,
    allowedTools: opts.allowedTools,
    systemPrompt: opts.systemPrompt,
  };

  try {
    let result: Extract<SDKMessage, { type: 'result' }> | undefined;
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'result') result = msg;
    }
    if (!result) {
      throw new Error('agent run produced no result message');
    }
    const text = result.subtype === 'success' ? result.result.trim() : '';
    if (result.is_error || !text) {
      const detail =
        result.subtype !== 'success' && result.errors?.length
          ? result.errors.join('; ').slice(0, 500)
          : text.slice(0, 500) || '(empty result)';
      throw new Error(`agent run failed (${result.subtype}): ${detail}`);
    }
    return { text, meta: extractMeta(result) };
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error(`agent run timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Back-compat string-returning wrapper. */
export async function runClaude(
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const { text } = await runClaudeWithMeta(prompt, { timeoutMs });
  return text;
}

function extractMeta(res: Extract<SDKMessage, { type: 'result' }>): ClaudeRunMeta {
  // modelUsage is keyed by model id and includes Claude Code's internal
  // helper model (haiku) alongside the main one. Pick the entry that cost
  // the most: that's the model that actually generated the result.
  let model: string | null = null;
  let bestCost = -1;
  for (const [id, u] of Object.entries(res.modelUsage ?? {})) {
    if (u.costUSD > bestCost) {
      bestCost = u.costUSD;
      model = u.canonicalModel ?? id;
    }
  }
  return {
    sessionId: res.session_id ?? null,
    model: model ?? CLAUDE_MODEL ?? null,
    costUsd: res.total_cost_usd ?? null,
    durationMs: res.duration_ms ?? null,
    apiDurationMs: res.duration_api_ms ?? null,
    numTurns: res.num_turns ?? null,
    inputTokens: res.usage?.input_tokens ?? null,
    outputTokens: res.usage?.output_tokens ?? null,
    cacheReadTokens: res.usage?.cache_read_input_tokens ?? null,
    cacheCreationTokens: res.usage?.cache_creation_input_tokens ?? null,
  };
}

/** Strip optional markdown fences and parse the largest JSON object/array. */
export function parseJsonFromClaude<T>(raw: string): T {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1]!.trim();
  // Fall back to the first {...} or [...] span if there's prose around it.
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const start = text.search(/[[{]/);
    if (start >= 0) text = text.slice(start);
  }
  return JSON.parse(text) as T;
}

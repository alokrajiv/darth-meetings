import 'server-only';
import { spawn } from 'node:child_process';

/**
 * Headless Claude Code on this machine. We deliberately shell out to
 * `claude -p` instead of using an API key: the deploy VM has an
 * authenticated Claude Code install, so LLM work rides on the existing
 * subscription with zero key management. Prompts are piped over stdin
 * (no shell-arg length limits, nothing written to disk).
 *
 * Runs use `--output-format json`, which wraps the result text in an
 * envelope carrying cost/token/duration/session metadata — persisted to
 * ai_runs for usage stats. The session_id also makes `claude -p --resume`
 * possible later (incremental "the data changed, update the notes" turns).
 */

const CLAUDE_BIN = process.env.MW_CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.MW_CLAUDE_MODEL || ''; // empty = CLI default
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORT = EFFORT_LEVELS.has(process.env.MW_CLAUDE_EFFORT || '')
  ? (process.env.MW_CLAUDE_EFFORT as string)
  : ''; // empty = CLI default
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

interface ClaudeJsonEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export interface RunClaudeOpts {
  timeoutMs?: number;
  /** Resume an earlier headless session (claude -p --resume <id>). */
  resumeSessionId?: string;
  /** Per-call effort override (low|medium|high|xhigh|max) — beats the env. */
  effort?: string;
}

export function runClaudeWithMeta(
  prompt: string,
  opts: RunClaudeOpts = {}
): Promise<ClaudeRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json'];
    if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
    const effort =
      opts.effort && EFFORT_LEVELS.has(opts.effort) ? opts.effort : CLAUDE_EFFORT;
    if (effort) args.push('--effort', effort);
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

    const child = spawn(CLAUDE_BIN, args, {
      // Run from the storage dir, not the repo — headless mode denies tool
      // permission requests anyway, but don't even tempt it with a codebase.
      cwd: process.env.MW_STORAGE_DIR || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        reject(new Error(`claude -p exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
        return;
      }
      // `--output-format json` emits an ARRAY of events (system init first,
      // the result envelope last) on current Claude Code; older builds
      // emitted the bare result object. Handle both.
      let envelope: ClaudeJsonEnvelope | undefined;
      try {
        const parsed = JSON.parse(stdout) as ClaudeJsonEnvelope | ClaudeJsonEnvelope[];
        envelope = Array.isArray(parsed)
          ? parsed.find((e) => e?.type === 'result')
          : parsed;
      } catch {
        // Envelope parse failure shouldn't lose a successful run — fall
        // back to treating stdout as the result text, meta-less.
        resolve({ text: stdout.trim(), meta: emptyMeta() });
        return;
      }
      if (!envelope) {
        reject(new Error(`claude -p json output had no result envelope: ${stdout.slice(0, 300)}`));
        return;
      }
      const text = (envelope.result ?? '').trim();
      if (envelope.is_error || !text) {
        reject(
          new Error(
            `claude -p returned ${envelope.subtype || 'error'}: ${text.slice(0, 500) || '(empty result)'}`
          )
        );
        return;
      }
      resolve({ text, meta: extractMeta(envelope) });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Back-compat string-returning wrapper. */
export async function runClaude(
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string> {
  const { text } = await runClaudeWithMeta(prompt, { timeoutMs });
  return text;
}

function emptyMeta(): ClaudeRunMeta {
  return {
    sessionId: null,
    model: null,
    costUsd: null,
    durationMs: null,
    apiDurationMs: null,
    numTurns: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  };
}

function extractMeta(env: ClaudeJsonEnvelope): ClaudeRunMeta {
  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
  // The envelope doesn't name the model directly; modelUsage is keyed by
  // model id — and includes Claude Code's internal helper model (haiku)
  // alongside the main one. Pick the entry that cost the most: that's the
  // model that actually generated the result.
  let model: string | null = null;
  if (env.modelUsage) {
    let bestCost = -1;
    for (const [id, v] of Object.entries(env.modelUsage)) {
      const c =
        v && typeof (v as { costUSD?: unknown }).costUSD === 'number'
          ? ((v as { costUSD: number }).costUSD)
          : 0;
      if (c > bestCost) {
        bestCost = c;
        model = id;
      }
    }
  }
  return {
    sessionId: typeof env.session_id === 'string' ? env.session_id : null,
    model: model ?? (CLAUDE_MODEL || null),
    costUsd: num(env.total_cost_usd),
    durationMs: num(env.duration_ms),
    apiDurationMs: num(env.duration_api_ms),
    numTurns: num(env.num_turns),
    inputTokens: num(env.usage?.input_tokens),
    outputTokens: num(env.usage?.output_tokens),
    cacheReadTokens: num(env.usage?.cache_read_input_tokens),
    cacheCreationTokens: num(env.usage?.cache_creation_input_tokens),
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

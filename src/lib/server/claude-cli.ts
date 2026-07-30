import 'server-only';
import { spawn } from 'node:child_process';

/**
 * Headless Claude Code on this machine. We deliberately shell out to
 * `claude -p` instead of using an API key: the deploy VM has an
 * authenticated Claude Code install, so LLM work rides on the existing
 * subscription with zero key management. Prompts are piped over stdin
 * (no shell-arg length limits, nothing written to disk).
 */

const CLAUDE_BIN = process.env.MW_CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.MW_CLAUDE_MODEL || ''; // empty = CLI default
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function runClaude(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text'];
    if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);

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
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude -p exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
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

import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import type { ClaudeRunMeta } from '@/lib/server/claude-cli';

// Stats layer for headless Claude runs (see claude-cli.ts). Every
// `claude -p` invocation records a row here — cost, tokens, duration,
// who triggered it, and the session id for potential --resume follow-ups.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export type AiRunKind = 'auto_notes' | 'import_normalize';

export interface AiRunRow {
  id: number;
  transcript_id: number | null;
  assemblyai_id: string | null;
  kind: AiRunKind;
  triggered_by_user_id: string | null;
  triggered_by_email: string | null;
  model: string | null;
  session_id: string | null;
  status: 'completed' | 'error';
  error: string | null;
  cost_usd: string | null; // numeric comes back as string from postgres.js
  duration_ms: number | null;
  api_duration_ms: number | null;
  num_turns: number | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_creation_tokens: string | null;
  prompt_chars: number | null;
  result_chars: number | null;
  created_at: string;
}

export interface RecordAiRunInput {
  transcriptId?: number | null;
  assemblyaiId?: string | null;
  kind: AiRunKind;
  triggeredBy?: { userId: string; email: string } | null;
  status: 'completed' | 'error';
  error?: string | null;
  meta?: ClaudeRunMeta | null;
  promptChars?: number | null;
  resultChars?: number | null;
}

/**
 * Insert one run row. Best-effort: stats must never tank the actual
 * generation path, so failures are logged and swallowed.
 */
export async function recordAiRun(input: RecordAiRunInput): Promise<void> {
  const m = input.meta;
  try {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.ai_runs (
        transcript_id, assemblyai_id, kind,
        triggered_by_user_id, triggered_by_email,
        model, session_id, status, error,
        cost_usd, duration_ms, api_duration_ms, num_turns,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        prompt_chars, result_chars
      ) VALUES (
        ${input.transcriptId ?? null},
        ${input.assemblyaiId ?? null},
        ${input.kind},
        ${input.triggeredBy?.userId ?? null},
        ${input.triggeredBy?.email?.toLowerCase() ?? null},
        ${m?.model ?? null},
        ${m?.sessionId ?? null},
        ${input.status},
        ${input.error ?? null},
        ${m?.costUsd ?? null},
        ${m?.durationMs ?? null},
        ${m?.apiDurationMs ?? null},
        ${m?.numTurns ?? null},
        ${m?.inputTokens ?? null},
        ${m?.outputTokens ?? null},
        ${m?.cacheReadTokens ?? null},
        ${m?.cacheCreationTokens ?? null},
        ${input.promptChars ?? null},
        ${input.resultChars ?? null}
      )
    `;
  } catch (err) {
    console.warn('[ai-runs] record failed (non-fatal):', err);
  }
}

export interface AiRunTotals {
  runs: number;
  errors: number;
  cost_usd: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
}

/** Runs + lifetime totals for one transcript (newest run first). */
export async function getRunsForTranscript(
  transcriptId: number,
  limit = 20
): Promise<{ runs: AiRunRow[]; totals: AiRunTotals }> {
  const runs = await sql<AiRunRow[]>`
    SELECT * FROM ${sql(SCHEMA)}.ai_runs
    WHERE transcript_id = ${transcriptId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  const totalsRows = await sql<AiRunTotals[]>`
    SELECT
      COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
      SUM(cost_usd)::text AS cost_usd,
      SUM(input_tokens)::text AS input_tokens,
      SUM(output_tokens)::text AS output_tokens,
      SUM(cache_read_tokens)::text AS cache_read_tokens
    FROM ${sql(SCHEMA)}.ai_runs
    WHERE transcript_id = ${transcriptId}
  `;
  return {
    runs,
    totals: totalsRows[0] ?? {
      runs: 0,
      errors: 0,
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
    },
  };
}

/** Latest completed session id for a transcript — the --resume anchor. */
export async function getLatestSessionId(transcriptId: number): Promise<string | null> {
  const rows = await sql<Array<{ session_id: string | null }>>`
    SELECT session_id FROM ${sql(SCHEMA)}.ai_runs
    WHERE transcript_id = ${transcriptId}
      AND status = 'completed'
      AND session_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.session_id ?? null;
}

/** Org-wide aggregate, grouped by model — powers the usage overview. */
export interface AiRunAggregate {
  model: string | null;
  runs: number;
  errors: number;
  cost_usd: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  avg_duration_ms: number | null;
}

export async function getGlobalAggregates(days = 30): Promise<AiRunAggregate[]> {
  return sql<AiRunAggregate[]>`
    SELECT
      model,
      COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
      SUM(cost_usd)::text AS cost_usd,
      SUM(input_tokens)::text AS input_tokens,
      SUM(output_tokens)::text AS output_tokens,
      AVG(duration_ms)::int AS avg_duration_ms
    FROM ${sql(SCHEMA)}.ai_runs
    WHERE created_at > now() - make_interval(days => ${days})
    GROUP BY model
    ORDER BY SUM(cost_usd) DESC NULLS LAST
  `;
}

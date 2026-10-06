import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { probeOwnershipSchema } from '@/db-ops/series-ownership-schema';

/**
 * The auditors (migration 054, docs/curated-series-spec.md §11.3): the people
 * every meeting with an outside party is auto-shared with read-only
 * (lib/auditor-policy.ts, lib/server/auto-share.ts), and the ONE deliberate
 * exception to "a series reaches what its owner can open" — an auditor-owned
 * series reaches every meeting.
 *
 * The table is edited by hand (psql) — there is no UI. Read through
 * `loadAuditors()`, cached ~60 s per process. Server-only: client code never
 * decides who is an auditor, it reads `isAuditor` / permissions from the API.
 *
 * Before 054 the table does not exist → nobody is an auditor (the restrictive
 * answer: no auditor reach, no auditor auto-shares).
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;
const TTL_MS = 60_000;

export interface Auditor {
  /** Lower-cased. */
  email: string;
  name: string;
}

const g = globalThis as unknown as {
  __mwAuditors?: { at: number; list: Auditor[] };
};

export async function loadAuditors(): Promise<Auditor[]> {
  const hit = g.__mwAuditors;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
  const schema = await probeOwnershipSchema();
  if (!schema.auditors) return [];
  const rows = await sql<Auditor[]>`
    SELECT lower(email) AS email, name FROM ${sql(SCHEMA)}.auditors ORDER BY email
  `;
  const list = rows.map((r) => ({ email: r.email.trim().toLowerCase(), name: r.name }));
  g.__mwAuditors = { at: Date.now(), list };
  return list;
}

export async function auditorEmails(): Promise<Set<string>> {
  return new Set((await loadAuditors()).map((a) => a.email));
}

export async function isAuditor(email: string | null | undefined): Promise<boolean> {
  const e = (email ?? '').trim().toLowerCase();
  if (!e) return false;
  return (await auditorEmails()).has(e);
}

export function bustAuditorsCache(): void {
  g.__mwAuditors = undefined;
}

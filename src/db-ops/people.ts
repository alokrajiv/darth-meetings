import 'server-only';
import { plagueisSql } from '@/lib/plagueis-db';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

// Read (and write) layer for the people directory that powers the user
// picker. Two sources:
//   1. darth_plagueis.ppl — the canonical Trames directory, read-only
//   2. meeting_whisperer_prod.people — our own custom additions, read-write
//
// Results from both sources are merged + deduped by lowercased email. A
// match from plagueis wins over a match from our own table for the same
// email — the directory is authoritative.

const MW_SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface Person {
  /** Opaque to the client. ids are NOT unique across sources. */
  id: number;
  name: string;
  email: string | null;
  slackHandle: string | null;
  team: string | null;
  role: string | null;
  /** 'trames' = darth_plagueis.ppl, 'custom' = added via meeting-whisperer. */
  source: 'trames' | 'custom';
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

// ─── search ────────────────────────────────────────────────────────────

async function searchPlagueis(q: string, limit: number): Promise<Person[]> {
  const trimmed = q.trim();
  const pattern = `%${trimmed}%`;

  const rows = trimmed
    ? await plagueisSql<Omit<Person, 'source'>[]>`
        SELECT DISTINCT p.id,
               p.name,
               COALESCE(p.primary_email, (SELECT e.email FROM darth_plagueis.emails e WHERE e.ppl_id = p.id LIMIT 1)) AS email,
               p.slack_handle AS "slackHandle",
               p.team,
               p.role
        FROM darth_plagueis.ppl p
        LEFT JOIN darth_plagueis.emails e ON e.ppl_id = p.id
        WHERE NOT p.is_bot
          AND (
            p.name ILIKE ${pattern}
            OR p.slack_handle ILIKE ${pattern}
            OR p.primary_email ILIKE ${pattern}
            OR e.email ILIKE ${pattern}
          )
        ORDER BY p.name
        LIMIT ${limit}
      `
    : await plagueisSql<Omit<Person, 'source'>[]>`
        SELECT p.id,
               p.name,
               COALESCE(p.primary_email, (SELECT e.email FROM darth_plagueis.emails e WHERE e.ppl_id = p.id LIMIT 1)) AS email,
               p.slack_handle AS "slackHandle",
               p.team,
               p.role
        FROM darth_plagueis.ppl p
        WHERE NOT p.is_bot
        ORDER BY p.name
        LIMIT ${limit}
      `;

  return rows.map((r) => ({ ...r, source: 'trames' as const }));
}

async function searchCustomPeople(q: string, limit: number): Promise<Person[]> {
  const trimmed = q.trim();
  const pattern = `%${trimmed}%`;

  const rows = trimmed
    ? await sql<Array<{ id: number; name: string; email: string }>>`
        SELECT id, name, email
        FROM ${sql(MW_SCHEMA)}.people
        WHERE name ILIKE ${pattern} OR email ILIKE ${pattern}
        ORDER BY name
        LIMIT ${limit}
      `
    : await sql<Array<{ id: number; name: string; email: string }>>`
        SELECT id, name, email
        FROM ${sql(MW_SCHEMA)}.people
        ORDER BY name
        LIMIT ${limit}
      `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    slackHandle: null,
    team: null,
    role: null,
    source: 'custom' as const,
  }));
}

/**
 * Find people whose name/handle/email contains the query. Queries both
 * the Trames directory and our own custom people table, merges, dedupes
 * by lowercased email (plagueis wins), and returns up to `limit` hits.
 */
export async function searchPeople(q: string, limit = 20): Promise<Person[]> {
  const [plagueis, custom] = await Promise.all([
    searchPlagueis(q, limit),
    searchCustomPeople(q, limit),
  ]);

  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of [...plagueis, ...custom]) {
    const key = p.email ? norm(p.email) : `id:${p.source}:${p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

// ─── findByEmail ────────────────────────────────────────────────────────

/**
 * Look up a single person by email across both directories. Plagueis is
 * checked first — its records are authoritative. Returns null if nothing
 * matches.
 */
export async function findPersonByEmail(email: string): Promise<Person | null> {
  const e = norm(email);

  const plagueisRows = await plagueisSql<Omit<Person, 'source'>[]>`
    SELECT p.id,
           p.name,
           COALESCE(p.primary_email, ${e}) AS email,
           p.slack_handle AS "slackHandle",
           p.team,
           p.role
    FROM darth_plagueis.ppl p
    LEFT JOIN darth_plagueis.emails pe ON pe.ppl_id = p.id
    WHERE LOWER(p.primary_email) = ${e} OR LOWER(pe.email) = ${e}
    LIMIT 1
  `;
  if (plagueisRows[0]) return { ...plagueisRows[0], source: 'trames' };

  const ownRows = await sql<Array<{ id: number; name: string; email: string }>>`
    SELECT id, name, email
    FROM ${sql(MW_SCHEMA)}.people
    WHERE LOWER(email) = ${e}
    LIMIT 1
  `;
  if (ownRows[0]) {
    return {
      id: ownRows[0].id,
      name: ownRows[0].name,
      email: ownRows[0].email,
      slackHandle: null,
      team: null,
      role: null,
      source: 'custom',
    };
  }

  return null;
}

// ─── createCustomPerson ─────────────────────────────────────────────────

export interface CreateCustomPersonInput {
  name: string;
  email: string;
  createdBy: string;
}

export async function createCustomPerson(input: CreateCustomPersonInput): Promise<Person> {
  const rows = await sql<Array<{ id: number; name: string; email: string }>>`
    INSERT INTO ${sql(MW_SCHEMA)}.people (name, email, created_by)
    VALUES (${input.name.trim()}, ${norm(input.email)}, ${input.createdBy})
    RETURNING id, name, email
  `;
  const r = rows[0]!;
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    slackHandle: null,
    team: null,
    role: null,
    source: 'custom',
  };
}

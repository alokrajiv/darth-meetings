import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { archiveFilterSql } from '@/db-ops/meeting-filter-sql';
import { EMPTY_MEETING_FILTERS, type MeetingFilters } from '@/lib/server/meeting-filters';

// Deep search across everything we hold for a transcript: title, filename,
// description, the AI summary, and the full transcript text (cached in
// imported_content). Same visibility rules as the listing (trashed and
// temporary/scratch rows excluded). Snippets are cut in SQL so we never ship
// megabytes of transcript text to the client.

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export interface TranscriptSearchHit {
  assemblyai_id: string;
  matched_in: 'title' | 'filename' | 'description' | 'notes' | 'content';
  snippet: string | null;
}

export async function searchVisibleTranscripts(
  userId: string,
  email: string,
  query: string,
  limit = 50,
  /** Shared people/provider filters (lib/server/meeting-filters) ANDed onto
   * the text match; its own `q` is ignored — `query` is the search text. */
  filters: MeetingFilters = EMPTY_MEETING_FILTERS
): Promise<TranscriptSearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const normEmail = email.trim().toLowerCase();
  const pattern = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;

  return sql<TranscriptSearchHit[]>`
    SELECT assemblyai_id, matched_in, snippet FROM (
      SELECT
        t.assemblyai_id,
        t.created_at,
        CASE
          WHEN t.title ILIKE ${pattern} THEN 'title'
          WHEN t.original_filename ILIKE ${pattern} THEN 'filename'
          WHEN t.description ILIKE ${pattern} THEN 'description'
          WHEN t.auto_notes ILIKE ${pattern} THEN 'notes'
          ELSE 'content'
        END AS matched_in,
        CASE
          WHEN t.title ILIKE ${pattern} OR t.original_filename ILIKE ${pattern} THEN NULL
          WHEN t.description ILIKE ${pattern} THEN
            substring(t.description FROM greatest(position(lower(${q}) IN lower(t.description)) - 40, 1) FOR 140)
          WHEN t.auto_notes ILIKE ${pattern} THEN
            substring(t.auto_notes FROM greatest(position(lower(${q}) IN lower(t.auto_notes)) - 40, 1) FOR 140)
          ELSE
            substring(t.imported_content->>'text' FROM greatest(position(lower(${q}) IN lower(t.imported_content->>'text')) - 40, 1) FOR 140)
        END AS snippet
      FROM ${sql(SCHEMA)}.transcripts t
      LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
        ON s.transcript_id = t.id
       AND s.shared_with_email = ${normEmail}
      WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
        AND t.deleted_at IS NULL
        AND NOT t.scratch
        AND (
          t.title ILIKE ${pattern}
          OR t.original_filename ILIKE ${pattern}
          OR t.description ILIKE ${pattern}
          OR t.auto_notes ILIKE ${pattern}
          OR t.imported_content->>'text' ILIKE ${pattern}
        )
        ${archiveFilterSql(filters)}
    ) hits
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/** Thrown for user-fixable regex problems (bad pattern, timeout) → HTTP 400. */
export class RegexSearchError extends Error {
  constructor(
    message: string,
    public readonly kind: 'invalid' | 'timeout'
  ) {
    super(message);
  }
}

const MAX_REGEX_LEN = 200;

/**
 * Regex deep search (T5): same five fields, same visibility rules and hit
 * shape as searchVisibleTranscripts, but the query is a POSIX regex matched
 * case-insensitively (`~*`). Guards: pattern length cap + a 5s LOCAL
 * statement_timeout (PG's regex engine is not catastrophic-backtracking-safe
 * in general). Snippet = first match with ±40 chars of context, cut in SQL.
 */
export async function regexSearchVisibleTranscripts(
  userId: string,
  email: string,
  pattern: string,
  limit = 50,
  filters: MeetingFilters = EMPTY_MEETING_FILTERS
): Promise<TranscriptSearchHit[]> {
  const re = pattern.trim();
  if (re.length < 2) return [];
  if (re.length > MAX_REGEX_LEN) {
    throw new RegexSearchError(`pattern too long (max ${MAX_REGEX_LEN} chars)`, 'invalid');
  }
  const normEmail = email.trim().toLowerCase();
  // First match + context, case-insensitively. The user pattern is wrapped in
  // a non-capturing group so the OUTER capture stays the first group even
  // when the pattern contains its own parens; substring() returns capture 1.
  //
  // The wrapping can make an otherwise-valid pattern ILLEGAL as a snippet
  // regex — PG only allows embedded options like (?i) at the very start of
  // an RE, and the added groups renumber backreferences (review finding). So
  // when the wrapped form doesn't compile but the raw pattern does, run the
  // search with NULL snippets instead of failing the whole request.
  const snip = `(.{0,40}(?:${re}).{0,40})`;
  const run = (withSnippets: boolean) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      return tx<TranscriptSearchHit[]>`
        SELECT assemblyai_id, matched_in, snippet FROM (
          SELECT
            t.assemblyai_id,
            t.created_at,
            CASE
              WHEN t.title ~* ${re} THEN 'title'
              WHEN t.original_filename ~* ${re} THEN 'filename'
              WHEN t.description ~* ${re} THEN 'description'
              WHEN t.auto_notes ~* ${re} THEN 'notes'
              ELSE 'content'
            END AS matched_in,
            CASE
              WHEN NOT ${withSnippets} THEN NULL
              WHEN t.title ~* ${re} OR t.original_filename ~* ${re} THEN NULL
              WHEN t.description ~* ${re} THEN substring(t.description FROM ('(?i)' || ${snip}))
              WHEN t.auto_notes ~* ${re} THEN substring(t.auto_notes FROM ('(?i)' || ${snip}))
              ELSE substring(t.imported_content->>'text' FROM ('(?i)' || ${snip}))
            END AS snippet
          FROM ${sql(SCHEMA)}.transcripts t
          LEFT JOIN ${sql(SCHEMA)}.transcript_shares s
            ON s.transcript_id = t.id
           AND s.shared_with_email = ${normEmail}
          WHERE (t.user_id = ${userId} OR s.id IS NOT NULL)
            AND t.deleted_at IS NULL
        AND NOT t.scratch
            AND (
              t.title ~* ${re}
              OR t.original_filename ~* ${re}
              OR t.description ~* ${re}
              OR t.auto_notes ~* ${re}
              OR t.imported_content->>'text' ~* ${re}
            )
            ${archiveFilterSql(filters)}
        ) hits
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    });
  try {
    // Probe whether the WRAPPED snippet form compiles; the raw pattern is
    // exercised by the search itself (bad raw pattern → 400 below either way).
    let snippetsOk = true;
    try {
      await sql`SELECT '' ~ ('(?i)' || ${snip})`;
    } catch {
      snippetsOk = false;
    }
    return await run(snippetsOk);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '2201B' || code === '22025' || code === '22P02') {
      throw new RegexSearchError(
        `invalid regex: ${(err as Error).message}`,
        'invalid'
      );
    }
    if (code === '57014') {
      throw new RegexSearchError(
        'regex search timed out after 5s — narrow the pattern or add filters',
        'timeout'
      );
    }
    throw err;
  }
}

import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';
import { archiveFilterSql } from '@/db-ops/meeting-filter-sql';
import { EMPTY_MEETING_FILTERS, type MeetingFilters } from '@/lib/server/meeting-filters';

// Deep search across everything we hold for a transcript: title, filename,
// description, the AI summary, and the full transcript text (cached in
// imported_content). Same visibility rules as the listing. Snippets are cut
// in SQL so we never ship megabytes of transcript text to the client.

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

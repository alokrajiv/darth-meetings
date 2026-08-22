import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/**
 * Ledger of transcript Docs Google produced for meetings with no captured
 * speech (Transcript tab = just "Transcription ended after HH:MM:SS"). See
 * migrations/025. The series sweep reads it to stop offering such Docs as
 * importable; the import writes it the moment it finds one.
 */
export async function noteEmptyTranscriptDoc(input: {
  docId: string;
  meetingCode?: string | null;
  eventId?: string | null;
  occStart?: string | null;
  title?: string | null;
  endedAfter?: string | null;
  notedBy?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO ${sql(SCHEMA)}.empty_transcript_docs
      (doc_id, meeting_code, event_id, occ_start, title, ended_after, noted_by)
    VALUES (${input.docId}, ${input.meetingCode ?? null}, ${input.eventId ?? null},
            ${input.occStart ?? null}, ${input.title ?? null}, ${input.endedAfter ?? null},
            ${input.notedBy ?? null})
    ON CONFLICT (doc_id) DO UPDATE
      SET ended_after = COALESCE(EXCLUDED.ended_after, ${sql(SCHEMA)}.empty_transcript_docs.ended_after),
          noted_at = now()
  `;
}

/** Which of these Doc ids are known-empty. */
export async function listEmptyTranscriptDocIds(docIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(docIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await sql<Array<{ doc_id: string }>>`
    SELECT doc_id FROM ${sql(SCHEMA)}.empty_transcript_docs WHERE doc_id = ANY(${ids})
  `;
  return new Set(rows.map((r) => r.doc_id));
}

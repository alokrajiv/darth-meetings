import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Lookups for the readers of stored media once Stage D can remove the local
 * copies (docs/recordings-stage-d-spec.md "As built — readers"). A file that
 * is not on this disk is no longer evidence of anything: the DATABASE says
 * whether a file still belongs to a meeting, and whether its bytes are held in
 * the archive.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

/** `<stem>.<ext>` → `<stem>`, the same rule as `recording-graph.ts` (a bound parameter). */
const STEM_RE = String.raw`\.[^./]+$`;

/**
 * INTERNAL-ONLY — of `stems`, the ones some source file still answers to: a
 * `recording_media` canonical/part row, a `transcripts.local_audio_path`, or a
 * `gmeet_context.videoParts[].filename`. Trashed meetings and trashed
 * recordings count (both can be restored; their permanent purge removes the
 * row, and only then is a derivative an orphan).
 *
 * One pass over each source per call — the media sweeper asks this with every
 * evicted recording's stem on every tick, so a per-stem subquery would not do.
 */
export async function stemsStillNamed(stems: string[]): Promise<Set<string>> {
  if (stems.length === 0) return new Set();
  const rows = await sql<Array<{ stem: string }>>`
    SELECT DISTINCT stem FROM (
      SELECT regexp_replace(m.filename, ${STEM_RE}, '') AS stem
      FROM ${sql(SCHEMA)}.recording_media m
      WHERE m.kind IN ('canonical', 'part') AND m.filename IS NOT NULL
      UNION ALL
      SELECT regexp_replace(t.local_audio_path, ${STEM_RE}, '') AS stem
      FROM ${sql(SCHEMA)}.transcripts t
      WHERE t.local_audio_path IS NOT NULL
      UNION ALL
      SELECT regexp_replace(p->>'filename', ${STEM_RE}, '') AS stem
      FROM ${sql(SCHEMA)}.transcripts t
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(t.gmeet_context->'videoParts') = 'array'
          THEN t.gmeet_context->'videoParts' ELSE '[]'::jsonb END
      ) p
      WHERE p->>'filename' IS NOT NULL
    ) named
    WHERE stem = ANY(${stems}::text[])
  `;
  return new Set(rows.map((r) => r.stem));
}

export interface ArchivedStoredFile {
  filename: string;
  kind: string;
  recording_id: string;
  blob_name: string;
  sha256: string;
  bytes: number | null;
  has_video: boolean | null;
}

/**
 * INTERNAL-ONLY — the canonical/part rows naming these stored files whose
 * bytes are in the archive (`blob_name` AND `sha256`: what `stampMediaArchived`
 * writes once Azure has confirmed them — `aai-retention.ts mediaIsSafe`'s
 * definition of "we hold the media"). Keyed by filename.
 */
export async function archivedStoredFiles(
  filenames: string[]
): Promise<Map<string, ArchivedStoredFile>> {
  if (filenames.length === 0) return new Map();
  const rows = await sql<ArchivedStoredFile[]>`
    SELECT filename, kind, recording_id, blob_name, sha256,
           bytes::float8 AS bytes, has_video
    FROM ${sql(SCHEMA)}.recording_media
    WHERE kind IN ('canonical', 'part')
      AND filename = ANY(${filenames}::text[])
      AND blob_name IS NOT NULL
      AND sha256 IS NOT NULL
  `;
  const out = new Map<string, ArchivedStoredFile>();
  for (const r of rows) if (!out.has(r.filename)) out.set(r.filename, r);
  return out;
}

/**
 * INTERNAL-ONLY — a recording's ARCHIVED `audio_only` rows (the dual-write's
 * file probe, `recording-sync.ts probeFiles`): an extract whose local copy is
 * gone but whose blob is the copy must stay described.
 */
export async function archivedAudioOnlyRows(
  recordingId: string
): Promise<Array<{ kind: string; filename: string | null; blob_name: string | null; bytes: number | null }>> {
  return sql`
    SELECT kind, filename, blob_name, bytes::float8 AS bytes
    FROM ${sql(SCHEMA)}.recording_media
    WHERE recording_id = ${recordingId}::uuid
      AND kind = 'audio_only'
      AND blob_name IS NOT NULL
  `;
}

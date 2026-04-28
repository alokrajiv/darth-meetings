import 'server-only';
import { sql } from '@/lib/db';
import { plagueisSql } from '@/lib/plagueis-db';
import { SCHEMAS } from '@/lib/constants/database';

// Activity logging for transcripts — the "who edited / who viewed" feed
// rendered at the top of the detail page (Notion / Google Docs style).
//
// Action vocabulary (kept small and stable; UI maps these to verbs/icons):
//   view              — user opened the detail page
//   edit_text         — single utterance text edit (PATCH /edits)
//   find_replace      — bulk text edit via find-and-replace (PUT /edits)
//   edit_speakers     — speaker labels rename / description change
//   edit_meta         — title / description change
//   share_add         — collaborator added
//   share_update      — collaborator's access level changed
//   share_remove      — collaborator removed

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

const VIEW_THROTTLE_MS = 10 * 60 * 1000;

export type ActivityAction =
  | 'view'
  | 'edit_text'
  | 'find_replace'
  | 'edit_speakers'
  | 'edit_meta'
  | 'share_add'
  | 'share_update'
  | 'share_remove';

export interface ActivityRow {
  id: number;
  transcript_id: number;
  user_id: string;
  user_email: string;
  user_name: string | null;
  action: ActivityAction;
  details: Record<string, unknown> | null;
  at: string;
}

interface LogActivityInput {
  transcriptId: number;
  userId: string;
  email: string;
  action: ActivityAction;
  details?: Record<string, unknown>;
}

/**
 * Best-effort display name for an SSO user. We check the Trames directory
 * (darth_plagueis.ppl) by primary or alias email, then fall back to our
 * own meeting_whisperer_prod.people table. Returns null if nothing matches —
 * the caller is expected to fall back to the email's local-part for display.
 */
async function resolveDisplayName(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();

  try {
    const rows = await plagueisSql<Array<{ name: string }>>`
      SELECT p.name FROM darth_plagueis.ppl p
      LEFT JOIN darth_plagueis.emails pe ON pe.ppl_id = p.id
      WHERE LOWER(p.primary_email) = ${e} OR LOWER(pe.email) = ${e}
      LIMIT 1
    `;
    if (rows[0]?.name) return rows[0].name;
  } catch {
    // plagueis read failure shouldn't block activity logging
  }

  try {
    const rows = await sql<Array<{ name: string }>>`
      SELECT name FROM ${sql(SCHEMA)}.people
      WHERE LOWER(email) = ${e}
      LIMIT 1
    `;
    if (rows[0]?.name) return rows[0].name;
  } catch {
    // own table read failure same — non-fatal
  }

  return null;
}

/**
 * Insert an activity row. View actions are throttled per (user, transcript)
 * to once every 10 minutes — without this, every page reload would log a
 * fresh view and the timeline would be useless.
 *
 * Failures are swallowed and logged. Activity is observability, not
 * load-bearing — never let it tank a real request.
 */
export async function logActivity(input: LogActivityInput): Promise<void> {
  try {
    if (input.action === 'view') {
      const recent = await sql<Array<{ at: string }>>`
        SELECT at FROM ${sql(SCHEMA)}.transcript_activity
        WHERE transcript_id = ${input.transcriptId}
          AND user_id = ${input.userId}
          AND action = 'view'
        ORDER BY at DESC
        LIMIT 1
      `;
      if (recent[0]) {
        const last = new Date(recent[0].at).getTime();
        if (Date.now() - last < VIEW_THROTTLE_MS) return;
      }
    }

    const userName = await resolveDisplayName(input.email);

    await sql`
      INSERT INTO ${sql(SCHEMA)}.transcript_activity (
        transcript_id, user_id, user_email, user_name, action, details
      ) VALUES (
        ${input.transcriptId},
        ${input.userId},
        ${input.email.toLowerCase()},
        ${userName},
        ${input.action},
        ${input.details ? sql.json(input.details as unknown as never) : null}
      )
    `;
  } catch (err) {
    console.warn('[activity] log failed', input.action, err);
  }
}

export interface ActivityViewer {
  user_id: string;
  user_email: string;
  user_name: string | null;
  last_viewed_at: string;
}

export interface ActivitySummary {
  events: ActivityRow[];
  lastEdit: ActivityRow | null;
  recentViewers: ActivityViewer[];
}

const EDIT_ACTIONS = [
  'edit_text',
  'find_replace',
  'edit_speakers',
  'edit_meta',
  'share_add',
  'share_update',
  'share_remove',
] as const;

/**
 * Bundle for the ActivityBar / ActivityDialog. One round-trip to the DB
 * gets the recent timeline, the most recent edit, and the unique recent
 * viewers (deduped to the latest view per user, capped to 20).
 */
export async function getActivitySummary(
  transcriptId: number,
  limit = 50
): Promise<ActivitySummary> {
  const events = await sql<ActivityRow[]>`
    SELECT id, transcript_id, user_id, user_email, user_name, action, details, at
    FROM ${sql(SCHEMA)}.transcript_activity
    WHERE transcript_id = ${transcriptId}
    ORDER BY at DESC
    LIMIT ${limit}
  `;

  const lastEditRows = await sql<ActivityRow[]>`
    SELECT id, transcript_id, user_id, user_email, user_name, action, details, at
    FROM ${sql(SCHEMA)}.transcript_activity
    WHERE transcript_id = ${transcriptId}
      AND action = ANY(${EDIT_ACTIONS as unknown as string[]})
    ORDER BY at DESC
    LIMIT 1
  `;

  const viewers = await sql<ActivityViewer[]>`
    SELECT DISTINCT ON (user_id)
      user_id,
      user_email,
      user_name,
      at AS last_viewed_at
    FROM ${sql(SCHEMA)}.transcript_activity
    WHERE transcript_id = ${transcriptId}
      AND action = 'view'
      AND at > now() - interval '30 days'
    ORDER BY user_id, at DESC
    LIMIT 50
  `;

  // The DISTINCT ON above orders within each user — we need a separate
  // pass to get the "most recently active viewer first" ordering.
  viewers.sort((a, b) => new Date(b.last_viewed_at).getTime() - new Date(a.last_viewed_at).getTime());
  const trimmed = viewers.slice(0, 20);

  return {
    events,
    lastEdit: lastEditRows[0] ?? null,
    recentViewers: trimmed,
  };
}

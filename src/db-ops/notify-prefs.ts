import 'server-only';
import { sql } from '@/lib/db';
import { SCHEMAS } from '@/lib/constants/database';

/**
 * Per-user Slack DM notification preferences (opt-out model: absent row or
 * absent key = enabled). Keyed by EMAIL — share recipients may never have
 * signed in, and every DM targets an email anyway.
 */

const SCHEMA = SCHEMAS.MEETING_WHISPERER;

export const NOTIFY_KINDS = [
  'share',
  'transcript_ready',
  'auto_import',
  'report_ready',
  'needs_review',
  'deferred_import',
  'sync_request',
  'resume',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** UI copy for the settings page — kept here so server + client agree. */
export const NOTIFY_KIND_LABELS: Record<NotifyKind, { label: string; hint: string }> = {
  share: {
    label: 'Meeting shared with me',
    hint: 'Someone deliberately shares a meeting with you.',
  },
  transcript_ready: {
    label: 'My upload / import finished transcribing',
    hint: 'A file you uploaded or a meeting you imported by hand is ready for speaker review — safe to close the tab meanwhile.',
  },
  auto_import: {
    label: 'Auto-import / auto-sync fired',
    hint: 'A series you auto-import, or your account auto-sync, picked up a new meeting.',
  },
  report_ready: {
    label: 'Summary / report ready',
    hint: 'An unattended summary or report finished generating.',
  },
  needs_review: {
    label: 'Speaker review needed',
    hint: 'An auto-imported meeting is waiting on speaker name review.',
  },
  deferred_import: {
    label: 'Queued import landed',
    hint: 'An import that waited on Google/Microsoft finished (or failed for good).',
  },
  sync_request: {
    label: 'Colleagues need your import',
    hint: 'Auto-sync wanted a meeting only your Google account can reach — one nudge per meeting.',
  },
  resume: {
    label: 'Meeting resumed after a break',
    hint: 'An imported call restarted later (new Meet session) — its extra recording attaches by itself.',
  },
};

export type NotifyPrefs = Record<NotifyKind, boolean>;

function withDefaults(raw: Record<string, unknown> | null | undefined): NotifyPrefs {
  const out = {} as NotifyPrefs;
  for (const k of NOTIFY_KINDS) out[k] = raw?.[k] !== false;
  return out;
}

export async function getNotifyPrefs(email: string): Promise<NotifyPrefs> {
  const [row] = await sql<Array<{ prefs: Record<string, unknown> }>>`
    SELECT prefs FROM ${sql(SCHEMA)}.notify_prefs WHERE email = ${email.toLowerCase()}
  `;
  return withDefaults(row?.prefs);
}

export async function isNotifyKindEnabled(email: string, kind: NotifyKind): Promise<boolean> {
  try {
    return (await getNotifyPrefs(email))[kind];
  } catch (err) {
    // Preference lookup must never block a notification decision loudly —
    // fail open (default = enabled) like an absent row.
    console.warn('[notify-prefs] lookup failed, defaulting to enabled:', err);
    return true;
  }
}

export async function setNotifyPrefs(
  email: string,
  patch: Partial<NotifyPrefs>
): Promise<NotifyPrefs> {
  const clean: Record<string, boolean> = {};
  for (const k of NOTIFY_KINDS) {
    if (typeof patch[k] === 'boolean') clean[k] = patch[k]!;
  }
  const [row] = await sql<Array<{ prefs: Record<string, unknown> }>>`
    INSERT INTO ${sql(SCHEMA)}.notify_prefs (email, prefs)
    VALUES (${email.toLowerCase()}, ${sql.json(clean as unknown as never)})
    ON CONFLICT (email) DO UPDATE SET
      prefs = ${sql(SCHEMA)}.notify_prefs.prefs || EXCLUDED.prefs,
      updated_at = now()
    RETURNING prefs
  `;
  return withDefaults(row?.prefs);
}

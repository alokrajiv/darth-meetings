import type { MeetingSummaryState } from '@/lib/server/meeting-filters';

/**
 * The listing row's SUMMARY badge and its one action (2026-10-27).
 *
 * A row said nothing about notes: a meeting that never got a summary looked
 * the same as one that had. Each archive row now derives ONE state, shows at
 * most one small badge and at most one action — and the action never opens a
 * dialog of its own: it navigates to the meeting with a `?do=` intent and the
 * detail page opens its EXISTING dialog (`readDoIntent` → `openGenerateDialog`
 * / `setReviewOpen`), then strips the param so a reload does not reopen it.
 *
 * Pure: the table hands it the v2 listing row (`has_notes` and
 * `speaker_id_status` come from `listPagedForUser`; the notes TEXT is never in
 * a listing) and whether the viewer may act.
 *
 * The `summary=missing|failed` FILTER (`archiveSummaryExpr` in
 * db-ops/meeting-filter-sql.ts) is deliberately NOT an exact twin of the
 * badge: `missing` matches every completed row without notes and without a
 * run in flight or failed — including one whose speaker pass is still
 * running (badge: "Identifying speakers…") and an auto-imported row that is
 * gated (badge: none, the amber "Review speakers" chip already says it).
 * Both do lack a summary, which is what the filter asks.
 */

export type SummaryState = 'running' | 'speakers' | 'failed' | 'missing';
export type SummaryIntent = 'generate' | 'review';

export interface SummaryRowInput {
  status: string;
  deleted_at?: string | null;
  auto_notes_status: string | null;
  speaker_id_status?: string | null;
  /** Undefined on rows older than the field (an offline replica synced
   * before it existed, the legacy listing): then nothing is claimed. */
  has_notes?: boolean | null;
  /** The automatic-review outcome of an auto-imported row. 'gated' already
   * renders its own amber "Review speakers" chip, so no summary badge joins
   * it — one signal per row. */
  auto_state?: 'passed' | 'gated' | 'auto' | null;
  /** When the summary will be written automatically (lib/auto-proceed.ts),
   * or null. A `missing` row that carries it reads "Summary at HH:MM". */
  auto_proceed_at?: string | null;
}

export interface SummaryAction {
  label: string;
  intent: SummaryIntent;
}

export interface SummaryBadge {
  state: SummaryState;
  label: string;
  /** Null for viewers and for states nobody can act on. */
  action: SummaryAction | null;
  /** `missing` only: the automatic start, when one is scheduled. */
  autoProceedAt: string | null;
}

export const SUMMARY_BADGE_LABEL: Record<SummaryState, string> = {
  running: 'Writing summary…',
  speakers: 'Identifying speakers…',
  failed: 'Summary failed',
  missing: 'No summary yet',
};

/** What an owner / editor may do about each state. */
export const SUMMARY_ACTION: Record<SummaryState, SummaryAction | null> = {
  running: null,
  speakers: { label: 'Review speakers', intent: 'review' },
  failed: { label: 'Retry', intent: 'generate' },
  missing: { label: 'Generate', intent: 'generate' },
};

/** Chip / toggle text of the `summary=` filter values. */
export const SUMMARY_FILTER_LABEL: Record<MeetingSummaryState, string> = {
  missing: 'No summary yet',
  failed: 'Summary failed',
};

/**
 * One state per row, first true condition wins; null = no badge (the row
 * has notes, is not a completed archive row, is trashed, is gated by the
 * automatic review — that chip speaks for it — or the listing did not say
 * whether notes exist). Rows still transcribing keep their existing status
 * UI, so they are null here too.
 */
export function summaryStateOf(row: SummaryRowInput): SummaryState | null {
  if (row.status !== 'completed' || row.deleted_at) return null;
  if (row.auto_state === 'gated') return null;
  if (row.auto_notes_status === 'running') return 'running';
  if (row.speaker_id_status === 'running') return 'speakers';
  if (row.auto_notes_status === 'error') return 'failed';
  if (row.has_notes === false) return 'missing';
  return null;
}

/** The badge and (for owners / editors) its action, or null for no badge. */
export function summaryBadgeFor(row: SummaryRowInput, canEdit: boolean): SummaryBadge | null {
  const state = summaryStateOf(row);
  if (!state) return null;
  return {
    state,
    label: SUMMARY_BADGE_LABEL[state],
    action: canEdit ? SUMMARY_ACTION[state] : null,
    autoProceedAt: state === 'missing' ? (row.auto_proceed_at ?? null) : null,
  };
}

/** HH:MM in the viewer's local time. */
export function clockOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The chip's text: the state's label, except a `missing` row with an
 * automatic start scheduled, which says when ("Summary at 10:42"). The
 * action stays Generate — a person may still go first.
 */
export function summaryBadgeText(badge: SummaryBadge, clock: (iso: string) => string = clockOf): string {
  if (badge.state === 'missing' && badge.autoProceedAt) return `Summary at ${clock(badge.autoProceedAt)}`;
  return badge.label;
}

/** "Name <email>" when the person is known, else the name. */
export function personLabel(name: string, email?: string | null): string {
  const n = name.trim();
  return email ? `${n} <${email}>` : n;
}

/**
 * The detail page's line under "No notes yet" while an automatic start is
 * scheduled. With `people` (what the pass would apply — the client runs the
 * same pure evaluator over the loaded suggestions) it says WHO, as people
 * where the identity is known, so nothing lands unseen when the grace ends.
 */
export function autoProceedLine(
  autoProceedAt: string,
  clock: (iso: string) => string = clockOf,
  people: ReadonlyArray<{ name: string; email?: string | null }> = []
): string {
  const who = people.map((p) => personLabel(p.name, p.email)).filter(Boolean);
  return who.length > 0
    ? `Summary starts automatically at ${clock(autoProceedAt)} naming ${who.join(', ')}.`
    : `Summary starts automatically at ${clock(autoProceedAt)} with the suggested names.`;
}

/** Where the action navigates: the meeting, carrying the intent. */
export function transcriptIntentHref(assemblyaiId: string, intent: SummaryIntent): string {
  return `/transcript/${encodeURIComponent(assemblyaiId)}?do=${intent}`;
}

/** The `do` intent of a detail-page URL's search string, or null. */
export function readDoIntent(search: string): SummaryIntent | null {
  const v = new URLSearchParams(search).get('do');
  return v === 'generate' || v === 'review' ? v : null;
}

/**
 * Which dialog the page opens for an intent: `generate` with unconfirmed
 * speakers opens the review first — the same rule as the page's own "No
 * notes yet" button (confirmed names go into the writing).
 */
export function resolveDoIntent(intent: SummaryIntent, unconfirmedSpeakers: number): SummaryIntent {
  if (intent === 'generate' && unconfirmedSpeakers > 0) return 'review';
  return intent;
}

/** The same URL without its `do` param (what `history.replaceState` gets). */
export function withoutDoParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('do');
  return url.toString();
}

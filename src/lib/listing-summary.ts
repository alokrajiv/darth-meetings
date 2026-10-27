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
 * a listing) and whether the viewer may act. `archiveSummaryExpr` in
 * db-ops/meeting-filter-sql.ts is the SQL twin of `summaryStateOf` for the
 * `summary=missing|failed` filter.
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
 * has notes, is not a completed archive row, is trashed, or the listing did
 * not say whether notes exist). Rows still transcribing keep their existing
 * status UI, so they are null here too.
 */
export function summaryStateOf(row: SummaryRowInput): SummaryState | null {
  if (row.status !== 'completed' || row.deleted_at) return null;
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
  };
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

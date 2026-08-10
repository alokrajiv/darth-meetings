/**
 * Evidence-key extraction for recurring-call series.
 *
 * A series is identified by an accumulating bag of keys, not any single
 * provider id — gcal re-slices recurringEventIds on "this and following"
 * edits (`…_R20260217T050000`), meeting codes get recycled, and a Teams
 * meeting created from gcal carries BOTH a gcal id and a Graph meeting id.
 *
 * Shared client + server: no server-only imports here.
 */
import type { GmeetContext } from '@/lib/format';

export type SeriesKeyKind =
  | 'recurring-base-id'
  | 'ical-uid-base'
  | 'graph-meeting-id'
  | 'teams-join-url'
  | 'meeting-code'
  | 'normalized-title';

export interface SeriesKeyInput {
  kind: SeriesKeyKind;
  value: string;
}

/** Strong keys attach automatically; weak keys only ever produce a
 * "looks like part of X — confirm?" suggestion. */
export const STRONG_KINDS: ReadonlySet<SeriesKeyKind> = new Set([
  'recurring-base-id',
  'ical-uid-base',
  'graph-meeting-id',
  'teams-join-url',
]);

/** `abc123_R20260217T050000` → `abc123` (gcal series re-slice suffix). */
export function recurringBaseId(recurringEventId: string): string {
  return recurringEventId.replace(/_R\d{8}T\d{6}Z?$/, '');
}

/** iCalUID `abc123_R…@google.com` → `abc123`. */
export function icalUidBase(iCalUID: string): string {
  return recurringBaseId(iCalUID.replace(/@google\.com$/i, ''));
}

/** Lowercased, date-tokens stripped, punctuation collapsed — the weak
 * "same title, probably same series" key. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All evidence keys derivable from a transcript's meeting context. */
export function keysFromContext(
  ctx: GmeetContext | null | undefined,
  title?: string | null
): SeriesKeyInput[] {
  const keys: SeriesKeyInput[] = [];
  if (ctx?.recurringEventId) {
    keys.push({ kind: 'recurring-base-id', value: recurringBaseId(ctx.recurringEventId) });
  }
  if (ctx?.iCalUID) {
    keys.push({ kind: 'ical-uid-base', value: icalUidBase(ctx.iCalUID) });
  }
  if (ctx?.teams?.graphMeetingId) {
    keys.push({ kind: 'graph-meeting-id', value: ctx.teams.graphMeetingId });
  }
  if (ctx?.teams?.joinWebUrl) {
    keys.push({ kind: 'teams-join-url', value: ctx.teams.joinWebUrl });
  }
  if (ctx?.meetingCode) {
    keys.push({ kind: 'meeting-code', value: ctx.meetingCode });
  }
  const t = (ctx?.eventTitle ?? title ?? '').trim();
  if (t) {
    const norm = normalizeTitle(t);
    if (norm.length >= 4) keys.push({ kind: 'normalized-title', value: norm });
  }
  return keys;
}

export function strongKeys(keys: SeriesKeyInput[]): SeriesKeyInput[] {
  return keys.filter((k) => STRONG_KINDS.has(k.kind));
}

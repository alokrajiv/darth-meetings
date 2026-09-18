/**
 * Caller-scoping for the label catalog (tech-debt D4, 2026-09-18).
 *
 * Series auto-labels (`Series/<series title>`, lib/series-label-name) mirror
 * series titles, and a series title IS a meeting title — the same leak class
 * as the 2026-08-24 unimported-view incident. The catalog is org-wide (a
 * shared taxonomy), so hand-made labels stay visible to everyone, but a
 * `Series/*` node the caller holds NO visible tagged transcript under must
 * not exist for them. The rule works on the subtree-inclusive visible count
 * the catalog query already computes, so the `Series` root itself
 * disappears with its last visible child.
 *
 * Pure + client-safe (unit-tested in src/lib/__tests__).
 */

import { SERIES_LABEL_ROOT } from '@/lib/series-label-name';

const SERIES_ROOT_KEY = SERIES_LABEL_ROOT.toLowerCase();

/** `path_key` is the lower-cased display path (lib/labels pathKeyOf). */
export function isSeriesLabelPathKey(pathKey: string): boolean {
  return pathKey === SERIES_ROOT_KEY || pathKey.startsWith(`${SERIES_ROOT_KEY}/`);
}

/**
 * THE predicate: a label is served to the caller unless it lives under the
 * reserved `Series` root AND none of the caller's visible transcripts
 * (own + shared, not trashed) carries it or a descendant.
 */
export function labelVisibleToCaller(row: { path_key: string; count_visible: number }): boolean {
  return !isSeriesLabelPathKey(row.path_key) || row.count_visible > 0;
}

export function hideUnseenSeriesLabels<T extends { path_key: string; count_visible: number }>(
  rows: readonly T[]
): T[] {
  return rows.filter(labelVisibleToCaller);
}

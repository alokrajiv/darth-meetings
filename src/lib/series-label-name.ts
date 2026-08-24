import { MAX_SEGMENT } from '@/lib/labels';

/**
 * Series auto-label naming (labels-design §5, rules v2 kind='series').
 *
 * Every series with ≥2 members gets a label `Series/<series title>` under
 * the reserved top-level "Series" root. The series title is free text, so
 * it must be squeezed into label-segment rules (src/lib/labels.ts
 * validateSegment): no '/', no control characters, 1..MAX_SEGMENT code
 * points, trimmed. On a name collision under Series/ the engine falls back
 * to the ` (#<seriesId>)`-suffixed variant, which is deterministic per
 * series (so a partially-failed earlier run reuses its own label).
 *
 * Pure + client-safe — unit-tested in src/lib/__tests__.
 */

export const SERIES_LABEL_ROOT = 'Series';

/** Truncate to `n` Unicode code points (validateSegment counts code points). */
function truncatePoints(s: string, n: number): string {
  return [...s].slice(0, n).join('').trim();
}

/** One segment-safe cleanup pass: '/'→'-', strip control chars, collapse ws. */
function cleanTitle(title: string): string {
  return title
    .replace(/\//g, '-')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SeriesLabelName {
  /** Preferred segment name: the cleaned series title. */
  base: string;
  /** Collision fallback: base shortened to fit ` (#<seriesId>)`. */
  suffixed: string;
}

/**
 * Derive the label segment name(s) for a series. `base` is tried first;
 * `suffixed` on a sibling collision under Series/. An empty/garbage title
 * degrades to `Series #<id>` (which is also its own suffix-free fallback —
 * it already carries the id, so `suffixed` repeats it only via the marker).
 */
export function deriveSeriesLabelName(title: string, seriesId: number): SeriesLabelName {
  const cleaned = cleanTitle(title ?? '');
  const base = truncatePoints(cleaned, MAX_SEGMENT) || `Series #${seriesId}`;
  const suffix = ` (#${seriesId})`;
  const room = MAX_SEGMENT - [...suffix].length;
  const stem = truncatePoints(cleaned, room) || 'Series';
  return { base, suffixed: `${stem}${suffix}` };
}

/** Full label path for a derived segment name. */
export function seriesLabelPath(segment: string): string {
  return `${SERIES_LABEL_ROOT}/${segment}`;
}

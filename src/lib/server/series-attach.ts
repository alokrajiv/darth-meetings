import 'server-only';
import {
  addKeys,
  addMember,
  createSeries,
  findSeriesByKeys,
  isExcluded,
  listUnattachedTranscripts,
} from '@/db-ops/series';
import { publishEvent } from '@/lib/server/event-bus';
import { keysFromContext, strongKeys, STRONG_KINDS } from '@/lib/series-keys';
import type { GmeetContext } from '@/lib/format';

/**
 * Import-time series attachment. STRONG evidence only — weak keys (meeting
 * code, title) never attach automatically; they surface as suggestions in
 * the series UI instead. A brand-new series is auto-created only when gcal
 * itself says the meeting is recurring (recurringEventId present), so
 * one-off meetings never spawn series objects.
 *
 * Never throws: series bookkeeping must not fail an import.
 */
export async function autoAttachSeries(row: {
  id: number;
  assemblyai_id: string;
  gmeet_context: GmeetContext | null;
  title: string | null;
  user_id: string;
  /** Temporary rows (migration 042) never auto-attach — they are out of the
   * archive, so they must not become series evidence either. */
  scratch?: boolean;
}): Promise<void> {
  try {
    if (row.scratch) return;
    const keys = keysFromContext(row.gmeet_context, row.title);
    const strong = strongKeys(keys);
    if (strong.length === 0) return;

    const matches = await findSeriesByKeys(strong);
    const strongMatch = matches.find((m) =>
      m.matched_kinds.some((k) => (STRONG_KINDS as ReadonlySet<string>).has(k))
    );

    let seriesId: number | null = null;
    if (strongMatch) {
      if (await isExcluded(strongMatch.series_id, row.id)) return;
      seriesId = strongMatch.series_id;
    } else if (row.gmeet_context?.recurringEventId) {
      const title =
        row.gmeet_context.eventTitle?.trim() || row.title?.trim() || 'Recurring meeting';
      const created = await createSeries(row.user_id, title);
      seriesId = created.id;
    }
    if (seriesId === null) return;

    // The new meeting's whole key bag strengthens the series for next time.
    await addKeys(seriesId, keys, 'import', row.user_id);
    await addMember(seriesId, row.id, 'auto', row.user_id);
    publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
  } catch (err) {
    console.warn('[series] auto-attach failed (import unaffected):', err);
  }
}

/**
 * Retro-attach sweep: re-run strong-key matching over every transcript that
 * belongs to no series — catches rows imported before their series existed
 * or before a merge unified the key bags. Same rules as import-time attach,
 * minus the create-new branch: old rows only ever join EXISTING series
 * (nobody wants a merge to spawn series from a year of one-offs).
 *
 * Weak-only matches are counted, not acted on — those rows already surface
 * as dashed "?" chips in the listing.
 */
export async function retroAttachSweep(
  runBy: string
): Promise<{ scanned: number; attached: number; suggestions: number }> {
  const rows = await listUnattachedTranscripts();
  let attached = 0;
  let suggestions = 0;
  for (const row of rows) {
    try {
      const keys = keysFromContext(row.gmeet_context, row.title);
      if (keys.length === 0) continue;
      const matches = await findSeriesByKeys(keys);
      if (matches.length === 0) continue;
      const strongSet = new Set(strongKeys(keys).map((k) => k.kind as string));
      const strongMatch = matches.find((m) => m.matched_kinds.some((k) => strongSet.has(k)));
      if (!strongMatch) {
        suggestions++;
        continue;
      }
      if (await isExcluded(strongMatch.series_id, row.id)) continue;
      await addKeys(strongMatch.series_id, keys, 'import', row.user_id);
      await addMember(strongMatch.series_id, row.id, 'auto', row.user_id);
      publishEvent({ kind: 'meta', assemblyaiId: row.assemblyai_id });
      attached++;
    } catch (err) {
      console.warn(`[series] retro-attach skipped transcript ${row.id}:`, err);
    }
  }
  if (attached > 0) {
    console.log(`[series] retro-attach by ${runBy}: ${attached} attached of ${rows.length} scanned`);
  }
  return { scanned: rows.length, attached, suggestions };
}

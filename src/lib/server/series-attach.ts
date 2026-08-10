import 'server-only';
import {
  addKeys,
  addMember,
  createSeries,
  findSeriesByKeys,
  isExcluded,
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
}): Promise<void> {
  try {
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

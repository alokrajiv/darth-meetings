import 'server-only';
import { listPollableGoogleAccounts, type GoogleAccountRow } from '@/db-ops/google-accounts';
import { getAutoSyncLog, listAutoSyncUsers, type AutoSyncLogRow } from '@/db-ops/user-prefs';
import { listAutoImportEnabledSeries } from '@/db-ops/series';
import {
  listRecentlyEndedOccurrences,
  type RecentlyEndedOccurrenceRow,
} from '@/db-ops/calendar-event-cache';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import { upsertReminder } from '@/db-ops/gmeet-reminders';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { probeMeetingEvidence } from '@/lib/server/meeting-discovery';
import { sweepAutoImportSeries } from '@/lib/server/series-auto-import';
import { sweepAccountAutoSync } from '@/lib/server/account-auto-sync';
import {
  fastLaneAccounts,
  occurrenceKey,
  probeKey,
  selectFastLaneOccurrences,
  MAX_PROBES_PER_ACCOUNT,
  MAX_PROBES_PER_PASS,
  PROBE_COOLDOWN_MS,
  RECENTLY_ENDED_MS,
  type AutoSyncOutcomeRow,
  type FastLaneAutoSync,
  type FastLaneOccurrence,
} from '@/lib/fast-lane';

/**
 * The FAST LANE — "the call just ended, import it now".
 *
 * The 30-minute sweep (gmeet-poller.sweepAll) is the only thing that
 * discovers new Meet artifacts, so a call that ends at 17:55 SGT and has
 * its recording + Gemini notes at Google by 18:20 SGT can sit unimported
 * until 18:30–19:00 (weekly Tressa review, 2026-09-22 — the bug this
 * exists for). This second, much cheaper timer re-probes only the handful
 * of occurrences someone is plausibly waiting for:
 *
 *  - accounts that asked for automatic imports (account auto-sync on for
 *    Meet, or the enabler of an auto-import series) — nobody else's
 *    meetings get spent budget;
 *  - their CACHED calendar occurrences (no Calendar API call — the 30-min
 *    sweep already persisted them) that ended in the last 120 minutes;
 *  - minus imported, minus already-reminded, minus auto-sync-settled,
 *    minus anything this lane probed in the last 5 minutes.
 *
 * What it does per occurrence is EXACTLY the full sweep's per-occurrence
 * step (probeMeetingEvidence → the same 'unimported' reminder row), then
 * the same two sweeps the full pass ends with. It imports nothing itself.
 *
 * Mutual exclusion with the full sweep is the poller's `sweeping` flag —
 * this module never runs itself; gmeet-poller drives it under the lock.
 */

const FAST_LANE_MINUTES = Number(process.env.GMEET_FAST_LANE_MINUTES || 5);
export const FAST_LANE_MS = FAST_LANE_MINUTES * 60 * 1000;

/** Last fast-lane probe per `<userId>|<eventKey>`. In process on purpose:
 * it only has to survive between ticks of one timer, and a restart losing
 * it costs at most one extra probe per occurrence. */
const probedAt = new Map<string, number>();

/** Drop cooldown entries that can no longer gate anything (their
 * occurrence has aged out of the window). */
function pruneProbed(now: number): void {
  for (const [k, at] of probedAt) {
    if (now - at > RECENTLY_ENDED_MS + PROBE_COOLDOWN_MS) probedAt.delete(k);
  }
}

function toOccurrence(row: RecentlyEndedOccurrenceRow): FastLaneOccurrence | null {
  const rawStart = row.raw_start;
  if (!rawStart) return null;
  const startMs = Date.parse(rawStart);
  if (Number.isNaN(startMs)) return null;
  const endedAt = row.conf_end ?? row.event_end ?? row.event_start;
  const endMs = Date.parse(endedAt);
  if (Number.isNaN(endMs)) return null;
  return {
    eventKey: `${row.meeting_code}|${rawStart}`,
    meetingCode: row.meeting_code,
    rawStart,
    startIso: new Date(startMs).toISOString(),
    endMs,
    title: row.title,
    organizerSelf: row.organizer_self === true,
    reminded: row.reminded === true,
  };
}

interface PassStats {
  accounts: number;
  probed: number;
  reminders: number;
  /** Meet API calls actually issued (record lookup + the two artifact
   * listings), so the cost of this lane can be watched in the logs. */
  apiCalls: number;
  /** Occurrences the lane reminded about that auto-sync then took. */
  taken: number;
}

/** One account's slice of the pass. Returns how much budget it spent. */
async function fastLaneUser(
  account: GoogleAccountRow,
  eligibility: ReturnType<typeof fastLaneAccounts>[number]['eligibility'],
  budget: { left: number },
  now: number,
  stats: PassStats,
  fired: Set<string>
): Promise<void> {
  const caller = { userId: account.user_id, email: account.user_email };
  const rows = await listRecentlyEndedOccurrences(caller.userId, {
    endedAfter: new Date(now - RECENTLY_ENDED_MS).toISOString(),
    endedBefore: new Date(now).toISOString(),
  });
  const occurrences = rows
    .map(toOccurrence)
    .filter((o): o is FastLaneOccurrence => o !== null);
  if (occurrences.length === 0) return;

  const [imported, log] = await Promise.all([
    findImportedByMeetingCodes(
      occurrences.map((o) => ({ code: o.meetingCode, startTime: o.rawStart })),
      caller
    ).catch(() => occurrences.map(() => null)),
    getAutoSyncLog(occurrences.map((o) => occurrenceKey(o.meetingCode, o.startIso))).catch(
      () => new Map<string, AutoSyncLogRow>()
    ),
  ]);
  const outcomes = new Map<string, AutoSyncOutcomeRow>(
    [...log].map(([k, v]) => [k, { outcome: v.outcome, updatedAt: v.updated_at }])
  );

  const { probe } = selectFastLaneOccurrences({
    occurrences,
    eligibility,
    imported: imported.map((i) => i !== null),
    outcomes,
    probedAt,
    now,
    max: Math.min(budget.left, MAX_PROBES_PER_ACCOUNT),
  });
  if (probe.length === 0) return;

  const minted = await getServerAccessToken(caller.userId);
  if (!minted) return; // revoked / transient — the full sweep records status
  const token = minted.token;

  // One batched cache read for the whole slice: probeMeetingEvidence would
  // otherwise do one per occurrence, and knowing whether a conference
  // record is already cached is what makes the API-call count exact.
  const cacheRows = await getMeetingCacheByMeetings(
    probe.map((o) => ({ code: o.meetingCode, startTime: o.rawStart }))
  ).catch(() => probe.map(() => null));

  for (let i = 0; i < probe.length; i++) {
    const o = probe[i]!;
    const existing = cacheRows[i] ?? null;
    probedAt.set(probeKey(caller.userId, o.eventKey), now);
    budget.left--;
    stats.probed++;
    stats.apiCalls += existing?.conference_record ? 2 : 3;
    const row = rows.find((r) => `${r.meeting_code}|${r.raw_start}` === o.eventKey)!;
    let hasRecording: boolean;
    let hasTranscript: boolean;
    try {
      const { verdict } = await probeMeetingEvidence(token, {
        userId: caller.userId,
        meetingCode: o.meetingCode,
        eventStart: o.rawStart,
        attachments: {
          videoFileId: row.attachment_video_file_id,
          videoCount: row.attachment_video_count,
          transcriptDocId: row.attachment_transcript_doc_id,
          geminiNotes: row.attachment_gemini_notes,
        },
        event: {
          recurringEventId: row.recurring_event_id,
          iCalUID: row.ical_uid,
          organizerEmail: row.organizer_email,
        },
        existing,
      });
      if (!verdict.importable) continue;
      hasRecording = verdict.hasRecording;
      hasTranscript = verdict.hasTranscript;
      // Still generating — a later pass (or the full sweep) will see it.
      if (!hasRecording && !hasTranscript) continue;
    } catch (err) {
      console.warn('[gmeet-fast-lane] probe failed for', o.eventKey, err);
      continue;
    }
    await upsertReminder({
      userId: caller.userId,
      kind: 'unimported',
      eventKey: o.eventKey,
      meetingCode: o.meetingCode,
      title: o.title,
      eventStart: o.rawStart,
      organizerSelf: o.organizerSelf,
      hasRecording,
      hasTranscript,
    });
    stats.reminders++;
    fired.add(occurrenceKey(o.meetingCode, o.startIso));
  }
}

/**
 * One fast-lane pass. Never throws. The caller holds the poller's sweep
 * lock — a pass and a full sweep must never overlap.
 */
export async function sweepRecentlyEnded(): Promise<void> {
  const now = Date.now();
  pruneProbed(now);
  const stats: PassStats = { accounts: 0, probed: 0, reminders: 0, apiCalls: 0, taken: 0 };
  const fired = new Set<string>();
  try {
    const [pollable, autoSyncUsers, series] = await Promise.all([
      listPollableGoogleAccounts(),
      listAutoSyncUsers(),
      listAutoImportEnabledSeries(),
    ]);
    const prefs = new Map<string, FastLaneAutoSync>(
      autoSyncUsers
        .filter((u) => u.prefs.scope !== 'off')
        .map((u) => [
          u.userId,
          {
            scope: u.prefs.scope === 'mine' ? 'mine' : 'all',
            since: u.prefs.since,
            gmeet: u.prefs.providers.gmeet,
          } satisfies FastLaneAutoSync,
        ])
    );
    const enablers = new Set(
      series.map((s) => s.auto_import?.byUserId).filter((id): id is string => !!id)
    );
    const eligible = fastLaneAccounts(pollable, prefs, enablers);
    if (eligible.length === 0) return;
    stats.accounts = eligible.length;

    const budget = { left: MAX_PROBES_PER_PASS };
    for (const { account, eligibility } of eligible) {
      if (budget.left <= 0) break;
      try {
        await fastLaneUser(account, eligibility, budget, now, stats, fired);
      } catch (err) {
        console.warn(`[gmeet-fast-lane] pass failed for ${account.user_email}:`, err);
      }
    }

    // Nothing new was discovered → the two sweeps have no new input; the
    // 30-minute pass runs them anyway.
    if (fired.size > 0) {
      await sweepAutoImportSeries();
      await sweepAccountAutoSync();
      const after = await getAutoSyncLog([...fired]).catch(
        () => new Map<string, AutoSyncLogRow>()
      );
      for (const key of fired) {
        const outcome = after.get(key)?.outcome;
        if (outcome === 'imported' || outcome === 'deferred' || outcome === 'already') stats.taken++;
      }
    }
  } catch (err) {
    console.warn('[gmeet-fast-lane] pass failed:', err);
  } finally {
    if (stats.probed > 0) {
      console.log(
        `[gmeet-fast-lane] ${stats.probed} occurrence(s) probed, ${stats.reminders} reminder(s), ` +
          `${stats.taken} imported/deferred (${stats.apiCalls} Meet API call(s), ` +
          `${stats.accounts} account(s))`
      );
    }
  }
}

/**
 * Fast-lane selection rules — pure, no DB, no Google.
 *
 * The 30-minute poller sweep (lib/server/gmeet-poller) is the only thing
 * that ever DISCOVERS new Meet artifacts, so a call that ends at 18:00 and
 * has its recording + Gemini notes at Google by 18:20 can sit unimported
 * until 18:30–19:00. The fast lane is a second, much cheaper timer that
 * re-probes only the handful of occurrences someone is plausibly waiting
 * for: recently ended, not imported, artifacts not yet recorded, belonging
 * to an account that asked for automatic imports.
 *
 * Everything policy-ish lives here so it can be tested without a socket;
 * lib/server/gmeet-fast-lane.ts does the IO around it.
 */

/** How far back a "recently ended" occurrence may have ended. */
export const RECENTLY_ENDED_MS = 120 * 60_000;

/** An occurrence the fast lane probed this recently is left alone — the
 * next pass will pick it up. Google needs minutes, not seconds. */
export const PROBE_COOLDOWN_MS = 5 * 60_000;

/** Hard ceilings on Meet API spend. One probe is at most 3 Meet calls
 * (record lookup + recordings + transcripts), so a worst-case pass is
 * MAX_PROBES_PER_PASS × 3 calls every GMEET_FAST_LANE_MINUTES. */
export const MAX_PROBES_PER_PASS = 12;
export const MAX_PROBES_PER_ACCOUNT = 6;

/** Auto-sync ledger outcomes that mean "this occurrence is settled" —
 * mirrors the non-retryable set in lib/server/account-auto-sync
 * (`retryable()`); a claim writes outcome 'failed' + detail 'claimed' and
 * is only retried after its cool-off. */
const SETTLED_OUTCOMES = new Set(['imported', 'deferred', 'already']);
const FAILED_RETRY_MS = 12 * 3600 * 1000;
const NUDGE_RETRY_MS = 24 * 3600 * 1000;

export interface AutoSyncOutcomeRow {
  outcome: string;
  /** ISO — when the ledger row last moved. */
  updatedAt: string | null;
}

/** True when account auto-sync already owns this occurrence (imported,
 * deferred, already there, or claimed and still inside its retry cool-off). */
export function autoSyncSettled(prior: AutoSyncOutcomeRow | undefined, now: number): boolean {
  if (!prior) return false;
  if (SETTLED_OUTCOMES.has(prior.outcome)) return true;
  const at = prior.updatedAt ? Date.parse(prior.updatedAt) : NaN;
  if (Number.isNaN(at)) return true; // unreadable ledger row — leave it to the full sweep
  const age = now - at;
  return age <= (prior.outcome === 'failed' ? FAILED_RETRY_MS : NUDGE_RETRY_MS);
}

// ---------------------------------------------------------------------------
// Which accounts the fast lane looks at
// ---------------------------------------------------------------------------

export interface FastLaneAutoSync {
  /** 'off' never reaches here — listAutoSyncUsers only returns switched-on. */
  scope: 'mine' | 'all';
  /** ISO — occurrences starting at or before this are never auto-synced. */
  since: string | null;
  /** The Google Meet provider switch. */
  gmeet: boolean;
}

export interface FastLaneEligibility {
  userId: string;
  email: string;
  /** null = no account-level auto-sync switch (eligible via a series only). */
  autoSync: FastLaneAutoSync | null;
  /** This account is the enabler of at least one auto-import series. */
  seriesEnabler: boolean;
}

/**
 * Pollable accounts that have account auto-sync on (for Meet) OR enable
 * auto-import on some series — the only accounts whose "the call just
 * ended" is worth Meet API budget. A Teams-only auto-sync account with no
 * series is not in the fast lane: it has no Meet occurrences to probe.
 */
export function fastLaneAccounts<T extends { user_id: string; user_email: string }>(
  pollable: readonly T[],
  autoSync: ReadonlyMap<string, FastLaneAutoSync>,
  seriesEnablerIds: ReadonlySet<string>
): Array<{ account: T; eligibility: FastLaneEligibility }> {
  const out: Array<{ account: T; eligibility: FastLaneEligibility }> = [];
  for (const account of pollable) {
    const prefs = autoSync.get(account.user_id) ?? null;
    const seriesEnabler = seriesEnablerIds.has(account.user_id);
    if (!seriesEnabler && (!prefs || !prefs.gmeet)) continue;
    out.push({
      account,
      eligibility: {
        userId: account.user_id,
        email: account.user_email,
        autoSync: prefs,
        seriesEnabler,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which occurrences of an eligible account get probed
// ---------------------------------------------------------------------------

export interface FastLaneOccurrence {
  /** `<meetingCode>|<raw calendar start>` — the key the full sweep writes
   * reminders and artifact-cache rows under (per-user tz flavour and all). */
  eventKey: string;
  meetingCode: string;
  /** Raw calendar dateTime string, offset preserved. */
  rawStart: string;
  /** Normalised UTC ISO — the auto-sync ledger's occurrence key half. */
  startIso: string;
  /** Effective end: the conference record's end when known, else the
   * calendar end (a call that ended early is ready long before its slot). */
  endMs: number;
  title: string | null;
  organizerSelf: boolean;
  /** The user already has an open 'unimported' reminder naming an artifact
   * for this occurrence — the full sweep found it; auto-sync consumes it in
   * this very pass, so there is nothing left to discover. */
  reminded: boolean;
}

export type FastLaneSkip =
  | 'not-recently-ended'
  | 'imported'
  | 'reminded'
  | 'auto-sync-settled'
  | 'cooling-down'
  | 'not-organizer'
  | 'before-since'
  | 'capped';

export interface FastLaneSelection {
  probe: FastLaneOccurrence[];
  skipped: Array<{ occurrence: FastLaneOccurrence; reason: FastLaneSkip }>;
}

/** The in-process cooldown map's key: the probe runs under one account's
 * token and writes that account's reminder, so two accounts sharing an
 * occurrence must not shadow each other. */
export function probeKey(userId: string, eventKey: string): string {
  return `${userId}|${eventKey}`;
}

/** `<meetingCode>|<UTC ISO>` — how account auto-sync keys its ledger. */
export function occurrenceKey(meetingCode: string, startIso: string): string {
  return `${meetingCode}|${startIso}`;
}

export function selectFastLaneOccurrences(input: {
  occurrences: readonly FastLaneOccurrence[];
  eligibility: FastLaneEligibility;
  /** Parallel to `occurrences`: an import is already visible to this user. */
  imported: readonly boolean[];
  /** Auto-sync ledger by `occurrenceKey`. */
  outcomes: ReadonlyMap<string, AutoSyncOutcomeRow>;
  /** Last fast-lane probe per `probeKey`, epoch ms. */
  probedAt: ReadonlyMap<string, number>;
  now: number;
  /** Remaining probe budget for this account. */
  max: number;
}): FastLaneSelection {
  const { eligibility: el, now } = input;
  const probe: FastLaneOccurrence[] = [];
  const skipped: FastLaneSelection['skipped'] = [];
  // Freshest first: the call that just ended is the one someone is waiting
  // for, and it is the one a capped pass must not drop.
  const order = input.occurrences
    .map((occurrence, i) => ({ occurrence, imported: input.imported[i] === true }))
    .sort((a, b) => b.occurrence.endMs - a.occurrence.endMs);

  for (const { occurrence: o, imported } of order) {
    const skip = (reason: FastLaneSkip) => skipped.push({ occurrence: o, reason });
    if (o.endMs > now || o.endMs < now - RECENTLY_ENDED_MS) {
      skip('not-recently-ended');
      continue;
    }
    if (imported) {
      skip('imported');
      continue;
    }
    if (o.reminded) {
      skip('reminded');
      continue;
    }
    // A series enabler's occurrences are the series sweep's business, so
    // the account switch's scope/since only gate accounts that have no
    // series reason to be here.
    if (!el.seriesEnabler && el.autoSync) {
      if (el.autoSync.scope === 'mine' && !o.organizerSelf) {
        skip('not-organizer');
        continue;
      }
      const since = el.autoSync.since ? Date.parse(el.autoSync.since) : NaN;
      if (!Number.isNaN(since) && Date.parse(o.startIso) <= since) {
        skip('before-since');
        continue;
      }
    }
    if (autoSyncSettled(input.outcomes.get(occurrenceKey(o.meetingCode, o.startIso)), now)) {
      skip('auto-sync-settled');
      continue;
    }
    const last = input.probedAt.get(probeKey(el.userId, o.eventKey));
    if (last !== undefined && now - last < PROBE_COOLDOWN_MS) {
      skip('cooling-down');
      continue;
    }
    if (probe.length >= input.max) {
      skip('capped');
      continue;
    }
    probe.push(o);
  }
  return { probe, skipped };
}

/**
 * The fast lane's SELECTION (lib/fast-lane) — which accounts get Meet API
 * budget every 5 minutes, and which of their just-ended occurrences get
 * probed. Pure rules, no DB: the IO half (lib/server/gmeet-fast-lane) only
 * feeds these functions rows.
 *
 * Context: 2026-09-22, the Weekly Tressa Review (`weo-xgvy-uxb`, 17:30–18:30
 * SGT) ended early and had its recording + Gemini notes at Google by 18:20
 * SGT, but discovery only ran in the 30-minute sweep.
 */
import { describe, expect, test } from 'bun:test';
import {
  autoSyncSettled,
  fastLaneAccounts,
  occurrenceKey,
  probeKey,
  selectFastLaneOccurrences,
  MAX_PROBES_PER_ACCOUNT,
  PROBE_COOLDOWN_MS,
  RECENTLY_ENDED_MS,
  type AutoSyncOutcomeRow,
  type FastLaneAutoSync,
  type FastLaneEligibility,
  type FastLaneOccurrence,
} from '@/lib/fast-lane';

const NOW = Date.parse('2026-09-22T10:20:00Z'); // 18:20 SGT
const MIN = 60_000;

const ALL: FastLaneAutoSync = { scope: 'all', since: null, gmeet: true };

function account(id: string) {
  return { user_id: id, user_email: `${id}@trames.sg` };
}

function occ(over: Partial<FastLaneOccurrence> = {}): FastLaneOccurrence {
  const rawStart = over.rawStart ?? '2026-09-22T17:30:00+08:00';
  const code = over.meetingCode ?? 'weo-xgvy-uxb';
  return {
    eventKey: `${code}|${rawStart}`,
    meetingCode: code,
    rawStart,
    startIso: new Date(Date.parse(rawStart)).toISOString(),
    // Ended early at 18:00 SGT — 20 minutes before "now".
    endMs: NOW - 20 * MIN,
    title: 'Weekly Tressa Review',
    organizerSelf: true,
    reminded: false,
    ...over,
  };
}

function eligible(over: Partial<FastLaneEligibility> = {}): FastLaneEligibility {
  return { userId: 'alok', email: 'alok@trames.sg', autoSync: ALL, seriesEnabler: false, ...over };
}

function select(
  occurrences: FastLaneOccurrence[],
  over: {
    eligibility?: FastLaneEligibility;
    imported?: boolean[];
    outcomes?: Map<string, AutoSyncOutcomeRow>;
    probedAt?: Map<string, number>;
    max?: number;
  } = {}
) {
  return selectFastLaneOccurrences({
    occurrences,
    eligibility: over.eligibility ?? eligible(),
    imported: over.imported ?? occurrences.map(() => false),
    outcomes: over.outcomes ?? new Map(),
    probedAt: over.probedAt ?? new Map(),
    now: NOW,
    max: over.max ?? MAX_PROBES_PER_ACCOUNT,
  });
}

const reasons = (r: ReturnType<typeof select>) => r.skipped.map((s) => s.reason);

describe('fastLaneAccounts — whose meetings are worth Meet API budget', () => {
  const prefs = new Map<string, FastLaneAutoSync>([['alok', ALL]]);

  test('an account with account auto-sync on is in', () => {
    const picked = fastLaneAccounts([account('alok')], prefs, new Set());
    expect(picked).toHaveLength(1);
    expect(picked[0]!.eligibility.autoSync).toEqual(ALL);
    expect(picked[0]!.eligibility.seriesEnabler).toBe(false);
  });

  test('an account with the switch off and no series is out', () => {
    expect(fastLaneAccounts([account('jac')], prefs, new Set())).toHaveLength(0);
  });

  test('the enabler of an auto-import series is in even with the switch off', () => {
    const picked = fastLaneAccounts([account('jac')], prefs, new Set(['jac']));
    expect(picked).toHaveLength(1);
    expect(picked[0]!.eligibility.autoSync).toBeNull();
    expect(picked[0]!.eligibility.seriesEnabler).toBe(true);
  });

  test('a Teams-only auto-sync account is out — it has no Meet occurrence to probe', () => {
    const teamsOnly = new Map<string, FastLaneAutoSync>([
      ['alok', { scope: 'all', since: null, gmeet: false }],
    ]);
    expect(fastLaneAccounts([account('alok')], teamsOnly, new Set())).toHaveLength(0);
    // …unless a series puts it back in.
    expect(fastLaneAccounts([account('alok')], teamsOnly, new Set(['alok']))).toHaveLength(1);
  });

  test('an account that is not pollable is never in (revoked never reaches here)', () => {
    expect(fastLaneAccounts([], prefs, new Set(['alok']))).toHaveLength(0);
  });
});

describe('selectFastLaneOccurrences — recently ended', () => {
  test('the call that just ended is probed', () => {
    const r = select([occ()]);
    expect(r.probe).toHaveLength(1);
    expect(r.probe[0]!.eventKey).toBe('weo-xgvy-uxb|2026-09-22T17:30:00+08:00');
  });

  test('an occurrence that ended before the window is left to the full sweep', () => {
    const r = select([occ({ endMs: NOW - RECENTLY_ENDED_MS - MIN })]);
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['not-recently-ended']);
  });

  test('a call still in progress is not probed', () => {
    const r = select([occ({ endMs: NOW + 10 * MIN })]);
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['not-recently-ended']);
  });

  test('right at the window edge still counts', () => {
    expect(select([occ({ endMs: NOW - RECENTLY_ENDED_MS })]).probe).toHaveLength(1);
    expect(select([occ({ endMs: NOW })]).probe).toHaveLength(1);
  });
});

describe('selectFastLaneOccurrences — nothing left to discover', () => {
  test('an already-imported occurrence is skipped', () => {
    const r = select([occ()], { imported: [true] });
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['imported']);
  });

  test('an occurrence the full sweep already reminded about is skipped', () => {
    const r = select([occ({ reminded: true })]);
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['reminded']);
  });

  test('auto-sync outcomes that own the occurrence are skipped', () => {
    for (const outcome of ['imported', 'deferred', 'already']) {
      const o = occ();
      const outcomes = new Map([
        [occurrenceKey(o.meetingCode, o.startIso), { outcome, updatedAt: null }],
      ]);
      const r = select([o], { outcomes });
      expect(r.probe).toHaveLength(0);
      expect(reasons(r)).toEqual(['auto-sync-settled']);
    }
  });

  test('a fresh claim is skipped, an aged-out failure is retried', () => {
    const o = occ();
    const key = occurrenceKey(o.meetingCode, o.startIso);
    const claimed = new Map([
      [key, { outcome: 'failed', updatedAt: new Date(NOW - 5 * MIN).toISOString() }],
    ]);
    expect(select([o], { outcomes: claimed }).probe).toHaveLength(0);

    const cold = new Map([
      [key, { outcome: 'failed', updatedAt: new Date(NOW - 13 * 3600_000).toISOString() }],
    ]);
    expect(select([o], { outcomes: cold }).probe).toHaveLength(1);
  });

  test('autoSyncSettled: no ledger row means nothing owns it', () => {
    expect(autoSyncSettled(undefined, NOW)).toBe(false);
    expect(autoSyncSettled({ outcome: 'nudged', updatedAt: null }, NOW)).toBe(true);
    expect(
      autoSyncSettled(
        { outcome: 'nudged', updatedAt: new Date(NOW - 25 * 3600_000).toISOString() },
        NOW
      )
    ).toBe(false);
  });
});

describe('selectFastLaneOccurrences — cooldown', () => {
  test('an occurrence probed by this lane 2 minutes ago waits', () => {
    const o = occ();
    const probedAt = new Map([[probeKey('alok', o.eventKey), NOW - 2 * MIN]]);
    const r = select([o], { probedAt });
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['cooling-down']);
  });

  test('past the cooldown it is probed again', () => {
    const o = occ();
    const probedAt = new Map([[probeKey('alok', o.eventKey), NOW - PROBE_COOLDOWN_MS]]);
    expect(select([o], { probedAt }).probe).toHaveLength(1);
  });

  test('the cooldown is per account — one account cannot starve another', () => {
    const o = occ();
    const probedAt = new Map([[probeKey('jac', o.eventKey), NOW]]);
    expect(select([o], { probedAt }).probe).toHaveLength(1);
  });
});

describe('selectFastLaneOccurrences — the account switches', () => {
  test("scope 'mine' drops an occurrence the user did not organise", () => {
    const el = eligible({ autoSync: { scope: 'mine', since: null, gmeet: true } });
    const r = select([occ({ organizerSelf: false })], { eligibility: el });
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['not-organizer']);
    expect(select([occ({ organizerSelf: true })], { eligibility: el }).probe).toHaveLength(1);
  });

  test("scope 'all' takes a colleague's meeting", () => {
    expect(select([occ({ organizerSelf: false })]).probe).toHaveLength(1);
  });

  test('`since` never backfills history', () => {
    const el = eligible({ autoSync: { scope: 'all', since: '2026-09-23T00:00:00Z', gmeet: true } });
    const r = select([occ()], { eligibility: el });
    expect(r.probe).toHaveLength(0);
    expect(reasons(r)).toEqual(['before-since']);
  });

  test('a series enabler is not filtered by the account switch it does not have', () => {
    const el = eligible({ autoSync: null, seriesEnabler: true });
    expect(select([occ({ organizerSelf: false })], { eligibility: el }).probe).toHaveLength(1);
  });

  test("a series enabler's occurrences survive their own 'mine' switch too", () => {
    const el = eligible({
      autoSync: { scope: 'mine', since: '2026-09-23T00:00:00Z', gmeet: true },
      seriesEnabler: true,
    });
    expect(select([occ({ organizerSelf: false })], { eligibility: el }).probe).toHaveLength(1);
  });
});

describe('selectFastLaneOccurrences — budget', () => {
  test('the freshest-ended occurrences win a capped pass', () => {
    const list = [
      occ({ meetingCode: 'aaa-aaaa-aaa', endMs: NOW - 90 * MIN }),
      occ({ meetingCode: 'bbb-bbbb-bbb', endMs: NOW - 5 * MIN }),
      occ({ meetingCode: 'ccc-cccc-ccc', endMs: NOW - 40 * MIN }),
    ];
    const r = select(list, { max: 2 });
    expect(r.probe.map((o) => o.meetingCode)).toEqual(['bbb-bbbb-bbb', 'ccc-cccc-ccc']);
    expect(reasons(r)).toEqual(['capped']);
  });

  test('a zero budget probes nothing', () => {
    expect(select([occ()], { max: 0 }).probe).toHaveLength(0);
  });
});

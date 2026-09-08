import 'server-only';
import { listAutoSyncUsers, getAutoSyncLog, type AutoSyncUser, type AutoSyncLogRow } from '@/db-ops/user-prefs';
import { findSeriesByKeys, getSeries, findAutoImportLogByStart, type SeriesRow, type AutoImportLogRow } from '@/db-ops/series';
import { mergedCalendarOccurrence } from '@/db-ops/calendar-event-cache';
import { getTeamsJoinUrlByMeeting } from '@/db-ops/gmeet-meeting-cache';
import { recurringBaseId, type SeriesKeyInput } from '@/lib/series-keys';
import { strongestReport, type ReportPref } from '@/lib/auto-marker';

/**
 * THE resolver for "what will automation do with this occurrence": who
 * imports, in which mode, which report kind, and who watches. Both sweeps,
 * the listing chip, the series card and the CLI `auto-sync explain` verb
 * read this one function so they can never disagree.
 *
 * Rules (Alok, 2026-09-08 — after a series setting silently downgraded a
 * colleague's detailed-video ask to a summary and told nobody):
 *  - A series with an explicit setting OWNS its occurrences: enabled → the
 *    enabler's connection imports (they chose to carry it), disabled → an
 *    explicit opt-out that beats every account switch.
 *  - Otherwise account auto-sync elects: organiser first, then earliest-
 *    connected Google account (same order the sweep tries tokens in).
 *  - MODE follows the importer's own setting (series mode, else their
 *    account mode) — it is the cost decision someone made on purpose.
 *  - REPORT is the STRONGEST preference across everyone interested (series
 *    pref + every auto-sync attendee). Automation never lowers what a
 *    watcher asked for; one import serves all of them.
 *  - WATCHERS = every interested auto-sync user who isn't the importer.
 *    They get shared onto the row and DM'd at every stage.
 */

export type Provider = 'gmeet' | 'teams';

export interface OccurrenceFacts {
  /** Meet code, or the `teams-…` cache code. */
  code: string;
  /** UTC ISO instant (normalised — never a per-user-tz key). */
  startIso: string;
  provider: Provider;
  title?: string | null;
  organizerEmail?: string | null;
  /** Attendee emails (any case). Organiser is added automatically. */
  attendees?: string[] | null;
  recurringEventId?: string | null;
  /** Teams: the join URL (resolved from the cache when absent). */
  teamsJoinUrl?: string | null;
}

export interface AutoPlan {
  /** Who owns the occurrence. 'none' = nobody will import it automatically. */
  owner: 'series' | 'account' | 'none';
  /** Human-readable why (esp. for 'none'). */
  reason: string;
  seriesId: number | null;
  seriesTitle: string | null;
  /** Series setting present but disabled = explicit opt-out. */
  seriesOptedOut: boolean;
  importer: { userId: string; email: string } | null;
  /** Fallback importers in election order (account owner only). */
  fallbackImporters: Array<{ userId: string; email: string }>;
  mode: 'transcript' | 'video' | 'both' | null;
  report: ReportPref | null;
  watchers: string[];
  /** Everyone whose auto-sync covers this occurrence, with what they asked for. */
  interested: Array<{ email: string; report: ReportPref; mode: string; organiser: boolean }>;
}

/** Auto-sync users whose OWN switch covers this occurrence: in the meeting
 * (attendee or organiser), provider on, scope, and start after their
 * enable time. The single definition both sweeps use. */
export function interestedAutoSyncUsers(
  occ: Pick<OccurrenceFacts, 'startIso' | 'provider' | 'organizerEmail' | 'attendees'>,
  users: AutoSyncUser[]
): AutoSyncUser[] {
  const involved = new Set((occ.attendees ?? []).map((e) => e.toLowerCase()));
  const organiser = occ.organizerEmail?.toLowerCase() ?? null;
  if (organiser) involved.add(organiser);
  const startMs = Date.parse(occ.startIso);
  return users.filter((u) => {
    const email = u.email.toLowerCase();
    if (!involved.has(email)) return false;
    if (!u.prefs.providers[occ.provider]) return false;
    if (u.prefs.since && startMs <= Date.parse(u.prefs.since)) return false;
    if (u.prefs.scope === 'mine' && organiser !== email) return false;
    return true;
  });
}

/** The series (if any) holding an explicit auto-import setting for this
 * occurrence. Matches on Meet code / Teams join URL / recurring base id —
 * the same keys the series index attaches on. */
export async function seriesOwnerFor(
  occ: Pick<OccurrenceFacts, 'code' | 'startIso' | 'provider' | 'recurringEventId' | 'teamsJoinUrl'>
): Promise<SeriesRow | null> {
  const keys: SeriesKeyInput[] = [];
  if (occ.provider === 'gmeet') keys.push({ kind: 'meeting-code', value: occ.code });
  else {
    const url = occ.teamsJoinUrl ?? (await getTeamsJoinUrlByMeeting(occ.code, occ.startIso).catch(() => null));
    if (url) keys.push({ kind: 'teams-join-url', value: url });
  }
  if (occ.recurringEventId) keys.push({ kind: 'recurring-base-id', value: recurringBaseId(occ.recurringEventId) });
  if (keys.length === 0) return null;
  const hits = await findSeriesByKeys(keys);
  for (const h of hits) {
    const s = await getSeries(h.series_id);
    if (s?.auto_import) return s;
  }
  return null;
}

/** Election order for account-owned occurrences: organiser first (owns the
 * Drive artifacts), then earliest-connected Google account; revoked
 * connections can't carry an import. */
export function orderElectors(users: AutoSyncUser[], organizerEmail: string | null | undefined): AutoSyncUser[] {
  const org = organizerEmail?.toLowerCase() ?? null;
  return users
    .filter((u) => u.googleStatus !== 'revoked')
    .sort((a, b) => {
      const ao = a.email.toLowerCase() === org;
      const bo = b.email.toLowerCase() === org;
      if (ao !== bo) return ao ? -1 : 1;
      return (a.connectedAt ?? '9').localeCompare(b.connectedAt ?? '9');
    });
}

export async function planForOccurrence(
  occ: OccurrenceFacts,
  opts: { users?: AutoSyncUser[]; series?: SeriesRow | null } = {}
): Promise<AutoPlan> {
  const users = opts.users ?? (await listAutoSyncUsers());
  const series = opts.series === undefined ? await seriesOwnerFor(occ) : opts.series;
  const interestedUsers = interestedAutoSyncUsers(occ, users);
  const org = occ.organizerEmail?.toLowerCase() ?? null;
  const interested = interestedUsers.map((u) => ({
    email: u.email,
    report: u.prefs.report,
    mode: u.prefs.mode,
    organiser: u.email.toLowerCase() === org,
  }));
  const base = {
    seriesId: series?.id ?? null,
    seriesTitle: series?.title ?? null,
    seriesOptedOut: !!series && !series.auto_import!.enabled,
    fallbackImporters: [] as AutoPlan['fallbackImporters'],
    interested,
  };

  if (series && series.auto_import) {
    const cfg = series.auto_import;
    if (!cfg.enabled) {
      return {
        ...base,
        owner: 'none',
        reason: `series "${series.title}" has auto-import switched off — an explicit opt-out that beats account auto-sync`,
        importer: null,
        mode: null,
        report: null,
        watchers: [],
      };
    }
    const enabler = cfg.byEmail.toLowerCase();
    return {
      ...base,
      owner: 'series',
      reason: `series "${series.title}" auto-import, enabled by ${cfg.byEmail}`,
      importer: { userId: cfg.byUserId, email: cfg.byEmail },
      mode: cfg.mode,
      report: strongestReport([cfg.report, ...interested.map((i) => i.report)]),
      watchers: interestedUsers.map((u) => u.email).filter((e) => e.toLowerCase() !== enabler),
    };
  }

  if (interestedUsers.length === 0) {
    return {
      ...base,
      owner: 'none',
      reason: 'nobody in the meeting has account auto-sync covering it (off, scope, provider or enabled after the meeting)',
      importer: null,
      mode: null,
      report: null,
      watchers: [],
    };
  }
  const electors = orderElectors(interestedUsers, org);
  if (electors.length === 0) {
    return {
      ...base,
      owner: 'none',
      reason: 'every interested auto-sync user has a revoked Google connection',
      importer: null,
      mode: null,
      report: null,
      watchers: [],
    };
  }
  const importer = electors[0]!;
  return {
    ...base,
    owner: 'account',
    reason: `account auto-sync — ${importer.email} elected (${importer.email.toLowerCase() === org ? 'organiser' : 'earliest-connected'})`,
    importer: { userId: importer.userId, email: importer.email },
    fallbackImporters: electors.slice(1).map((u) => ({ userId: u.userId, email: u.email })),
    mode: importer.prefs.mode,
    report: strongestReport(interestedUsers.map((u) => u.prefs.report)),
    watchers: interestedUsers.map((u) => u.email).filter((e) => e !== importer.email),
  };
}

export interface AutoPlanExplanation {
  occurrence: {
    code: string;
    startIso: string;
    provider: Provider;
    title: string | null;
    organizerEmail: string | null;
    attendees: string[];
    knownToCalendars: number;
  };
  plan: AutoPlan;
  /** What the ledgers say already happened (null = nothing yet). */
  ledger:
    | { kind: 'account'; outcome: AutoSyncLogRow['outcome']; importerEmail: string | null; assemblyaiId: string | null; detail: string | null; at: string }
    | { kind: 'series'; outcome: AutoImportLogRow['outcome']; seriesId: number; seriesTitle: string | null; assemblyaiId: string | null; detail: string | null; at: string }
    | null;
}

/** Facts + plan + ledger for one occurrence — the `auto-sync explain`
 * answer. NOT caller-scoped: gate with callerInvolvedCodes() first. */
export async function explainOccurrence(code: string, startIso: string): Promise<AutoPlanExplanation | null> {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  const iso = start.toISOString();
  const provider: Provider = code.startsWith('teams-') ? 'teams' : 'gmeet';
  const cal = await mergedCalendarOccurrence(code, iso);
  const facts: OccurrenceFacts = {
    code,
    startIso: iso,
    provider,
    title: cal?.title ?? null,
    organizerEmail: cal?.organizerEmail ?? null,
    attendees: cal?.attendees ?? [],
    recurringEventId: cal?.recurringEventId ?? null,
  };
  const plan = await planForOccurrence(facts);
  const occKey = `${code}|${iso}`;
  const [acct, ser] = await Promise.all([
    getAutoSyncLog([occKey]),
    plan.seriesId ? findAutoImportLogByStart(plan.seriesId, iso) : Promise.resolve(null),
  ]);
  const a = acct.get(occKey);
  const ledger: AutoPlanExplanation['ledger'] = a
    ? { kind: 'account', outcome: a.outcome, importerEmail: a.importer_email, assemblyaiId: a.assemblyai_id, detail: a.detail, at: a.updated_at }
    : ser
      ? { kind: 'series', outcome: ser.outcome, seriesId: ser.series_id, seriesTitle: plan.seriesTitle, assemblyaiId: ser.assemblyai_id, detail: ser.detail, at: ser.fired_at }
      : null;
  return {
    occurrence: {
      code,
      startIso: iso,
      provider,
      title: facts.title ?? null,
      organizerEmail: facts.organizerEmail ?? null,
      attendees: facts.attendees ?? [],
      knownToCalendars: cal?.holders.length ?? 0,
    },
    plan,
    ledger,
  };
}

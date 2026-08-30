import 'server-only';
import {
  getGoogleAccount,
  listPollableGoogleAccounts,
  markGoogleAccountPolled,
  markGoogleAccountStatus,
  type GoogleAccountRow,
} from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getSyncState, findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import {
  upsertReminder,
  listOpenRemindersRaw,
  resolveReminderByKey,
  type ReminderKind,
} from '@/db-ops/gmeet-reminders';
import { getMeetingCacheByKeys, getTeamsResolutionByKeys } from '@/db-ops/gmeet-meeting-cache';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { sweepAutoImportSeries } from '@/lib/server/series-auto-import';
import { sweepAccountAutoSync } from '@/lib/server/account-auto-sync';
import { classifyCalendarAttachments } from '@/lib/meeting-evidence';
import {
  isOwnTenant,
  parseTeamsJoinLink,
  threadIdFromJoinUrl,
  type TeamsJoinInfo,
} from '@/lib/teams-link';
import { teamsCacheCode } from '@/lib/server/teams-ids';
import {
  CalendarListError,
  eventStartIso,
  isMeetEvent,
  probeMeetingEvidence,
  syncCalendarWindow,
  teamsUrlOf,
} from '@/lib/server/meeting-discovery';
import type { DiscoveredEvent } from '@/lib/meeting-discovery-types';
import { GraphApiError, isGraphConfigured } from '@/lib/server/ms-graph';
import { probeTeamsEvidence } from '@/lib/server/teams-evidence';
import {
  fetchMsLinkStatusOne,
  isDarthTasksConfigured,
} from '@/lib/server/darth-tasks-client';
import { lookupAndPersistTeamsChat } from '@/lib/server/teams-chat-evidence';
import {
  CHAT_MIN_AGE_MS,
  chatCallEndMs,
  chatEvidenceWindow,
  needsChatLookup,
} from '@/lib/teams-chat-evidence';
import { findImportedOccurrences } from '@/db-ops/imported-occurrences';
import { markTeamsChatBackfilled } from '@/db-ops/google-accounts';
import { getMeetingCacheByMeetings } from '@/db-ops/gmeet-meeting-cache';

/**
 * Background sync-and-remind poller. Every POLL_MS, for each user with a
 * connected Google account, sweep their calendar:
 *
 *  - PAST Meet events (last LOOKBACK_DAYS) that nobody imported and that DO
 *    have a recording/transcript at Google → open an 'unimported' reminder.
 *    Importing stays a human act — the poller never imports anything.
 *  - PAST own-tenant TEAMS events (same window): resolve app-only via Graph,
 *    check artifacts, cache metadata, same 'unimported' reminders. The
 *    reminder's meeting_code carries the `teams-…` cache code — that prefix
 *    is the provider marker for the UI. External-tenant Teams events are
 *    skipped here (nothing to check without their tenant's consent); the
 *    dialog labels them straight from the join URL.
 *  - UPCOMING events (next LOOKAHEAD_H) the user ORGANIZES whose
 *    auto-recording/transcription/notes are ALL off → 'autorec_off' reminder
 *    (artifactConfig is only visible to the organizer, so this is exactly
 *    the set of meetings the user can actually fix).
 *
 * Also reconciles previously-open reminders (imported / muted / event passed
 * / config fixed → resolved). Serial across users; each user's sweep uses
 * only their own token; Teams artifact checks use the app-only Graph
 * credential (display/reminder metadata only — imports re-resolve fresh).
 */

const POLL_MS = Number(process.env.GMEET_POLL_MINUTES || 30) * 60 * 1000;
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_H = 24;
const MEET_API = 'https://meet.googleapis.com/v2';

type CalEvent = DiscoveredEvent;

async function apiJson<T>(token: string, url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.debug('[gmeet-poller] api miss', res.status, url.split('?')[0]);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.debug('[gmeet-poller] api error', url.split('?')[0], err);
    return null;
  }
}

/** Teams meetings scheduled from Google Calendar (GSuite add-on) carry the
 * meetup-join link in location / description / conference entry points. */
function teamsInfoOf(e: CalEvent): TeamsJoinInfo | null {
  const url = teamsUrlOf(e);
  return url ? parseTeamsJoinLink(url) : null;
}

/** Reminder kinds that mean "this occurrence is not in the app yet" — both
 * resolve the moment anyone imports (or the user mutes) the occurrence. */
const IMPORT_KINDS: ReminderKind[] = ['unimported', 'sync_requested'];

function eventKeyOf(code: string, startIso: string | null): string {
  return `${code}|${startIso ?? ''}`;
}

type ArtifactSetting = 'ON' | 'OFF' | undefined;

/** artifactConfig for a space — organizer-only; non-organizers get config
 * silently omitted (returns null → "unknown", never remind on unknown). */
async function getArtifactConfig(
  token: string,
  meetingCode: string
): Promise<{ rec: ArtifactSetting; trans: ArtifactSetting; notes: ArtifactSetting } | null> {
  const space = await apiJson<{
    config?: {
      artifactConfig?: {
        recordingConfig?: { autoRecordingGeneration?: string };
        transcriptionConfig?: { autoTranscriptionGeneration?: string };
        smartNotesConfig?: { autoSmartNotesGeneration?: string };
      };
    };
  }>(token, `${MEET_API}/spaces/${meetingCode}`);
  const a = space?.config?.artifactConfig;
  if (!a) return null;
  return {
    rec: a.recordingConfig?.autoRecordingGeneration as ArtifactSetting,
    trans: a.transcriptionConfig?.autoTranscriptionGeneration as ArtifactSetting,
    notes: a.smartNotesConfig?.autoSmartNotesGeneration as ArtifactSetting,
  };
}

/**
 * Teams half of a user's sweep — two independent parts:
 *
 *  1. ARTIFACTS (own tenant only, app-only Graph): past Teams meetings that
 *     nobody imported and that DO have artifacts at Microsoft →
 *     'unimported' reminders + the metadata cache row the check route
 *     serves. One resolution per occurrence ever (raw.teamsResolution);
 *     once both artifacts are known no Graph call is made at all.
 *  2. CHAT EVIDENCE (own tenant AND external, via Darth Tasks + the user's
 *     delegated Microsoft link): was the occurrence actually held / recorded
 *     — persisted as raw.teamsChat (sweepTeamsChat below), with a one-time
 *     60-day backfill on first sighting as linked (migration 028).
 */
async function sweepUserTeams(
  caller: { userId: string; email: string },
  events: CalEvent[],
  mutedKeys: Set<string>,
  now: number,
  ctx: { account: GoogleAccountRow; token: string }
): Promise<void> {
  await sweepTeamsArtifacts(caller, events, mutedKeys, now);
  try {
    await sweepTeamsChatForUser(caller, events, mutedKeys, now, ctx);
  } catch (err) {
    console.warn(`[gmeet-poller] teams chat sweep failed for ${caller.email}:`, err);
  }
}

async function sweepTeamsArtifacts(
  caller: { userId: string; email: string },
  events: CalEvent[],
  mutedKeys: Set<string>,
  now: number
): Promise<void> {
  if (!isGraphConfigured()) return;
  const past: Array<{ e: CalEvent; info: TeamsJoinInfo }> = [];
  for (const e of events) {
    const end = e.end?.dateTime ?? e.end?.date;
    if (!end || Date.parse(end) >= now - 15 * 60_000) continue;
    const info = teamsInfoOf(e);
    // External-tenant meetings are unreachable app-only — the dialog labels
    // them straight from the join URL; nothing to poll for.
    if (!info || !isOwnTenant(info)) continue;
    past.push({ e, info });
  }
  if (past.length === 0) return;

  const imported = await findImportedByTeamsMeetings(
    past.map(({ e, info }) => ({ joinWebUrl: info.joinWebUrl, startTime: eventStartIso(e) })),
    caller
  );
  const keys = past.map(({ e, info }) =>
    eventKeyOf(teamsCacheCode(info.joinWebUrl), eventStartIso(e))
  );
  const [cacheRows, resolutions] = await Promise.all([
    getMeetingCacheByKeys(keys),
    getTeamsResolutionByKeys(keys),
  ]);

  for (let i = 0; i < past.length; i++) {
    const { e, info } = past[i]!;
    const startIso = eventStartIso(e);
    const code = teamsCacheCode(info.joinWebUrl);
    const key = keys[i]!;
    if (imported[i]) {
      await resolveReminderByKey(caller.userId, IMPORT_KINDS, key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(caller.userId, IMPORT_KINDS, key, 'muted');
      continue;
    }

    // THE Teams probe (lib/server/teams-evidence) — shared with the
    // listing's / dialog's on-demand "Check…": resolves once, lists the
    // artifacts only while one is still missing, writes the cache row.
    let hasTranscript: boolean;
    let hasRecording: boolean;
    try {
      const probe = await probeTeamsEvidence({
        info,
        eventStart: startIso,
        eventEnd: e.end?.dateTime ?? e.end?.date ?? startIso,
        event: {
          recurringEventId: e.recurringEventId ?? null,
          iCalUID: e.iCalUID ?? null,
          organizerEmail: e.organizer?.email ?? null,
        },
        capturedBy: caller.userId,
        existing: cacheRows.get(key) ?? null,
        resolution: resolutions.get(key) ?? null,
      });
      if (!probe.resolved) continue; // deleted or never materialized — retry next sweep
      hasTranscript = probe.hasTranscript;
      hasRecording = probe.hasRecording;
      if (!hasTranscript && !hasRecording) continue; // nothing to remind about (yet)
    } catch (err) {
      if (err instanceof GraphApiError) {
        console.warn(
          '[gmeet-poller] teams artifact check failed for',
          key,
          err.status,
          err.code ?? ''
        );
        continue;
      }
      throw err;
    }
    await upsertReminder({
      userId: caller.userId,
      kind: 'unimported',
      eventKey: key,
      meetingCode: code,
      title: e.summary ?? null,
      eventStart: startIso,
      organizerSelf: e.organizer?.self ?? false,
      hasRecording,
      hasTranscript,
    });
  }
}

// ---------------------------------------------------------------------------
// Teams chat evidence sweep (own + external tenant, via Darth Tasks)
// ---------------------------------------------------------------------------

/** At most this many chat-call-events lookups per user sweep (regular window
 * and backfill share the budget; an unfinished backfill resumes next sweep). */
const CHAT_LOOKUP_CAP = 40;
const CHAT_BACKFILL_DAYS = 60;

interface ChatCandidate {
  e: CalEvent;
  info: TeamsJoinInfo;
  external: boolean;
  startIso: string;
  endIso: string | null;
}

/** Past Teams events (own-tenant AND external) old enough for a chat
 * verdict, deduped per occurrence, mutes excluded. */
function chatCandidatesOf(events: CalEvent[], mutedKeys: Set<string>, now: number): ChatCandidate[] {
  const seen = new Set<string>();
  const out: ChatCandidate[] = [];
  for (const e of events) {
    const endIso = e.end?.dateTime ?? e.end?.date ?? null;
    if (!endIso || Date.parse(endIso) >= now - CHAT_MIN_AGE_MS) continue;
    const info = teamsInfoOf(e);
    if (!info) continue;
    const startIso = eventStartIso(e);
    if (!startIso) continue;
    const code = teamsCacheCode(info.joinWebUrl);
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) continue;
    const key = eventKeyOf(code, startIso);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ e, info, external: !isOwnTenant(info), startIso, endIso });
  }
  return out;
}

interface ChatSweepStats {
  candidates: number;
  lookups: number;
  persisted: number;
  /** Lookups that persisted a failure reason (forbidden / throttled / …). */
  failedVerdicts: number;
  /** Needed a lookup but couldn't get one this sweep (budget exhausted or
   * plagueis unreachable) — nonzero means "not done, come back". */
  leftover: number;
  /** Candidates that can NEVER be asked (join URL with no parseable thread
   * id / bad start). Counted separately from leftover so a permanently
   * malformed event can't wedge the one-time backfill stamp — and checked
   * BEFORE spending budget, so they don't burn lookup slots either. */
  unaskable: number;
  /** Occurrences whose verdict is a TRANSIENT failure (throttled /
   * graph_error) still inside its retry backoff — fresh from this pass or
   * already cached. The backfill must not stamp while any exist: once
   * stamped nothing ever revisits occurrences older than the regular
   * 7-day window, which would freeze a throttling storm into the 60-day
   * history forever. */
  transientPending: number;
}

/** Failure reasons worth re-asking about (visibility can change; a Graph
 * hiccup passes). forbidden / not_found are treated as settled verdicts. */
const TRANSIENT_CHAT_REASONS = new Set(['throttled', 'graph_error']);

/** One pass over a candidate list: skip imported + fresh verdicts, spend the
 * shared budget on the rest, persist via lookupAndPersistTeamsChat. */
async function sweepTeamsChatEvents(
  caller: { userId: string; email: string },
  candidates: ChatCandidate[],
  budget: { left: number },
  now: number
): Promise<ChatSweepStats> {
  const stats: ChatSweepStats = {
    candidates: candidates.length,
    lookups: 0,
    persisted: 0,
    failedVerdicts: 0,
    leftover: 0,
    unaskable: 0,
    transientPending: 0,
  };
  if (candidates.length === 0) return stats;

  // Anything anyone already imported needs no held/recorded verdict — the
  // transcript itself is the evidence. Join URL ±12h plus the exact calendar
  // eventId (external occurrences are imported via linked uploads — D9).
  const imported = await findImportedOccurrences(
    candidates.map((c) => ({
      joinWebUrl: c.info.joinWebUrl,
      eventId: c.e.id,
      startTime: c.startIso,
    })),
    caller
  ).catch(() => candidates.map(() => null));
  const cacheRows = await getMeetingCacheByMeetings(
    candidates.map((c) => ({ code: teamsCacheCode(c.info.joinWebUrl), startTime: c.startIso })),
    { preferChat: true }
  ).catch(() => candidates.map(() => null));

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (imported[i]) continue;
    const existing = cacheRows[i] ?? null;
    const verdict = existing?.teams_chat ?? null;
    if (!needsChatLookup(verdict, chatCallEndMs(c.endIso, verdict), now)) {
      if (verdict?.reason && TRANSIENT_CHAT_REASONS.has(verdict.reason)) {
        stats.transientPending++;
      }
      continue;
    }
    if (!threadIdFromJoinUrl(c.info.joinWebUrl) || !chatEvidenceWindow(c.startIso, c.endIso)) {
      // lookupAndPersistTeamsChat could never even send this one — don't
      // spend budget on it, and don't let it block the backfill stamp.
      stats.unaskable++;
      continue;
    }
    if (budget.left <= 0) {
      stats.leftover++;
      continue;
    }
    budget.left--;
    stats.lookups++;
    const result = await lookupAndPersistTeamsChat({
      info: c.info,
      external: c.external,
      eventStart: c.startIso,
      eventEnd: c.endIso,
      email: caller.email,
      event: {
        recurringEventId: c.e.recurringEventId ?? null,
        iCalUID: c.e.iCalUID ?? null,
        organizerEmail: c.e.organizer?.email ?? null,
      },
      capturedBy: caller.userId,
      existing,
    });
    if (!result?.persisted) {
      // Plagueis unreachable, or it says this user isn't linked after all —
      // nothing written, retry next sweep.
      stats.leftover++;
    } else if (result.verdict.reason) {
      stats.failedVerdicts++;
      stats.persisted++;
      if (TRANSIENT_CHAT_REASONS.has(result.verdict.reason)) stats.transientPending++;
    } else {
      stats.persisted++;
    }
  }
  return stats;
}

/**
 * Chat half of a user's Teams sweep: one link-status call per sweep; if the
 * user's Microsoft link is active, verdicts for the regular window's Teams
 * events, then (until stamped) the one-time 60-day backfill — listed through
 * the same discovery service (maxPages 20, persists calendar rows) and
 * stamped only when every backfill occurrence has a verdict.
 */
async function sweepTeamsChatForUser(
  caller: { userId: string; email: string },
  events: CalEvent[],
  mutedKeys: Set<string>,
  now: number,
  ctx: { account: GoogleAccountRow; token: string }
): Promise<void> {
  if (!isDarthTasksConfigured()) return;
  const candidates = chatCandidatesOf(events, mutedKeys, now);
  const needsBackfill = !ctx.account.teams_chat_backfilled_at;
  if (candidates.length === 0 && !needsBackfill) return;

  const link = await fetchMsLinkStatusOne(caller.email);
  if (!link) return; // plagueis unreachable — try again next sweep
  if (!link.linked) return; // not connected (or revoked) — nothing to read with

  const budget = { left: CHAT_LOOKUP_CAP };
  const stats = await sweepTeamsChatEvents(caller, candidates, budget, now);

  let backfill: ChatSweepStats | null = null;
  // No point listing 60 days of calendar (up to 20 pages) when the regular
  // window already spent every lookup slot — nothing could be asked anyway;
  // the stamp resumes on a quieter sweep.
  if (needsBackfill && budget.left > 0) {
    try {
      // Only the part of the 60 days the regular window doesn't cover.
      const bfEvents = await syncCalendarWindow(caller.userId, ctx.token, {
        from: new Date(now - CHAT_BACKFILL_DAYS * 86_400_000).toISOString(),
        to: new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString(),
        maxPages: 20,
      });
      backfill = await sweepTeamsChatEvents(
        caller,
        chatCandidatesOf(bfEvents, mutedKeys, now),
        budget,
        now
      );
      // Stamp only when NOTHING remains to ask: no budget/transport
      // leftovers AND no transient failure verdicts awaiting their retry —
      // after the stamp nothing ever revisits these occurrences.
      if (backfill.leftover === 0 && backfill.transientPending === 0) {
        await markTeamsChatBackfilled(caller.userId);
      }
    } catch (err) {
      console.warn(`[gmeet-poller] teams chat backfill listing failed for ${caller.email}:`, err);
    }
  }

  const fmt = (s: ChatSweepStats) =>
    `${s.lookups} lookups, ${s.persisted} persisted (${s.failedVerdicts} failed verdicts), ` +
    `${s.leftover} leftover, ${s.unaskable} unaskable, ${s.transientPending} transient of ${s.candidates}`;
  if (stats.lookups > 0 || stats.leftover > 0 || backfill) {
    console.log(
      `[gmeet-poller] teams chat for ${caller.email}: ${fmt(stats)}` +
        (backfill
          ? `; backfill: ${fmt(backfill)}${
              backfill.leftover === 0 && backfill.transientPending === 0 ? ' — stamped' : ''
            }`
          : '')
    );
  }
}

async function sweepUser(account: GoogleAccountRow): Promise<void> {
  const minted = await getServerAccessToken(account.user_id);
  if (!minted) return; // revoked / transient failure — status already recorded
  const token = minted.token;
  const userId = account.user_id;
  const caller = { userId, email: account.user_email };

  // The discovery service lists the window AND persists every timed event
  // (Meet or not) into the per-user calendar cache — the "no recording"
  // listing view reads from there. Same code path the dialog's day view and
  // the manual "Sync now" use.
  // A refused calendar listing (scope revoked, 403) is recorded on the
  // account (Settings card / google status) and last_poll_at is NOT stamped
  // — the listing's "Cal synced Nm ago" chip going stale is the honest
  // signal. Reminder reconciliation below still runs on an empty window.
  let calendarFailed: CalendarListError | null = null;
  const [allEvents, { skips }, openReminders] = await Promise.all([
    syncCalendarWindow(userId, token, {
      from: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString(),
      to: new Date(Date.now() + LOOKAHEAD_H * 3_600_000).toISOString(),
    }).catch((err: unknown) => {
      if (err instanceof CalendarListError) {
        calendarFailed = err;
        return [];
      }
      throw err;
    }),
    getSyncState(userId),
    listOpenRemindersRaw(userId),
  ]);
  if (calendarFailed) {
    const failed: CalendarListError = calendarFailed;
    console.warn(`[gmeet-poller] calendar listing failed for ${account.user_email}: ${failed.status}`);
    await markGoogleAccountStatus(userId, 'error', `calendar listing failed (${failed.status})`);
  }

  const events = allEvents.filter(isMeetEvent);
  const mutedKeys = new Set(skips.map((s) => s.event_key));
  const now = Date.now();

  // ---- past events → 'unimported' reminders -------------------------------
  const past = events.filter((e) => {
    const end = e.end?.dateTime ?? e.end?.date;
    return end ? Date.parse(end) < now - 15 * 60_000 : false;
  });
  const pastMeetings = past.map((e) => ({
    code: e.conferenceData!.conferenceId!,
    startTime: eventStartIso(e),
  }));
  const imported = await findImportedByMeetingCodes(pastMeetings, caller);
  const cacheRows = await getMeetingCacheByKeys(
    pastMeetings.map((m) => eventKeyOf(m.code, m.startTime))
  );

  for (let i = 0; i < past.length; i++) {
    const e = past[i]!;
    const code = pastMeetings[i]!.code;
    const startIso = pastMeetings[i]!.startTime;
    const key = eventKeyOf(code, startIso);
    if (imported[i]) {
      await resolveReminderByKey(userId, IMPORT_KINDS, key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(userId, IMPORT_KINDS, key, 'muted');
      continue;
    }
    // Meeting artifacts only appear a while after the call ends; re-probed
    // every poll until the event ages out of the window. The probe folds
    // calendar attachments in (the ONLY evidence once the Meet record ages
    // out, and the only evidence Gemini-notes-only meetings ever get — D1)
    // and writes the classified verdict back to the artifact cache itself.
    const { verdict } = await probeMeetingEvidence(token, {
      userId,
      meetingCode: code,
      eventStart: startIso,
      attachments: classifyCalendarAttachments(e.attachments),
      event: {
        recurringEventId: e.recurringEventId ?? null,
        iCalUID: e.iCalUID ?? null,
        organizerEmail: e.organizer?.email ?? null,
      },
      existing: cacheRows.get(key) ?? null,
    });
    // Nothing held / nothing captured / nothing attached — nothing to track.
    if (!verdict.importable) continue;
    // Remind only once something is actually materialized — a still-
    // generating artifact will be ready by a later sweep; nagging early
    // invites a doomed import click.
    const hasRecording = verdict.hasRecording;
    const hasTranscript = verdict.hasTranscript;
    if (!hasRecording && !hasTranscript) continue;
    await upsertReminder({
      userId,
      kind: 'unimported',
      eventKey: key,
      meetingCode: code,
      title: e.summary ?? null,
      eventStart: startIso,
      organizerSelf: e.organizer?.self ?? false,
      hasRecording,
      hasTranscript,
    });
  }

  // ---- upcoming organized events → 'autorec_off' reminders ----------------
  const upcoming = events.filter((e) => {
    const start = eventStartIso(e);
    return start !== null && Date.parse(start) > now && e.organizer?.self === true;
  });
  for (const e of upcoming) {
    const code = e.conferenceData!.conferenceId!;
    const startIso = eventStartIso(e);
    const key = eventKeyOf(code, startIso);
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) continue;
    const cfg = await getArtifactConfig(token, code);
    if (!cfg) continue; // config invisible → we're not really the organizer; stay quiet
    const anythingOn = cfg.rec === 'ON' || cfg.trans === 'ON' || cfg.notes === 'ON';
    if (anythingOn) {
      await resolveReminderByKey(userId, 'autorec_off', key, 'config_on');
    } else {
      await upsertReminder({
        userId,
        kind: 'autorec_off',
        eventKey: key,
        meetingCode: code,
        title: e.summary ?? null,
        eventStart: startIso,
        organizerSelf: true,
        hasRecording: false,
        hasTranscript: false,
      });
    }
  }

  // ---- Teams events (own tenant) → 'unimported' reminders + cache ---------
  try {
    await sweepUserTeams(caller, allEvents, mutedKeys, now, { account, token });
  } catch (err) {
    console.warn(`[gmeet-poller] teams sweep failed for ${account.user_email}:`, err);
  }

  // ---- reconcile older open reminders -------------------------------------
  // 'autorec_off' whose meeting already started is moot; stale 'unimported'
  // rows (outside the calendar window) still get import/mute resolution so a
  // colleague importing a 3-week-old meeting clears everyone's reminder.
  // Teams reminders (meeting_code `teams-…`) resolve through the cache row's
  // stored join URL instead of the Meet meeting-code lookup.
  const staleUnimported: Array<{ key: string; code: string; start: string | null }> = [];
  const staleTeams: Array<{ key: string; start: string | null }> = [];
  for (const r of openReminders) {
    if (r.kind === 'autorec_off') {
      if (r.event_start && Date.parse(r.event_start) < now) {
        await resolveReminderByKey(userId, 'autorec_off', r.event_key, 'expired');
      }
      continue;
    }
    if (mutedKeys.has(r.meeting_code ?? '') || mutedKeys.has(r.event_key)) {
      await resolveReminderByKey(userId, IMPORT_KINDS, r.event_key, 'muted');
      continue;
    }
    if (r.meeting_code?.startsWith('teams-')) {
      staleTeams.push({ key: r.event_key, start: r.event_start });
    } else if (r.meeting_code) {
      staleUnimported.push({ key: r.event_key, code: r.meeting_code, start: r.event_start });
    }
  }
  if (staleUnimported.length > 0) {
    const found = await findImportedByMeetingCodes(
      staleUnimported.map((s) => ({ code: s.code, startTime: s.start })),
      caller
    );
    for (let i = 0; i < staleUnimported.length; i++) {
      if (found[i]) {
        await resolveReminderByKey(userId, IMPORT_KINDS, staleUnimported[i]!.key, 'imported');
      }
    }
  }
  if (staleTeams.length > 0) {
    const resolutions = await getTeamsResolutionByKeys(staleTeams.map((s) => s.key));
    const withUrl = staleTeams.filter((s) => resolutions.get(s.key)?.joinWebUrl);
    if (withUrl.length > 0) {
      const found = await findImportedByTeamsMeetings(
        withUrl.map((s) => ({
          joinWebUrl: resolutions.get(s.key)!.joinWebUrl,
          startTime: s.start,
        })),
        caller
      );
      for (let i = 0; i < withUrl.length; i++) {
        if (found[i]) {
          await resolveReminderByKey(userId, IMPORT_KINDS, withUrl[i]!.key, 'imported');
        }
      }
    }
  }

  if (!calendarFailed) await markGoogleAccountPolled(userId);
}

let started = false;
let sweeping = false;

async function sweepAll(): Promise<void> {
  if (sweeping) return; // a slow sweep must not stack onto the next tick
  sweeping = true;
  try {
    const accounts = await listPollableGoogleAccounts();
    for (const account of accounts) {
      try {
        await sweepUser(account);
      } catch (err) {
        console.warn(`[gmeet-poller] sweep failed for ${account.user_email}:`, err);
      }
    }
    if (accounts.length > 0) {
      console.log(`[gmeet-poller] swept ${accounts.length} account(s)`);
    }
    // Series auto-import rides the same 30-minute cadence — after the
    // per-account sweeps so freshly-cached calendar data is available.
    await sweepAutoImportSeries();
    // Account-level auto-sync (T2) LAST: it consumes the 'unimported'
    // reminders the per-account sweeps just refreshed, and lets per-series
    // auto-import claim its occurrences first.
    await sweepAccountAutoSync();
  } catch (err) {
    console.warn('[gmeet-poller] sweep pass failed:', err);
  } finally {
    sweeping = false;
  }
}

export function startGmeetPoller(): void {
  if (started) return;
  started = true;
  console.log(`[gmeet-poller] armed: every ${POLL_MS / 60000}m`);
  const timer = setInterval(() => void sweepAll(), POLL_MS);
  timer.unref?.();
  // First pass shortly after boot.
  setTimeout(() => void sweepAll(), 2 * 60 * 1000).unref?.();
}

/** One immediate pass — used by the manual "poll now" hook in dev/testing. */
export function triggerGmeetPoll(): Promise<void> {
  return sweepAll();
}

/**
 * Immediate first sweep for a just-connected account. The 30-minute tick is
 * far too slow for the post-connect experience — until last_poll_at lands,
 * the listing shows a "still syncing" banner and the calendar layers look
 * misleadingly empty. Fire-and-forget from the OAuth callback.
 */
export async function sweepNewAccount(userId: string): Promise<void> {
  try {
    const account = await getGoogleAccount(userId);
    if (!account) return;
    await sweepUser(account);
  } catch (err) {
    console.warn('[gmeet-poller] post-connect sweep failed:', err);
  }
}

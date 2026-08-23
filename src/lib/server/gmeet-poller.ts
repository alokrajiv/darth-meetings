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
} from '@/db-ops/gmeet-reminders';
import { getMeetingCacheByKeys, getTeamsResolutionByKeys } from '@/db-ops/gmeet-meeting-cache';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { sweepAutoImportSeries } from '@/lib/server/series-auto-import';
import { classifyCalendarAttachments } from '@/lib/meeting-evidence';
import { isOwnTenant, parseTeamsJoinLink, type TeamsJoinInfo } from '@/lib/teams-link';
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
 * Teams half of a user's sweep: past own-tenant Teams meetings that nobody
 * imported and that DO have artifacts at Microsoft → 'unimported' reminders,
 * plus the metadata cache row the check route serves. App-only Graph; one
 * resolution per occurrence ever (cached in raw.teamsResolution), and once
 * both artifacts are known no Graph call is made at all.
 */
async function sweepUserTeams(
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
      await resolveReminderByKey(caller.userId, 'unimported', key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(caller.userId, 'unimported', key, 'muted');
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
      await resolveReminderByKey(userId, 'unimported', key, 'imported');
      continue;
    }
    if (mutedKeys.has(code) || mutedKeys.has(e.id)) {
      await resolveReminderByKey(userId, 'unimported', key, 'muted');
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
    await sweepUserTeams(caller, allEvents, mutedKeys, now);
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
      await resolveReminderByKey(userId, 'unimported', r.event_key, 'muted');
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
        await resolveReminderByKey(userId, 'unimported', staleUnimported[i]!.key, 'imported');
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
          await resolveReminderByKey(userId, 'unimported', withUrl[i]!.key, 'imported');
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

import 'server-only';
import {
  listPollableGoogleAccounts,
  markGoogleAccountPolled,
  type GoogleAccountRow,
} from '@/db-ops/google-accounts';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { getSyncState, findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import {
  upsertReminder,
  listOpenRemindersRaw,
  resolveReminderByKey,
} from '@/db-ops/gmeet-reminders';
import { findConferenceRecordName } from '@/lib/server/gmeet';

/**
 * Background sync-and-remind poller. Every POLL_MS, for each user with a
 * connected Google account, sweep their calendar:
 *
 *  - PAST Meet events (last LOOKBACK_DAYS) that nobody imported and that DO
 *    have a recording/transcript at Google → open an 'unimported' reminder.
 *    Importing stays a human act — the poller never imports anything.
 *  - UPCOMING events (next LOOKAHEAD_H) the user ORGANIZES whose
 *    auto-recording/transcription/notes are ALL off → 'autorec_off' reminder
 *    (artifactConfig is only visible to the organizer, so this is exactly
 *    the set of meetings the user can actually fix).
 *
 * Also reconciles previously-open reminders (imported / muted / event passed
 * / config fixed → resolved). Serial across users; each user's sweep uses
 * only their own token.
 */

const POLL_MS = Number(process.env.GMEET_POLL_MINUTES || 30) * 60 * 1000;
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_H = 24;
const MEET_API = 'https://meet.googleapis.com/v2';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

interface CalEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; self?: boolean };
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: { key?: { type?: string } };
  };
}

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

async function listMeetEvents(token: string): Promise<CalEvent[]> {
  const timeMin = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(Date.now() + LOOKAHEAD_H * 3_600_000).toISOString();
  const events: CalEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const json = await apiJson<{ items?: CalEvent[]; nextPageToken?: string }>(
      token,
      `${CAL_API}/calendars/primary/events?${params}`
    );
    if (!json) break;
    events.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return events.filter(
    (e) =>
      e.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet' &&
      MEET_CODE_RE.test(e.conferenceData?.conferenceId ?? '')
  );
}

function eventStartIso(e: CalEvent): string | null {
  return e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
}

function eventKeyOf(code: string, startIso: string | null): string {
  return `${code}|${startIso ?? ''}`;
}

/** recordings/transcripts existence on the conference record — the signal
 * that there is actually something to import. */
async function checkArtifacts(
  token: string,
  recordName: string
): Promise<{ hasRecording: boolean; hasTranscript: boolean }> {
  const [recs, trans] = await Promise.all([
    apiJson<{ recordings?: unknown[] }>(token, `${MEET_API}/${recordName}/recordings`),
    apiJson<{ transcripts?: unknown[] }>(token, `${MEET_API}/${recordName}/transcripts`),
  ]);
  return {
    hasRecording: (recs?.recordings?.length ?? 0) > 0,
    hasTranscript: (trans?.transcripts?.length ?? 0) > 0,
  };
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

async function sweepUser(account: GoogleAccountRow): Promise<void> {
  const minted = await getServerAccessToken(account.user_id);
  if (!minted) return; // revoked / transient failure — status already recorded
  const token = minted.token;
  const userId = account.user_id;
  const caller = { userId, email: account.user_email };

  const [events, { skips }, openReminders] = await Promise.all([
    listMeetEvents(token),
    getSyncState(userId),
    listOpenRemindersRaw(userId),
  ]);
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
    // Meeting artifacts only appear a while after the call ends; re-checked
    // every poll until the event ages out of the window.
    const recordName = await findConferenceRecordName(token, code, startIso ?? undefined);
    if (!recordName) continue; // never held or nothing captured — nothing to nag about
    const { hasRecording, hasTranscript } = await checkArtifacts(token, recordName);
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

  // ---- reconcile older open reminders -------------------------------------
  // 'autorec_off' whose meeting already started is moot; stale 'unimported'
  // rows (outside the calendar window) still get import/mute resolution so a
  // colleague importing a 3-week-old meeting clears everyone's reminder.
  const staleUnimported: Array<{ key: string; code: string; start: string | null }> = [];
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
    if (r.meeting_code) {
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

  await markGoogleAccountPolled(userId);
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

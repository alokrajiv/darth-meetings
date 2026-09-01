import 'server-only';
import {
  listAutoSyncUsers,
  getAutoSyncLog,
  claimAutoSync,
  settleAutoSync,
  type AutoSyncUser,
  type AutoSyncLogRow,
} from '@/db-ops/user-prefs';
import {
  listOpenUnimportedForUsers,
  resolveReminderByKey,
  upsertReminder,
  type UnimportedCandidateRow,
} from '@/db-ops/gmeet-reminders';
import {
  findCalendarEventByOccurrence,
  type CalendarEventImportRow,
} from '@/db-ops/calendar-event-cache';
import {
  getMeetingCacheByMeetings,
  getTeamsJoinUrlByMeeting,
  type GmeetMeetingCacheRow,
} from '@/db-ops/gmeet-meeting-cache';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import { findImportedByTeamsMeetings } from '@/db-ops/teams-import';
import { getAnyByAssemblyaiId } from '@/db-ops/transcripts';
import { addShare } from '@/db-ops/transcript-shares';
import { identityForUser, userIdForEmail } from '@/db-ops/transcript-activity';
import { findSeriesByKeys, getSeries } from '@/db-ops/series';
import { recurringBaseId, type SeriesKeyInput } from '@/lib/series-keys';
import { getServerAccessToken } from '@/lib/server/google-oauth';
import { executeGmeetImport } from '@/lib/server/gmeet-import-core';
import { executeTeamsImport } from '@/lib/server/teams-import-core';
import { AUTO_SHARE_DOMAINS } from '@/lib/server/auto-share';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';
import { dm, meetingLine, openLink, SETTINGS_LINK } from '@/lib/server/dm-copy';
import type { GmeetContext } from '@/lib/format';

/**
 * Account-level auto-sync (T2): "import everything I'm in", deduped across
 * users so N people with the switch on cost ONE import.
 *
 * Input is deliberately NOT a calendar listing of its own: the per-user
 * poller sweeps (gmeet-poller.sweepUser, each under the user's own token)
 * already reduce every past occurrence to an OPEN 'unimported' reminder
 * when artifacts exist and nobody visible imported it. This sweep takes
 * those reminders for every auto-sync user, groups them by occurrence
 * ('<code>|<startIso>'), and per occurrence:
 *
 *  1. filters by each user's scope (mine = organiser only / all), `since`
 *     (enable-time — never backfills history), provider switches, mode
 *     (needs a listed artifact the mode wants) and mutes (already applied
 *     in the query);
 *  2. defers to per-series auto-import when the occurrence belongs to a
 *     series with an explicit setting (on → the series sweep owns it, off →
 *     explicit opt-out wins over the account switch);
 *  3. ELECTS ONE IMPORTER — organiser first (owns the Drive artifacts), then
 *     earliest-connected Google account — pre-checks that their token can
 *     actually open the Doc / recording (Drive files.get), and fires ONE
 *     deferred+background import through the same execute cores the dialog
 *     and CLI use. Everyone else becomes a WATCHER: shared onto the row and
 *     DM'd alongside the importer. The auto_sync_log PK is the claim — a
 *     second process can't fire the same occurrence.
 *  4. 409 (someone imported it by hand meanwhile) → share the existing row
 *     with the electors, no import. No elector's token can reach the
 *     artifacts → the organiser gets ONE 'sync_requested' reminder + Slack
 *     DM ("colleagues need your import"), re-checked daily.
 *
 * Privacy: shares only ever go to users whose OWN calendar listed the
 * occurrence (that is what produced their reminder) — the same population
 * the existing auto-share-to-invitees rule already covers.
 */

const FAILED_RETRY_MS = 12 * 3600 * 1000;
const NUDGE_RETRY_MS = 24 * 3600 * 1000;
const MAX_FIRES_PER_PASS = 6;
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

type Caller = { userId: string; email: string };
type Elector = {
  user: AutoSyncUser;
  row: UnimportedCandidateRow;
  /** Admitted only because the recording may still be generating — dropped
   * unless the cache confirms it is (see the preparing gate below). */
  needsPreparing?: boolean;
};

interface Group {
  key: string;
  code: string;
  startIso: string;
  title: string | null;
  provider: 'gmeet' | 'teams';
  electors: Elector[];
  /** Occurrence's artifact-cache row (matched by code+instant — cache
   * event_keys are per-user-tz flavoured, never the normalized occ key). */
  cacheRow: GmeetMeetingCacheRow | null;
}

function retryable(prior: AutoSyncLogRow | undefined, now: number): boolean {
  if (!prior) return true;
  if (prior.outcome === 'imported' || prior.outcome === 'deferred' || prior.outcome === 'already')
    return false;
  const age = now - new Date(prior.updated_at).getTime();
  return age > (prior.outcome === 'failed' ? FAILED_RETRY_MS : NUDGE_RETRY_MS);
}

export async function sweepAccountAutoSync(): Promise<void> {
  let users: AutoSyncUser[];
  try {
    users = await listAutoSyncUsers();
  } catch (err) {
    console.warn('[auto-sync] listing users failed:', err);
    return;
  }
  if (users.length === 0) return;
  const byId = new Map(users.map((u) => [u.userId, u]));

  let cands: UnimportedCandidateRow[];
  try {
    cands = await listOpenUnimportedForUsers(users.map((u) => u.userId));
  } catch (err) {
    console.warn('[auto-sync] listing candidates failed:', err);
    return;
  }
  const now = Date.now();

  // ---- group by occurrence, applying each user's own switches ------------
  const groups = new Map<string, Group>();
  for (const row of cands) {
    const user = byId.get(row.user_id);
    if (!user || !row.meeting_code || !row.event_start) continue;
    const p = user.prefs;
    if (p.scope === 'mine' && !row.organizer_self) continue;
    const startMs = new Date(row.event_start).getTime();
    if (p.since && startMs <= Date.parse(p.since)) continue;
    const provider: 'gmeet' | 'teams' = row.meeting_code.startsWith('teams-') ? 'teams' : 'gmeet';
    if (!p.providers[provider]) continue;
    const wantVideo = p.mode !== 'transcript';
    const wantTranscript = p.mode !== 'video';
    const firm = (wantVideo && row.has_recording) || (wantTranscript && row.has_transcript);
    // Video-mode users whose occurrence only has its transcript so far are
    // admitted PROVISIONALLY: when the provider says the recording is still
    // generating, the deferred import fires NOW — the claim lands early
    // ("locked in"), the defer- placeholder mints the meeting's uuid, and
    // the poller attaches the video when Google finishes it. Without a
    // preparing signal they're dropped below (a recording that never
    // existed would just make a dead 6h placeholder).
    const provisional = !firm && wantVideo && row.has_transcript;
    if (!firm && !provisional) continue;
    // NORMALISED occurrence key: reminders carry each user's OWN calendar
    // timezone in their event_key ('…|11:30:00+05:30' vs '…|14:00:00+08:00'
    // for the same instant), so grouping on the raw key would give every
    // timezone its own import — exactly the duplicate this sweep exists to
    // prevent. Per-user keys stay on the elector rows for reminder resolution.
    const startIso = new Date(row.event_start).toISOString();
    const key = `${row.meeting_code}|${startIso}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        code: row.meeting_code,
        startIso,
        title: row.title,
        provider,
        electors: [],
        cacheRow: null,
      };
      groups.set(key, g);
    }
    g.electors.push({ user, row, needsPreparing: provisional });
  }
  if (groups.size === 0) return;

  // One batch cache lookup for every group (also feeds fireGroup — the old
  // per-group exact-key lookup silently never matched). Provisional electors
  // survive only when the cache says the recording is generating, with the
  // same 24h freshness guard the calendar layer's recording_preparing uses.
  {
    const list = [...groups.values()];
    const cacheRows = await getMeetingCacheByMeetings(
      list.map((g) => ({ code: g.code, startTime: g.startIso }))
    ).catch(() => list.map(() => null));
    for (let i = 0; i < list.length; i++) {
      const g = list[i]!;
      g.cacheRow = cacheRows[i] ?? null;
      const recPreparing =
        g.cacheRow?.recording_state === 'generating' &&
        Date.parse(g.startIso) > now - 24 * 3600 * 1000;
      if (!recPreparing) g.electors = g.electors.filter((e) => !e.needsPreparing);
      if (g.electors.length === 0) groups.delete(g.key);
    }
  }
  if (groups.size === 0) return;

  const log = await getAutoSyncLog([...groups.keys()]);
  // Oldest first so a backlog drains in order across passes.
  const ordered = [...groups.values()].sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));

  let fired = 0;
  for (const g of ordered) {
    if (fired >= MAX_FIRES_PER_PASS) break;
    const prior = log.get(g.key);
    if (!retryable(prior, now)) continue;
    try {
      if (await seriesOwnsOrOptsOut(g)) continue;
      // Organiser first (owns the artifacts), then earliest-connected.
      g.electors.sort((a, b) => {
        if (a.row.organizer_self !== b.row.organizer_self) return a.row.organizer_self ? -1 : 1;
        return (a.user.connectedAt ?? '9').localeCompare(b.user.connectedAt ?? '9');
      });
      const usable = g.electors.filter((e) => e.user.googleStatus !== 'revoked');
      if (usable.length === 0) continue;
      const claimed = await claimAutoSync({
        occKey: g.key,
        meetingCode: g.code,
        occStart: g.startIso,
        title: g.title,
        importerUserId: usable[0]!.user.userId,
        importerEmail: usable[0]!.user.email,
        watchers: usable.slice(1).map((e) => e.user.email),
        retryableBefore: new Date(now - (prior?.outcome === 'failed' ? FAILED_RETRY_MS : NUDGE_RETRY_MS)),
      });
      if (!claimed) continue; // another writer holds it
      fired += 1;
      await fireGroup(g, usable, now);
    } catch (err) {
      console.warn(`[auto-sync] ${g.key} failed:`, err);
      await settleAutoSync(g.key, {
        outcome: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    }
  }
  if (fired > 0) console.log(`[auto-sync] pass: ${groups.size} candidate occurrence(s), ${fired} acted on`);
}

/** A series with an explicit auto-import setting owns its occurrences:
 * enabled → the series sweep fires it (its own mode/report), disabled →
 * explicit opt-out beats the account switch. */
async function seriesOwnsOrOptsOut(g: Group): Promise<boolean> {
  const keys: SeriesKeyInput[] = [];
  if (g.provider === 'gmeet') keys.push({ kind: 'meeting-code', value: g.code });
  else {
    const url = await getTeamsJoinUrlByMeeting(g.code, g.startIso).catch(() => null);
    if (url) keys.push({ kind: 'teams-join-url', value: url });
  }
  const rec = g.electors.find((e) => e.row.recurring_event_id)?.row.recurring_event_id;
  if (rec) keys.push({ kind: 'recurring-base-id', value: recurringBaseId(rec) });
  if (keys.length === 0) return false;
  const hits = await findSeriesByKeys(keys);
  for (const h of hits) {
    const s = await getSeries(h.series_id);
    if (s?.auto_import) return true; // enabled or explicitly off — either way not ours
  }
  return false;
}

/** Can this token open the artifacts the mode needs? null = unknown ids
 * (nothing cached to probe) — let the import decide. */
async function canReachArtifacts(
  token: string,
  ids: { docId: string | null; videoId: string | null },
  mode: 'transcript' | 'video' | 'both'
): Promise<boolean | null> {
  const need: string[] = [];
  if (mode !== 'video' && ids.docId) need.push(ids.docId);
  if (mode !== 'transcript' && ids.videoId) need.push(ids.videoId);
  if (need.length === 0) return null;
  for (const id of need) {
    try {
      const res = await fetch(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 403 || res.status === 404) return false;
    } catch {
      return null; // transient — don't disqualify the elector
    }
  }
  return true;
}

function eventFrom(g: Group, cal: CalendarEventImportRow | null) {
  return {
    id: cal?.event_id ?? undefined,
    title: (cal?.title ?? g.title) ?? undefined,
    startTime: cal ? new Date(cal.event_start).toISOString() : g.startIso,
    endTime: cal?.event_end ? new Date(cal.event_end).toISOString() : undefined,
    meetingCode: g.provider === 'gmeet' ? g.code : undefined,
    recurringEventId: cal?.recurring_event_id ?? undefined,
    iCalUID: cal?.ical_uid ?? undefined,
    organizerEmail: cal?.organizer_email ?? undefined,
    attendees: cal?.attendees ?? undefined,
  };
}

function isAccessError(status: number, error: string): boolean {
  if (status === 403 || status === 404) return true;
  return /permission|forbidden|not found|no access|403|404/i.test(error);
}

async function fireGroup(g: Group, electors: Elector[], now: number): Promise<void> {
  const watchersOf = (importer: Elector) =>
    electors.filter((e) => e !== importer).map((e) => e.user.email);
  const cacheRow = g.cacheRow;
  const teamsUrl = g.provider === 'teams' ? await getTeamsJoinUrlByMeeting(g.code, g.startIso) : null;
  if (g.provider === 'teams' && !teamsUrl) {
    await settleAutoSync(g.key, { outcome: 'failed', detail: 'no Teams join URL resolved yet' });
    return;
  }

  let lastErr: { status: number; error: string; access: boolean } | null = null;
  let organizerEmail: string | null = null;
  for (const importer of electors) {
    const caller: Caller = { userId: importer.user.userId, email: importer.user.email };
    const cal = await findCalendarEventByOccurrence(caller.userId, g.code, g.startIso).catch(() => null);
    organizerEmail = organizerEmail ?? cal?.organizer_email ?? cacheRow?.organizer_email ?? null;
    const mode = importer.user.prefs.mode;
    const event = eventFrom(g, cal);
    const contextExtra: NonNullable<Parameters<typeof executeGmeetImport>[1]['contextExtra']> = {
      autoSync: {
        occKey: g.key,
        byUserId: caller.userId,
        byEmail: caller.email,
        watchers: watchersOf(importer),
        at: new Date(now).toISOString(),
      },
      uploadPrefs: { report: importer.user.prefs.report },
    };

    let outcome: { status: number; body: Record<string, unknown> };
    try {
      if (g.provider === 'teams') {
        outcome = await executeTeamsImport(caller, {
          url: teamsUrl!,
          mode,
          defer: true,
          background: true,
          event,
          contextExtra,
        });
      } else {
        const minted = await getServerAccessToken(caller.userId);
        if (!minted) {
          lastErr = { status: 0, error: `${caller.email}: Google not connected`, access: true };
          continue;
        }
        const docId = cal?.attachment_transcript_doc_id ?? cacheRow?.transcript_doc_ids?.[0] ?? null;
        const videoId = cal?.attachment_video_file_id ?? cacheRow?.video_file_id ?? null;
        const reach = await canReachArtifacts(minted.token, { docId, videoId }, mode);
        if (reach === false) {
          lastErr = { status: 403, error: `${caller.email}: no access to the artifacts`, access: true };
          continue;
        }
        outcome = await executeGmeetImport(caller, {
          accessToken: minted.token,
          mode,
          videoFileId: videoId ?? undefined,
          transcriptDocId: docId ?? undefined,
          defer: true,
          background: true,
          event,
          contextExtra,
        });
      }
    } catch (err) {
      outcome = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }

    const errText = typeof outcome.body.error === 'string' ? outcome.body.error : `status ${outcome.status}`;
    const transcript = outcome.body.transcript as { assemblyai_id?: string; id?: number } | undefined;

    if (outcome.status === 201 || outcome.status === 202) {
      const kind = outcome.status === 201 ? 'imported' : 'deferred';
      await settleAutoSync(g.key, {
        outcome: kind,
        assemblyaiId: transcript?.assemblyai_id ?? null,
        importerUserId: caller.userId,
        importerEmail: caller.email,
        detail: null,
      });
      if (transcript?.assemblyai_id) {
        await ensureSharedWith(transcript.assemblyai_id, watchersOf(importer));
      }
      await resolveAll(electors, g.key, 'auto_synced');
      const link = await openLink(transcript?.assemblyai_id ?? null, 'Open the meeting');
      const dur = cal?.event_end ? (Date.parse(cal.event_end) - Date.parse(cal.event_start as unknown as string)) / 1000 : null;
      const line = meetingLine({ title: g.title, when: g.startIso, duration: dur });
      const report =
        importer.user.prefs.report === 'summary' ? 'summary'
          : importer.user.prefs.report === 'later' ? 'notes' : 'detailed report';
      const status =
        kind === 'imported'
          ? `Imported — speakers are being identified; the ${report} follows once they're confirmed.`
          : `Queued — the recording/transcript is still being generated. It lands on its own; nothing to do.`;
      void notifyUser({
        kind: 'auto_import',
        toEmail: caller.email,
        text: dm(`⚡ *Auto-sync picked up your meeting*`, line, status, link),
        dedupeKey: `mw-autosync:${g.key}:${caller.email}`,
      });
      for (const w of watchersOf(importer)) {
        void notifyUser({
          kind: 'auto_import',
          toEmail: w,
          text: dm(
            `⚡ *Auto-sync picked up a meeting you were in*`,
            line,
            status,
            `Imported once, via ${caller.email}'s Google connection, and shared with you — no duplicate needed.`,
            link
          ),
          dedupeKey: `mw-autosync:${g.key}:${w}`,
        });
      }
      console.log(`[auto-sync] ${g.key} "${g.title ?? g.code}": ${kind} by ${caller.email}, ${watchersOf(importer).length} watcher(s)`);
      return;
    }

    if (outcome.status === 409) {
      // Someone imported it by hand meanwhile — attach everyone to that row.
      const existing = await findExisting(g, teamsUrl, caller);
      await settleAutoSync(g.key, {
        outcome: 'already',
        assemblyaiId: existing ?? null,
        detail: errText,
      });
      if (existing) await ensureSharedWith(existing, electors.map((e) => e.user.email));
      await resolveAll(electors, g.key, 'imported');
      if (existing) {
        // The electors asked auto-sync to cover this — tell them it's ready
        // even though someone else's import got there first (previously this
        // path shared silently and nobody heard about the meeting).
        const link = await openLink(existing, 'Open the meeting');
        const line = meetingLine({ title: g.title, when: g.startIso });
        for (const e of electors) {
          void notifyUser({
            kind: 'auto_import',
            toEmail: e.user.email,
            text: dm(
              `⚡ *A meeting you were in is ready*`,
              line,
              `Someone already imported it — auto-sync shared it with you instead of importing a duplicate.`,
              link
            ),
            dedupeKey: `mw-autosync:${g.key}:${e.user.email}`,
          });
        }
      }
      console.log(`[auto-sync] ${g.key}: already imported (${existing ?? '?'}) — shared to ${electors.length}`);
      return;
    }

    lastErr = { status: outcome.status, error: errText, access: isAccessError(outcome.status, errText) };
    if (!lastErr.access) break; // a real failure — trying other tokens won't help
  }

  if (lastErr?.access) {
    await nudgeOrganizer(g, electors, organizerEmail, lastErr.error);
    return;
  }
  await settleAutoSync(g.key, { outcome: 'failed', detail: lastErr?.error ?? 'no usable importer' });
  console.warn(`[auto-sync] ${g.key} failed: ${lastErr?.error ?? 'no usable importer'}`);
}

async function findExisting(g: Group, teamsUrl: string | null, caller: Caller): Promise<string | null> {
  try {
    const [hit] =
      g.provider === 'teams' && teamsUrl
        ? await findImportedByTeamsMeetings([{ joinWebUrl: teamsUrl, startTime: g.startIso }], caller)
        : await findImportedByMeetingCodes([{ code: g.code, startTime: g.startIso }], caller);
    return hit?.assemblyai_id ?? null;
  } catch {
    return null;
  }
}

async function resolveAll(electors: Elector[], _key: string, reason: string): Promise<void> {
  for (const e of electors) {
    // Each user's reminder wears THEIR timezone-flavoured event_key.
    await resolveReminderByKey(e.user.userId, 'unimported', e.row.event_key, reason).catch(() => {});
  }
}

/** Edit-share the row with these emails (idempotent; owner skipped). Also
 * used by the series auto-import sweep for its auto-sync watchers. */
export async function ensureSharedWith(assemblyaiId: string, emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  const row = await getAnyByAssemblyaiId(assemblyaiId).catch(() => null);
  if (!row) return;
  const owner = await identityForUser(row.user_id).catch(() => null);
  for (const email of emails) {
    if (owner?.email && owner.email.toLowerCase() === email.toLowerCase()) continue;
    try {
      await addShare({
        transcriptId: row.id,
        ownerUserId: row.user_id,
        sharedByUserId: row.user_id,
        sharedWithEmail: email,
        sharedWithName: null,
        sharedWithPplId: null,
        access: 'edit',
      });
    } catch (err) {
      console.warn('[auto-sync] share failed for', email, err);
    }
  }
}

/**
 * No auto-sync user's token can read the artifacts: ask the one account
 * that can — the organiser — once per occurrence (reminder + Slack DM),
 * then re-check daily in case they connect / enable / import.
 */
async function nudgeOrganizer(
  g: Group,
  electors: Elector[],
  organizerEmail: string | null,
  why: string
): Promise<void> {
  const email = organizerEmail?.trim().toLowerCase() ?? null;
  const domain = email?.split('@')[1] ?? '';
  const internal = !!email && AUTO_SHARE_DOMAINS.has(domain);
  const isElector = !!email && electors.some((e) => e.user.email.toLowerCase() === email);
  if (!email || !internal || isElector) {
    await settleAutoSync(g.key, { outcome: 'no_access', detail: why });
    console.warn(`[auto-sync] ${g.key}: no token with access (organiser ${email ?? 'unknown'}) — ${why}`);
    return;
  }
  const n = electors.length;
  const who = electors.map((e) => e.user.email).join(', ');
  const userId = await userIdForEmail(email).catch(() => null);
  if (userId) {
    const r = electors[0]!.row;
    await upsertReminder({
      userId,
      kind: 'sync_requested',
      eventKey: g.key,
      meetingCode: g.code,
      title: g.title,
      eventStart: g.startIso,
      organizerSelf: true,
      hasRecording: r.has_recording,
      hasTranscript: r.has_transcript,
    }).catch(() => {});
  }
  void notifyUser({
    kind: 'sync_request',
    toEmail: email,
    text: dm(
      `🙏 *Your colleagues need this meeting imported*`,
      meetingLine({ title: g.title, when: g.startIso }),
      `${who} ${n === 1 ? 'has' : 'have'} auto-sync on, but only your Google account (you organised it) can reach the transcript/recording.`,
      `Import it once from its day in <${APP_URL}/|Darth Meetings>, or turn on auto-sync in ${SETTINGS_LINK} and this never comes up again.`
    ),
    dedupeKey: `mw-sync-request:${g.key}`,
  });
  await settleAutoSync(g.key, { outcome: 'nudged', detail: `${why}; nudged ${email}` });
  console.log(`[auto-sync] ${g.key}: nudged organiser ${email} (${n} elector(s) lacked access)`);
}

export type { GmeetContext };

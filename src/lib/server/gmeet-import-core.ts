import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  createDeferredPlaceholder,
  deleteForUser,
  findVisibleByAssemblyaiId,
  findVisibleByDriveFileId,
  mergeGmeetContextForUser,
  setRecordedAtForUser,
} from '@/db-ops/transcripts';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { findImportedByMeetingCodes } from '@/db-ops/gmeet-sync';
import { registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import {
  GoogleApiError,
  captureMeetActuals,
  downloadDriveFileToTemp,
  findConferenceRecordName,
  getDriveFileMeta,
  parseTranscriptDocs,
  utterancesFromEntries,
  type ParsedMeetTranscript,
} from '@/lib/server/gmeet';
import { copyAudioToTemp, deleteAudioFile } from '@/lib/server/audio-storage';
import { concatMediaToTemp } from '@/lib/server/media-concat';
import { IngestError, ingestLocalAudio } from '@/lib/server/ingest';
import { ingestParsedUtterances } from '@/lib/server/ingest-parsed';
import { resolveAccess } from '@/db-ops/transcript-access';
import type {
  GmeetAttendee,
  GmeetContext,
  MeetActuals,
  StoredTranscript,
} from '@/lib/format';

/**
 * The Google Meet import, extracted from the /api/gmeet/import route so the
 * deferred-import poller can replay a queued import server-side (owner's
 * minted token, no browser session). The route stays a thin auth + JSON
 * wrapper; outcomes here are `{ status, body }` pairs it serializes 1:1.
 */

export interface ImportOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface ImportUser {
  userId: string;
  email: string;
}

export interface ImportBody {
  /** Optional when sourceTranscriptId provides everything locally. */
  accessToken?: string;
  mode: 'video' | 'transcript' | 'both';
  videoFileId?: string;
  transcriptDocId?: string;
  languageCode?: string;
  force?: boolean;
  /** Meet API conference record resource name, when the client already found
   * it (orphan-link / recent-meets flows). Saves a lookup. */
  conferenceRecordName?: string;
  /** Re-run-diarization path: reuse this existing row's already-fetched
   * local audio and stored Meet context (actuals + meetTranscript) instead
   * of touching Drive/Meet again — no second download, no Google popup. */
  sourceTranscriptId?: string;
  /** Client opt-in: when the mode's needed artifact is listed by Meet but
   * its file isn't generated yet, queue the import (202 + a `defer-…`
   * placeholder row) instead of failing — the deferred-import poller runs
   * it the moment Google finishes. */
  defer?: boolean;
  /** Client opt-in: even when the artifacts ARE ready, don't pull the video
   * inline — queue the same `defer-…` placeholder and let the poller run the
   * heavy download/AAI submit server-side. The request returns in seconds
   * and the browser tab is free (closing it no longer kills the import).
   * Transcript mode: when the Doc id is known the quick import is queued the
   * same way (one row per occurrence in PG, poller-driven — a series "Import
   * all" of dozens of transcripts survives a closed tab or a restart); a
   * transcript import with no Doc id yet stays inline. */
  background?: boolean;
  /** Extra gmeet_context to stamp on the created row (series auto-import
   * marker + report pref). Merged into the base context, so it also lands on
   * defer placeholders and survives promotion via the frozen request. */
  contextExtra?: {
    autoImport?: GmeetContext['autoImport'];
    uploadPrefs?: GmeetContext['uploadPrefs'];
  };
  event?: {
    id?: string;
    title?: string;
    startTime?: string;
    endTime?: string;
    meetingCode?: string;
    recurringEventId?: string;
    iCalUID?: string;
    organizerEmail?: string;
    attendees?: GmeetAttendee[];
  };
}

export interface ExecuteOptions {
  /** Set by the deferred-import poller: the `defer-…` placeholder row being
   * fulfilled. Video modes promote it in place (shares survive); transcript
   * mode deletes it once the real `gmeet-…` row exists. Also excluded from
   * the cross-user dedupe so the queued row never conflicts with itself. */
  placeholderAssemblyaiId?: string;
}

const out = (status: number, body: Record<string, unknown>): ImportOutcome => ({ status, body });

/**
 * Cross-user duplicate check by meeting code + occurrence start. Returns a
 * 409 outcome when someone ELSE already imported this occurrence (shared
 * with the caller or not), null when it's unclaimed. `occurrenceStart` keeps
 * recurring meetings honest — one code covers the whole series, so without
 * it any imported date would block every other date. `force` bypasses at
 * call sites.
 */
async function checkCrossUserDuplicate(
  meetingCode: string,
  occurrenceStart: string | null,
  user: ImportUser,
  excludeAssemblyaiIds?: string[]
): Promise<ImportOutcome | null> {
  try {
    const [other] = await findImportedByMeetingCodes(
      [{ code: meetingCode, startTime: occurrenceStart }],
      {
        userId: user.userId,
        email: user.email,
      },
      { excludeAssemblyaiIds }
    );
    if (!other) return null;
    return out(409, {
      error: other.accessible
        ? 'This meeting was already imported.'
        : `This meeting was already imported by ${other.owner_email ?? 'a colleague'} (not shared with you).`,
      existing: {
        assemblyai_id: other.accessible ? other.assemblyai_id : null,
        title: other.accessible ? other.title : null,
        created_at: null,
        own: other.mine,
        ownerEmail: other.owner_email,
        accessible: other.accessible,
      },
    });
  } catch (err) {
    // Dedupe is best-effort — never block an import on a failed check.
    console.warn('[gmeet/import] cross-user dedupe check failed:', err);
    return null;
  }
}

/**
 * Remap a Meet-transcript sidecar's utterance times (ms since anchorIso =
 * meeting time) onto the CONCATENATED media's timeline: segments play
 * back-to-back, so each utterance shifts left by the total gap duration
 * before it. Falls back to identity when segment windows are unknown.
 */
function remapParsedToConcatTime(
  parsed: ParsedMeetTranscript,
  sourceCtx: GmeetContext | null,
  storedParts: NonNullable<GmeetContext['videoParts']>
): ParsedMeetTranscript {
  const recs = sourceCtx?.actuals?.recordings ?? [];
  const primaryRec =
    recs.find((r) => r.fileId && r.fileId === sourceCtx?.videoFileId) ??
    recs.find((r) => r.fileId) ??
    recs[0];
  const segs = [primaryRec, ...storedParts]
    .filter((s): s is { startTime: string; endTime: string } => !!s?.startTime && !!s?.endTime)
    .map((s) => ({ startMs: Date.parse(s.startTime), endMs: Date.parse(s.endTime) }))
    .filter((s) => !Number.isNaN(s.startMs) && !Number.isNaN(s.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  const anchorIso = sourceCtx?.actuals?.anchorIso;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : segs[0]?.startMs;
  if (segs.length < 2 || anchorMs == null || Number.isNaN(anchorMs)) return parsed;

  // Concat-timeline start of each segment = cumulative duration before it.
  let acc = 0;
  const mapped = segs.map((s) => {
    const entry = { meetingStartMs: s.startMs - anchorMs, concatStartMs: acc, durMs: s.endMs - s.startMs };
    acc += entry.durMs;
    return entry;
  });
  const toConcat = (t: number): number => {
    let seg = mapped[0]!;
    for (const m of mapped) {
      if (t >= m.meetingStartMs) seg = m;
      else break;
    }
    const local = Math.min(Math.max(t - seg.meetingStartMs, 0), seg.durMs);
    return Math.round(seg.concatStartMs + local);
  };
  return {
    ...parsed,
    utterances: parsed.utterances.map((u) => ({
      ...u,
      start: toConcat(u.start),
      end: toConcat(u.end),
    })),
  };
}

function googleErrorOutcome(err: GoogleApiError): ImportOutcome {
  if (err.status === 401) {
    return out(401, { error: 'Google session expired — reconnect Google and try again.' });
  }
  if (err.status === 403) {
    return out(403, {
      error:
        'Google denied access to this file. Either you only have viewer access with downloads disabled, or the file was not shared with you — ask the meeting organizer for access.',
    });
  }
  if (err.status === 404) {
    return out(404, { error: 'File not found on Drive — it may have been moved or deleted.' });
  }
  return out(502, { error: 'Google API error', detail: err.message });
}

/**
 * Run a Google Meet import end to end.
 *
 * Modes:
 *  - 'transcript': quick import — export + parse the Meet transcript Doc,
 *    store it as a completed imported row (real speaker names, no AAI cost,
 *    no audio). Synthetic id `gmeet-<recordId ?? docId>`.
 *  - 'video': download the recording from Drive and run it through the
 *    normal AAI pipeline (acoustic diarization — the fix for pooled-room
 *    meetings). Attendee names are added as recognition keyterms.
 *  - 'both': video mode, plus the parsed Meet transcript stored as a sidecar
 *    in gmeet_context.meetTranscript for cross-referencing.
 *
 * The Google access token is used in memory only — the browser's from the
 * route, or the owner's server-minted one from the deferred-import poller.
 * Dedupe: if a visible row already covers this recording's Drive file,
 * respond 409 with the existing row unless `force` is set.
 */
export async function executeGmeetImport(
  user: ImportUser,
  body: ImportBody,
  opts?: ExecuteOptions
): Promise<ImportOutcome> {
  const { accessToken, mode, videoFileId, transcriptDocId, languageCode, force } = body;
  const event = body.event ?? {};
  // Garbage dates would blow up Date arithmetic / SQL later — drop them.
  if (event.startTime && Number.isNaN(Date.parse(event.startTime))) event.startTime = undefined;
  if (event.endTime && Number.isNaN(Date.parse(event.endTime))) event.endTime = undefined;

  // ---- Re-run-from-local: reuse an existing row's fetched audio + stored
  // Meet context. Everything Google-side is skipped, so no token needed. ----
  let sourceRow: StoredTranscript | null = null;
  if (body.sourceTranscriptId) {
    const src = await resolveAccess(user.userId, user.email, body.sourceTranscriptId);
    if (!src) {
      return out(404, { error: 'Source transcript not found' });
    }
    if (!src.row.local_audio_path) {
      return out(422, {
        error: 'No audio on the source transcript yet — fetch audio for playback first.',
      });
    }
    sourceRow = src.row;
  }

  const hasToken = typeof accessToken === 'string' && accessToken.length >= 20;
  if (!hasToken && !sourceRow) {
    return out(400, { error: 'accessToken is required' });
  }
  if (mode !== 'video' && mode !== 'transcript' && mode !== 'both') {
    return out(400, { error: "mode must be 'video' | 'transcript' | 'both'" });
  }
  // Video modes usually require the file id up front — except when deferring:
  // a still-generating recording HAS no file id yet, that's the whole point.
  // The poller supplies the id at execution time.
  if ((mode === 'video' || mode === 'both') && !videoFileId && !sourceRow && !body.defer) {
    return out(400, { error: 'videoFileId is required for this mode' });
  }
  // Transcript mode doesn't strictly need a Doc id up front — given a
  // conference record (or a meeting code to find one), the actuals capture
  // below discovers the transcript itself. This is what lets bulk import
  // fire without the client pre-resolving every row.
  if (
    (mode === 'transcript' || mode === 'both') &&
    !transcriptDocId &&
    !body.conferenceRecordName &&
    !event.meetingCode
  ) {
    return out(400, { error: 'transcriptDocId or a conference reference is required for this mode' });
  }
  const attendees: GmeetAttendee[] = Array.isArray(event.attendees)
    ? event.attendees
        .filter((a) => a && typeof a.email === 'string')
        .map((a) => ({ email: a.email, name: a.name, responseStatus: a.responseStatus }))
    : [];

  // ---- Meet API actuals: participants (emails via People API), recording
  // segment times, structured transcript entries. Best-effort — captured NOW
  // because entries expire 30 days after the meeting. A re-run from a local
  // source reuses the snapshot frozen at original import time (the live API
  // may already have expired it, and often 403s for non-organizers). -------
  let actuals: MeetActuals | null = sourceRow?.gmeet_context?.actuals ?? null;
  try {
    if (!actuals && hasToken && body.conferenceRecordName) {
      actuals = await captureMeetActuals(accessToken!, body.conferenceRecordName);
      // Cross-check the CLIENT-supplied record against the event's own time
      // window. Without this, a stale/buggy/malicious client can attach one
      // meeting's content and participants to another meeting's title and
      // invitees — the wrong-share incident, resurrected.
      if (
        actuals?.conferenceStart &&
        event.startTime &&
        Math.abs(
          new Date(actuals.conferenceStart).getTime() - new Date(event.startTime).getTime()
        ) >
          12 * 3600_000
      ) {
        console.warn(
          '[gmeet/import] rejecting conferenceRecordName outside the event time window'
        );
        actuals = null;
      }
    }
    if (!actuals && hasToken && event.meetingCode) {
      const found = await findConferenceRecordName(
        accessToken!,
        event.meetingCode,
        event.startTime
      );
      if (found) actuals = await captureMeetActuals(accessToken!, found);
    }
  } catch (err) {
    console.warn('[gmeet/import] actuals capture failed (continuing):', err);
  }

  // The Doc id the client sent, else whatever the actuals capture found.
  const effectiveDocId = transcriptDocId ?? actuals?.transcriptDocIds?.[0] ?? null;

  // Meet listed a recording but Google hasn't generated its file yet (call
  // just ended). Mark the row so the recording poller re-checks and attaches
  // each video once it lands — without this, a quick import done minutes
  // after the call permanently believes the meeting had no recording. This
  // deliberately fires even when a videoFileId IS being imported: a
  // stop-restart recording makes several files, and the later ones are often
  // still generating while the first is ready — dropping them silently loses
  // the bulk of the meeting (the Alok<>Swaralee two-video incident).
  const recordingPending: GmeetContext['recordingPending'] =
    !sourceRow && // re-runs reuse a FROZEN snapshot — its gaps aren't news
    actuals?.conferenceRecordName &&
    (actuals.recordings?.length ?? 0) > 0 &&
    actuals.recordings!.some((r) => !r.fileId)
      ? {
          recordName: actuals.conferenceRecordName,
          since: new Date().toISOString(),
          status: 'waiting',
        }
      : undefined;

  // Multi-video meetings: every ready recording that is NOT the primary
  // becomes a videoParts entry up front (bytes pulled by the sweeper/poller),
  // so no segment is ever invisible. Chronological order.
  const sortedRecs = [...(actuals?.recordings ?? [])].sort((a, b) =>
    (a.startTime ?? '').localeCompare(b.startTime ?? '')
  );
  const primaryFileId = videoFileId ?? sortedRecs.find((r) => r.fileId)?.fileId;
  // Re-runs from a multi-video source COMBINE the stored segments into one
  // file (below) — the new row has all the content, so it carries no parts.
  const sourceStoredParts = (sourceRow?.gmeet_context?.videoParts ?? []).filter(
    (p) => !!p.filename
  );
  const combining = !!sourceRow?.local_audio_path && sourceStoredParts.length > 0;
  // Otherwise re-runs inherit the source's known parts, minus filenames —
  // part files are keyed by assemblyai_id, so the new row's copies get
  // re-fetched.
  const videoParts = sourceRow
    ? combining
      ? []
      : (sourceRow.gmeet_context?.videoParts ?? []).map(({ fileId, startTime, endTime }) => ({
          fileId,
          startTime,
          endTime,
        }))
    : sortedRecs
        .filter((r) => r.fileId && r.fileId !== primaryFileId)
        .map((r) => ({ fileId: r.fileId!, startTime: r.startTime, endTime: r.endTime }));

  const baseContext: GmeetContext = {
    eventId: event.id,
    recurringEventId: event.recurringEventId,
    iCalUID: event.iCalUID,
    organizerEmail: event.organizerEmail,
    eventTitle: event.title,
    startTime: event.startTime,
    endTime: event.endTime,
    meetingCode: event.meetingCode,
    attendees,
    videoFileId: videoFileId ?? undefined,
    ...(videoParts.length > 0 ? { videoParts } : {}),
    ...(combining ? { combinedParts: sourceStoredParts.length + 1 } : {}),
    transcriptDocId: effectiveDocId ?? undefined,
    recordingPending,
    actuals,
    ...(body.contextExtra ?? {}),
  };

  // Orphan imports (pasted link / recents) have no calendar event — fall
  // back to a code+date title so the row isn't "Untitled transcript".
  const title =
    event.title ??
    (actuals?.conferenceStart
      ? `Meet ${event.meetingCode ?? ''} — ${actuals.conferenceStart.slice(0, 10)}`.replace('  ', ' ')
      : null);

  // Share to everyone who was invited OR actually joined (internal domains
  // only). Participants matter for orphan imports where there's no invite
  // list at all.
  const shareCandidates = new Map<string, { email: string; name?: string | null }>();
  for (const a of attendees) {
    shareCandidates.set(a.email.trim().toLowerCase(), { email: a.email, name: a.name });
  }
  for (const p of actuals?.participants ?? []) {
    const email = p.email?.trim().toLowerCase();
    if (email && !shareCandidates.has(email)) {
      shareCandidates.set(email, { email, name: p.displayName });
    }
  }
  const shareList = [...shareCandidates.values()];

  // ---- Deferred import: the mode's needed artifact is listed by Meet but
  // Google hasn't generated its file yet. Queue a placeholder row carrying
  // the frozen request; the deferred-import poller replays it (owner's
  // server token) the moment the dependency lands. 'transcript' waits on the
  // Doc only, 'video' on the file only, 'both' on both — firing 'both' early
  // would silently drop the Meet transcript (Doc failures are swallowed in
  // that mode). -------------------------------------------------------------
  if (body.defer && !sourceRow && !opts?.placeholderAssemblyaiId) {
    const recsListed = actuals?.recordings ?? [];
    const videoReady = !!primaryFileId;
    const videoPendingNow = !videoReady && recsListed.some((r) => !r.fileId);
    const transcriptReady =
      !!effectiveDocId || (actuals?.transcriptEntries?.length ?? 0) > 0;
    const transcriptPendingNow = !transcriptReady && (actuals?.transcriptsListed ?? 0) > 0;
    const needsWait =
      mode === 'transcript'
        ? transcriptPendingNow
        : mode === 'video'
          ? videoPendingNow
          : videoPendingNow || transcriptPendingNow;
    // Without a conference record the poller would have nothing to re-check.
    if (needsWait && actuals?.conferenceRecordName) {
      // Dedupe BEFORE queueing — same checks the immediate paths run, so a
      // second click (or a colleague's finished import) conflicts now, not
      // silently a minute later.
      if (!force) {
        const recordId = actuals.conferenceRecordName.split('/').pop();
        if (recordId && mode === 'transcript') {
          const dupe = await findVisibleByAssemblyaiId(
            user.userId,
            user.email,
            `gmeet-${recordId}`
          );
          if (dupe) {
            return out(409, {
              error: 'This meeting was already imported.',
              existing: {
                assemblyai_id: dupe.assemblyai_id,
                title: dupe.title,
                created_at: dupe.created_at,
                own: dupe.user_id === user.userId,
                accessible: true,
              },
            });
          }
        }
        if (event.meetingCode) {
          const conflictOut = await checkCrossUserDuplicate(
            event.meetingCode,
            event.startTime ?? actuals.conferenceStart ?? null,
            user
          );
          if (conflictOut) return conflictOut;
        }
      }

      const waitingFor: 'transcript' | 'video' | 'both' =
        videoPendingNow && transcriptPendingNow
          ? 'both'
          : videoPendingNow
            ? 'video'
            : 'transcript';
      const placeholderId = `defer-${randomUUID()}`;
      // recordingPending stays OFF the placeholder — the recording poller
      // must not race the deferred poller attaching videos to a row that is
      // about to be promoted/replaced. The execution-time import re-derives
      // it fresh for the real row.
      const { recordingPending: _dropped, ...ctxForPlaceholder } = baseContext;
      void _dropped;
      const placeholder = await createDeferredPlaceholder(user.userId, {
        placeholderId,
        title,
        recordedAt: event.startTime ?? actuals.conferenceStart ?? null,
        gmeetContext: {
          ...ctxForPlaceholder,
          deferredImport: {
            mode,
            ownerEmail: user.email,
            request: {
              videoFileId: videoFileId ?? undefined,
              transcriptDocId: transcriptDocId ?? undefined,
              languageCode,
              conferenceRecordName: actuals.conferenceRecordName,
              force,
              event,
              contextExtra: body.contextExtra,
            },
            since: new Date().toISOString(),
            status: 'waiting',
          },
        },
      });
      // Same visibility rule as live uploads: invitees see the queued row
      // immediately, not only once the import lands.
      const autoShared = await autoShareToInternalInvitees(
        placeholder.id,
        user.userId,
        user.email,
        shareList
      );
      await registerPeopleFromMeeting(shareList, user.userId);
      console.log(
        `[gmeet/import] deferred ${mode} import queued as ${placeholderId} (waiting for ${waitingFor})`
      );
      return out(202, { deferred: true, waitingFor, transcript: placeholder, mode, autoShared });
    }

    // ---- Background import: artifacts are READY, but downloading a
    // recording and re-uploading it to AssemblyAI takes minutes, and holding
    // the HTTP request open that long chains the user to the tab. Queue the
    // same placeholder the not-ready path uses; the deferred-import poller
    // (kicked immediately by the route) replays it with the owner's minted
    // token. Dedupe and download-permission problems still surface HERE,
    // interactively — only the heavy pull moves to the background. Requires
    // a conference record (it's what the poller re-checks); without one the
    // import falls through to the inline path below.
    if (
      body.background &&
      mode !== 'transcript' &&
      hasToken &&
      actuals?.conferenceRecordName &&
      primaryFileId
    ) {
      if (!force) {
        const existing = await findVisibleByDriveFileId(user.userId, user.email, primaryFileId);
        if (existing) {
          return out(409, {
            error: 'This recording was already imported.',
            existing: {
              assemblyai_id: existing.assemblyai_id,
              title: existing.title,
              created_at: existing.created_at,
              own: existing.user_id === user.userId,
              accessible: true,
            },
          });
        }
        if (event.meetingCode) {
          const conflictOut = await checkCrossUserDuplicate(
            event.meetingCode,
            event.startTime ?? actuals.conferenceStart ?? null,
            user
          );
          if (conflictOut) return conflictOut;
        }
      }
      try {
        const meta = await getDriveFileMeta(accessToken!, primaryFileId);
        if (!meta.canDownload) {
          return out(403, {
            error:
              'The owner has disabled downloads for viewers on this recording. Ask them for edit access or to lift the restriction (Share → gear icon).',
          });
        }
      } catch (err) {
        if (err instanceof GoogleApiError) return googleErrorOutcome(err);
        throw err;
      }

      const placeholderId = `defer-${randomUUID()}`;
      // Same reasoning as the not-ready queue: recordingPending stays off the
      // placeholder so the recording poller can't race the promotion.
      const { recordingPending: _dropped, ...ctxForPlaceholder } = baseContext;
      void _dropped;
      const placeholder = await createDeferredPlaceholder(user.userId, {
        placeholderId,
        title,
        recordedAt: event.startTime ?? actuals.conferenceStart ?? null,
        gmeetContext: {
          ...ctxForPlaceholder,
          deferredImport: {
            mode,
            ownerEmail: user.email,
            background: true,
            request: {
              videoFileId: primaryFileId,
              transcriptDocId: transcriptDocId ?? undefined,
              languageCode,
              conferenceRecordName: actuals.conferenceRecordName,
              force,
              event,
              contextExtra: body.contextExtra,
            },
            since: new Date().toISOString(),
            status: 'waiting',
          },
        },
      });
      const autoShared = await autoShareToInternalInvitees(
        placeholder.id,
        user.userId,
        user.email,
        shareList
      );
      await registerPeopleFromMeeting(shareList, user.userId);
      console.log(
        `[gmeet/import] background ${mode} import queued as ${placeholderId} (artifacts ready)`
      );
      return out(202, {
        deferred: true,
        background: true,
        waitingFor: mode === 'both' ? 'both' : 'video',
        transcript: placeholder,
        mode,
        autoShared,
      });
    }
  }

  // ---- Background transcript import: the Doc is known (calendar
  // attachment / Gemini notes Doc / Meet listing) so there is nothing to wait
  // for — but a series "Import all" is dozens of these driven by a browser
  // loop that dies with the tab. Queue the same durable placeholder row the
  // deferred path uses (PG; survives restarts) and let the deferred-import
  // poller run the quick import server-side with the owner's minted token.
  // Dedupe HERE so a second click, an already-queued twin, or a colleague's
  // import 409s now instead of a minute later. No conference record needed
  // (months-old Gemini Docs have none) — the poller executes on sight.
  if (
    body.background &&
    mode === 'transcript' &&
    !sourceRow &&
    !opts?.placeholderAssemblyaiId &&
    effectiveDocId
  ) {
    if (!force) {
      const recordId = actuals?.conferenceRecordName?.split('/').pop() ?? null;
      const dupe = await findVisibleByAssemblyaiId(
        user.userId,
        user.email,
        `gmeet-${recordId ?? effectiveDocId}`
      );
      if (dupe) {
        return out(409, {
          error: 'This meeting was already imported.',
          existing: {
            assemblyai_id: dupe.assemblyai_id,
            title: dupe.title,
            created_at: dupe.created_at,
            own: dupe.user_id === user.userId,
            accessible: true,
          },
        });
      }
      if (event.meetingCode) {
        // Also catches our own still-queued placeholder for this occurrence
        // (it carries the meetingCode + startTime) — idempotent queueing.
        const conflictOut = await checkCrossUserDuplicate(
          event.meetingCode,
          event.startTime ?? actuals?.conferenceStart ?? null,
          user
        );
        if (conflictOut) return conflictOut;
      }
    }
    const placeholderId = `defer-${randomUUID()}`;
    const { recordingPending: _dropped, ...ctxForPlaceholder } = baseContext;
    void _dropped;
    const placeholder = await createDeferredPlaceholder(user.userId, {
      placeholderId,
      title,
      recordedAt: event.startTime ?? actuals?.conferenceStart ?? null,
      gmeetContext: {
        ...ctxForPlaceholder,
        deferredImport: {
          mode,
          ownerEmail: user.email,
          background: true,
          request: {
            transcriptDocId: effectiveDocId,
            languageCode,
            conferenceRecordName: actuals?.conferenceRecordName,
            force,
            event,
            contextExtra: body.contextExtra,
          },
          since: new Date().toISOString(),
          status: 'waiting',
        },
      },
    });
    const autoShared = await autoShareToInternalInvitees(
      placeholder.id,
      user.userId,
      user.email,
      shareList
    );
    await registerPeopleFromMeeting(shareList, user.userId);
    console.log(
      `[gmeet/import] background transcript import queued as ${placeholderId} (doc ready)`
    );
    return out(202, {
      deferred: true,
      background: true,
      waitingFor: 'transcript',
      transcript: placeholder,
      mode,
      autoShared,
    });
  }

  // ---- Meet transcript content when the mode wants it ---------------------
  // Preferred source: structured API entries (precise per-utterance times).
  // Fallback: export + parse the transcript Doc (5-minute block timing) —
  // the only option for meetings older than the API's 30-day entry window.
  let parsed: ParsedMeetTranscript | null = null;
  if (mode === 'transcript' || mode === 'both') {
    if (sourceRow?.gmeet_context?.meetTranscript?.utterances?.length) {
      // Re-run from a quick import: its parsed Meet transcript is already
      // stored — carry it over as the sidecar without touching Google.
      parsed = sourceRow.gmeet_context.meetTranscript;
    } else if (actuals?.transcriptEntries && actuals.transcriptEntries.length > 0) {
      parsed = {
        attendees: (actuals.participants ?? []).map((p) => p.displayName),
        utterances: utterancesFromEntries(actuals.transcriptEntries),
      };
    } else if (!effectiveDocId) {
      if (mode === 'transcript') {
        return out(422, {
          error:
            'No Meet transcript found for this meeting — it may not have had transcription/Gemini notes on, or the artifacts are older than the Meet API keeps them.',
        });
      }
    } else if (hasToken) {
      try {
        // One doc per transcription session on classic tenants — parse ALL
        // of them (start/stop/start = several docs), not just the first.
        const docIds =
          (actuals?.transcriptDocIds?.length ?? 0) > 1
            ? actuals!.transcriptDocIds!
            : [effectiveDocId];
        parsed = await parseTranscriptDocs(accessToken!, docIds);
      } catch (err) {
        if (err instanceof GoogleApiError) {
          // In 'both' mode the transcript is a bonus — don't fail the video
          // import over it.
          if (mode === 'both') {
            console.warn('[gmeet/import] transcript doc fetch failed (continuing):', err.message);
          } else {
            return googleErrorOutcome(err);
          }
        } else {
          throw err;
        }
      }
    }
    if (mode === 'transcript' && (!parsed || parsed.utterances.length === 0)) {
      return out(422, {
        error:
          'Could not parse any utterances out of the transcript Doc. It may be empty or in an unexpected format — try re-transcribing the video instead.',
      });
    }
  }

  // ---- Quick import: Meet transcript only, no AAI --------------------------
  if (mode === 'transcript') {
    // Stable per-meeting id. Prefer the CONFERENCE RECORD id: every import
    // path resolves the same record for the same meeting, whereas doc ids
    // diverge (classic transcript doc vs Gemini-notes doc vs API pick) and
    // would split dedupe into duplicate cross-shared rows.
    const recordId = actuals?.conferenceRecordName?.split('/').pop() ?? null;
    const idBase = recordId ?? effectiveDocId;
    if (!idBase) {
      return out(422, {
        error: 'Could not identify this meeting (no conference record or transcript doc).',
      });
    }
    const syntheticId = `gmeet-${idBase}`;

    // Same-Doc dedupe: the synthetic id is identical for every importer, so
    // anyone on the invite (auto-shared below) gets pointed at the existing
    // row instead of minting a duplicate.
    const dupe = await findVisibleByAssemblyaiId(user.userId, user.email, syntheticId);
    if (dupe && !force) {
      return out(409, {
        error: 'This meeting was already imported.',
        existing: {
          assemblyai_id: dupe.assemblyai_id,
          title: dupe.title,
          created_at: dupe.created_at,
          own: dupe.user_id === user.userId,
          accessible: true,
        },
      });
    }
    // Cross-USER dedupe: a colleague may have imported this meeting without
    // sharing it (off-invite import, or pre-auto-share rows). Surface who
    // has it instead of silently minting a duplicate; force overrides.
    if (!dupe && !force && event.meetingCode) {
      const crossUserConflict = await checkCrossUserDuplicate(
        event.meetingCode,
        event.startTime ?? actuals?.conferenceStart ?? null,
        user,
        opts?.placeholderAssemblyaiId ? [opts.placeholderAssemblyaiId] : undefined
      );
      if (crossUserConflict) return crossUserConflict;
    }

    const startIso = event.startTime ?? actuals?.conferenceStart;
    const endIso = event.endTime ?? actuals?.conferenceEnd;
    const { row, autoShared } = await ingestParsedUtterances(
      { userId: user.userId, email: user.email },
      {
        sourceId: syntheticId,
        title,
        parsed: parsed!,
        recordedAtIso: startIso ?? null,
        completedAtIso: endIso ?? null,
        gmeetContext: { ...baseContext, meetTranscript: parsed },
        attendees,
        participants: actuals?.participants,
        shareList,
        logTag: '[gmeet/import]',
      }
    );

    // Deferred execution: the real row exists now — retire the placeholder
    // (its shares are re-established on the new row by the auto-share above).
    if (opts?.placeholderAssemblyaiId) {
      await deleteForUser(user.userId, opts.placeholderAssemblyaiId);
    }

    return out(201, { transcript: row, mode, autoShared });
  }

  // ---- Video path: dedupe, capability check, download, AAI pipeline --------
  if (!videoFileId && !sourceRow) {
    // defer:true bypassed the up-front check; nothing to wait for either.
    return out(400, { error: 'videoFileId is required for this mode' });
  }
  const existing = videoFileId
    ? await findVisibleByDriveFileId(user.userId, user.email, videoFileId)
    : null;
  if (existing && !force) {
    return out(409, {
      error: 'This recording was already imported.',
      existing: {
        assemblyai_id: existing.assemblyai_id,
        title: existing.title,
        created_at: existing.created_at,
        own: existing.user_id === user.userId,
        accessible: true,
      },
    });
  }
  if (!existing && !force && event.meetingCode) {
    const crossUserConflict = await checkCrossUserDuplicate(
      event.meetingCode,
      event.startTime ?? actuals?.conferenceStart ?? null,
      user,
      opts?.placeholderAssemblyaiId ? [opts.placeholderAssemblyaiId] : undefined
    );
    if (crossUserConflict) return crossUserConflict;
  }

  let tempFilename: string;
  let originalFilename: string;
  if (sourceRow?.local_audio_path && combining) {
    // Multi-video source: concatenate the primary + every stored segment so
    // the NEW transcription covers the whole meeting — re-transcribing just
    // the first video would repeat the missing-content confusion this flow
    // exists to fix.
    try {
      tempFilename = await concatMediaToTemp([
        sourceRow.local_audio_path,
        ...sourceStoredParts.map((p) => p.filename!),
      ]);
    } catch (err) {
      console.error('[gmeet/import] video concat failed:', err);
      return out(502, { error: 'Combining the meeting videos failed', detail: String(err) });
    }
    originalFilename = `combined-${sourceStoredParts.length + 1}-videos.mp4`;
  } else if (sourceRow?.local_audio_path) {
    // Re-run from local: the bytes were already fetched (fetch-audio) —
    // copy them so the ingest rename consumes the copy, not the source.
    try {
      tempFilename = await copyAudioToTemp(sourceRow.local_audio_path);
    } catch (err) {
      console.error('[gmeet/import] local audio copy failed:', err);
      return out(502, { error: 'Could not read the stored audio — try fetching audio again.' });
    }
    originalFilename = sourceRow.original_filename ?? sourceRow.local_audio_path;
  } else {
    let meta;
    try {
      meta = await getDriveFileMeta(accessToken!, videoFileId!);
    } catch (err) {
      if (err instanceof GoogleApiError) return googleErrorOutcome(err);
      throw err;
    }
    if (!meta.canDownload) {
      return out(403, {
        error:
          'The owner has disabled downloads for viewers on this recording. Ask them for edit access or to lift the restriction (Share → gear icon).',
      });
    }
    try {
      const dl = await downloadDriveFileToTemp(accessToken!, videoFileId!);
      tempFilename = dl.tempFilename;
      if (dl.bytes === 0) {
        await deleteAudioFile(tempFilename);
        return out(502, { error: 'Drive returned an empty file' });
      }
    } catch (err) {
      if (err instanceof GoogleApiError) return googleErrorOutcome(err);
      console.error('[gmeet/import] download failed:', err);
      return out(502, { error: 'Download from Drive failed', detail: String(err) });
    }
    originalFilename = meta.name;
  }

  // Names of the people who were invited or actually joined bias AAI's
  // recognition — exactly what it mis-hears otherwise.
  const keytermNames = new Set<string>();
  for (const a of attendees) {
    if (a.name && a.name.trim().length > 1) keytermNames.add(a.name.trim());
  }
  for (const p of actuals?.participants ?? []) {
    if (p.displayName && p.displayName !== 'Unknown') keytermNames.add(p.displayName);
  }

  // Combined media has the inter-segment gaps removed, so the carried Meet
  // sidecar's wall-clock-anchored times must shift to concat time — without
  // this, everything after the first segment is misaligned by the gap
  // (breaks speaker Meet-timeline matching and utterance-click seeks).
  const finalParsed =
    combining && parsed
      ? remapParsedToConcatTime(parsed, sourceRow!.gmeet_context, sourceStoredParts)
      : parsed;

  try {
    const finalContext: GmeetContext = { ...baseContext, meetTranscript: finalParsed };
    const row = await ingestLocalAudio(user.userId, tempFilename, {
      originalFilename,
      languageCode,
      title,
      extraKeyterms: [...keytermNames],
      driveFileId: videoFileId ?? actuals?.recordings?.[0]?.fileId ?? null,
      gmeetContext: finalContext,
      placeholderAssemblyaiId: opts?.placeholderAssemblyaiId ?? null,
    });
    // A promoted deferred placeholder keeps its queue-time gmeet_context —
    // overwrite it with the execution-time one (fresh actuals + sidecar +
    // recordingPending for still-generating extra segments). Shallow jsonb
    // merge: absent keys (like the deferredImport marker) survive for the
    // poller to resolve.
    if (opts?.placeholderAssemblyaiId && row.assemblyai_id !== opts.placeholderAssemblyaiId) {
      await mergeGmeetContextForUser(user.userId, row.assemblyai_id, finalContext, {
        quiet: true,
      });
      row.gmeet_context = { ...row.gmeet_context, ...finalContext };
    }
    const meetingStart = event.startTime ?? actuals?.conferenceStart;
    if (meetingStart && !Number.isNaN(Date.parse(meetingStart))) {
      await setRecordedAtForUser(user.userId, row.assemblyai_id, new Date(meetingStart)).catch(
        () => {}
      );
    }
    const autoShared = await autoShareToInternalInvitees(
      row.id,
      user.userId,
      user.email,
      shareList
    );
    await registerPeopleFromMeeting(shareList, user.userId);
    return out(201, { transcript: row, mode, autoShared });
  } catch (error) {
    if (error instanceof IngestError) {
      console.error(`[gmeet/import] ${error.stage} failed:`, error.causeErr);
      return out(502, { error: error.message, detail: String(error.causeErr) });
    }
    throw error;
  }
}

import 'server-only';
import {
  createImportedForUser,
  setRecordedAtForUser,
  type TranscriptRow,
} from '@/db-ops/transcripts';
import { autoNameSpeakers, registerPeopleFromMeeting } from '@/lib/server/import-helpers';
import { autoShareToInternalInvitees } from '@/lib/server/auto-share';
import { autoAttachSeries } from '@/lib/server/series-attach';
import { onTranscriptCompleted } from '@/lib/server/post-completion';
import { synthesizeTranscriptResponse, type ParsedMeetTranscript } from '@/lib/server/gmeet';
import type { GmeetAttendee, GmeetContext, MeetParticipantInfo } from '@/lib/format';

/**
 * Shared tail of every "transcript arrives already parsed" import — Google
 * Meet quick import, pasted/uploaded text (import-text), and Teams VTT. One
 * place for the sequence: synthesize content → insert row → stamp
 * recorded_at → auto-name speakers → post-completion hook → auto-share +
 * people registration.
 *
 * Utterances must arrive fully timed (ms); format-specific timing repair
 * (Doc block interpolation, import-text's estimate fill) stays with the
 * caller.
 */
export interface IngestParsedOptions {
  /** Synthetic assemblyai_id (`gmeet-…`, `ext-…`, `teams-…`). */
  sourceId: string;
  title: string | null;
  parsed: ParsedMeetTranscript;
  originalFilename?: string | null;
  /** Meeting start — becomes created_at and recorded_at. Absent → now(). */
  recordedAtIso?: string | null;
  completedAtIso?: string | null;
  languageCode?: string | null;
  gmeetContext?: GmeetContext | null;
  /** Calendar invitees — feed speaker→email mapping in autoNameSpeakers. */
  attendees?: GmeetAttendee[];
  /** People who actually joined (Meet API) — same purpose. */
  participants?: MeetParticipantInfo[];
  /** Auto-share targets + people registration; omitted/empty skips both. */
  shareList?: Array<{ email: string; name?: string | null }>;
  /** Prefix for warn logs, e.g. '[gmeet/import]'. */
  logTag?: string;
}

/**
 * Placeholder row for an async text import: the LLM normalization now runs in
 * the background, so the row must exist (status 'processing', empty content)
 * before the model call starts. On completion the caller runs
 * `ingestParsedUtterances` with the SAME sourceId — `createImportedForUser`'s
 * ON CONFLICT (user_id, assemblyai_id) upsert fills this row in place
 * (content, duration, speaker_count, title, status 'completed').
 */
export async function createTextImportPlaceholder(
  user: { userId: string },
  opts: { sourceId: string; title?: string | null; originalFilename?: string | null }
): Promise<TranscriptRow> {
  return createImportedForUser(user.userId, {
    assemblyaiId: opts.sourceId,
    originalFilename: opts.originalFilename ?? null,
    status: 'processing',
    createdAt: null,
    completedAt: null,
    duration: null,
    speakerCount: null,
    languageCode: null,
    audioUrl: null,
    importedContent: synthesizeTranscriptResponse(opts.sourceId, { attendees: [], utterances: [] }),
    title: opts.title ?? null,
  });
}

export async function ingestParsedUtterances(
  user: { userId: string; email: string },
  opts: IngestParsedOptions
): Promise<{ row: TranscriptRow; autoShared: number }> {
  const {
    sourceId,
    title,
    parsed,
    originalFilename = null,
    recordedAtIso = null,
    completedAtIso = null,
    languageCode = null,
    gmeetContext = null,
    attendees = [],
    participants,
    shareList = [],
    logTag = '[ingest-parsed]',
  } = opts;

  const content = synthesizeTranscriptResponse(sourceId, parsed, {
    createdIso: recordedAtIso ?? undefined,
    completedIso: completedAtIso ?? undefined,
  });
  if (languageCode) content.language_code = languageCode;
  const speakerNames = [...new Set(parsed.utterances.map((u) => u.speaker))];

  const row = await createImportedForUser(user.userId, {
    assemblyaiId: sourceId,
    originalFilename,
    status: 'completed',
    createdAt: recordedAtIso ? new Date(recordedAtIso) : null,
    completedAt: completedAtIso ? new Date(completedAtIso) : null,
    duration: content.audio_duration ?? null,
    speakerCount: speakerNames.length,
    languageCode,
    audioUrl: null,
    importedContent: content,
    title,
    gmeetContext: gmeetContext ?? undefined,
  });

  if (recordedAtIso) {
    await setRecordedAtForUser(user.userId, sourceId, new Date(recordedAtIso)).catch(() => {});
  }

  // Real names from the source → name the speakers + map to invitee emails.
  try {
    await autoNameSpeakers(user.userId, sourceId, speakerNames, attendees, participants);
  } catch (err) {
    console.warn(`${logTag} speaker auto-naming failed (continuing):`, err);
  }

  // Post-completion hook (voiceprint matching skips itself — no audio yet).
  onTranscriptCompleted(user.userId, sourceId);

  let autoShared = 0;
  if (shareList.length > 0) {
    autoShared = await autoShareToInternalInvitees(row.id, user.userId, user.email, shareList);
    await registerPeopleFromMeeting(shareList, user.userId);
  }

  await autoAttachSeries({
    id: row.id,
    assemblyai_id: row.assemblyai_id,
    gmeet_context: row.gmeet_context,
    title: row.title,
    user_id: row.user_id,
  });

  return { row, autoShared };
}

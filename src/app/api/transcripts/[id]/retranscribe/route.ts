import { promises as fsp } from 'node:fs';
import { parseReportPref } from '@/lib/report-pref';
import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess, type ResolvedAccess } from '@/db-ops/transcript-access';
import { mergeGmeetContextForUser } from '@/db-ops/transcripts';
import { addShare, listByTranscript } from '@/db-ops/transcript-shares';
import { SHARE_ORIGIN_EVENT_LINK } from '@/db-ops/share-origin';
import { DEFAULT_SPEECH_MODEL, LEGACY_SPEECH_MODEL, type SpeechModel } from '@/lib/aai-language';
import { audioFileSize, resolveAudioPath } from '@/lib/server/audio-storage';
import { finalizeUpload, openUpload, type LinkedEventInput } from '@/lib/server/upload-pipeline';
import { startTranscriptionRun } from '@/lib/server/transcription-runs';
import type { DarthUser } from '@/lib/auth/session';
import type { RetranscribeRequest, TranscriptionLanguageChoice } from '@/lib/transcriptions';

export const runtime = 'nodejs';

/**
 * POST /api/transcripts/:id/retranscribe — editors only.
 *
 * TWO behaviours, and which one runs is decided by
 * `transcriptionVersionsEnabled()` (MW_TRANSCRIPTION_VERSIONS + 044/045/046 +
 * MW_RECORDINGS_WRITE), never by the caller:
 *
 *  - **version mode** (Phase 2, docs/recordings-phase2-spec.md): a NEW
 *    transcription of the SAME meeting's own recording. The meeting stays
 *    `completed` and fully readable on the current version while the job runs,
 *    every version is kept, and switching between them restores that version's
 *    edits and speaker names. Answers `mode: 'version'`.
 *  - **the fallback**, which is what this route has always done: open a fresh
 *    upload that creates a SECOND meeting row alongside, carrying the linked
 *    event and the invitee shares, and leave a pointer on the old one.
 *    Answers `mode: 'new-row'`.
 *
 * The fallback keeps its own refusals (already re-run once, already on the
 * current model) because they are what made it survivable; version mode drops
 * both — the same model with a different language is a legitimate re-run, and
 * there is no "once only" when versions are kept. The wire contract for both
 * is `src/lib/transcriptions.ts`.
 */

const SPEECH_MODELS: SpeechModel[] = ['universal', 'universal-3-5-pro'];
/** AssemblyAI language codes are 'en', 'zh', 'en_us' — never free text. */
const LANGUAGE_RE = /^[a-z]{2}(_[a-z]{2})?$/i;

function parseBody(raw: unknown): RetranscribeRequest {
  const b = (raw ?? {}) as Record<string, unknown>;
  const model = typeof b.speechModel === 'string' ? b.speechModel : null;
  const lang = typeof b.languageCode === 'string' ? b.languageCode.trim() : null;
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : undefined;
  return {
    speechModel: SPEECH_MODELS.includes(model as SpeechModel) ? (model as SpeechModel) : undefined,
    languageCode:
      lang === 'auto' || (lang && LANGUAGE_RE.test(lang))
        ? (lang as TranscriptionLanguageChoice)
        : undefined,
    reason: reason || undefined,
    force: b.force === true,
  };
}

export const POST = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;
  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  // Every existing caller (the detail page's old button, darth-cli) posts no
  // body at all; an unparseable one is read as "the defaults".
  const body = parseBody(await request.json().catch(() => null));

  const started = await startTranscriptionRun({
    row: access.row,
    ownerUserId: access.ownerUserId,
    by: { userId: user.userId, email: user.email ?? null, name: user.name ?? null },
    speechModel: (body.speechModel as SpeechModel | undefined) ?? DEFAULT_SPEECH_MODEL,
    languageCode: body.languageCode ?? 'auto',
    reason: body.reason ?? null,
    force: body.force === true,
  });

  if (started.kind === 'started') {
    return NextResponse.json(
      { ok: true, mode: 'version', transcriptionId: started.transcriptionId, running: started.running },
      { status: 202 }
    );
  }
  if (started.kind === 'refused') {
    return NextResponse.json(started.body, { status: started.status });
  }
  console.log(`[retranscribe] ${id}: version mode unavailable (${started.why}) — new-row fallback`);
  return legacyRetranscribe(user, access);
});

/**
 * TODAY's behaviour, unchanged: "re-transcribe with the newer model" as a NEW
 * meeting row.
 *
 * Reached when Phase 2 cannot serve this meeting — the flag is off, the
 * migrations are not applied, or the meeting has no clip yet (its recording
 * graph has never been written). Everything below is the pre-Phase-2 code
 * verbatim apart from the `mode: 'new-row'` key the shared wire contract adds,
 * and it must stay that way: it is the rollback.
 */
async function legacyRetranscribe(user: DarthUser, access: ResolvedAccess): Promise<Response> {
  const row = access.row;
  const ownerId = row.user_id;
  const ctx = row.gmeet_context;

  if (ctx?.retranscribed) {
    return NextResponse.json(
      { ok: true, already: true, newId: ctx.retranscribed.newId },
      { status: 200 }
    );
  }
  if ((row.speech_model ?? LEGACY_SPEECH_MODEL) === DEFAULT_SPEECH_MODEL) {
    return NextResponse.json(
      { error: 'This transcript already ran on the current model.' },
      { status: 409 }
    );
  }
  if (!row.local_audio_path) {
    return NextResponse.json(
      { error: 'No stored audio for this transcript — nothing to re-run.' },
      { status: 422 }
    );
  }
  const bytes = await audioFileSize(row.local_audio_path);
  if (bytes === null) {
    return NextResponse.json({ error: 'Stored audio file is missing on disk.' }, { status: 422 });
  }

  // Carry the meeting identity so the new row lands in the same series /
  // calendar slot. The event link shares nobody (design P4) — the new row
  // gets the SOURCE meeting's own shares instead, just below.
  const linkedEvent: LinkedEventInput | null = ctx?.eventId
    ? {
        id: ctx.eventId,
        title: ctx.eventTitle,
        startTime: ctx.startTime,
        endTime: ctx.endTime,
        meetingCode: ctx.meetingCode,
        recurringEventId: ctx.recurringEventId,
        iCalUID: ctx.iCalUID,
        organizerEmail: ctx.organizerEmail,
        attendees: ctx.attendees,
      }
    : null;

  const owner = { ...user, userId: ownerId };
  const opened = await openUpload(owner, {
    originalFilename: row.original_filename ?? row.local_audio_path,
    contentType: 'application/octet-stream',
    languageCode: row.language_code ?? undefined,
    linkedEvent,
    // Carries the original row's choice forward; a legacy 'summary' is
    // read as the detailed default (lib/report-pref).
    reportPref: parseReportPref(ctx?.uploadPrefs?.report),
    sourceId: row.assemblyai_id,
    multi: null,
    bytesTotal: bytes,
    speechModel: DEFAULT_SPEECH_MODEL,
    contextExtra: {
      ...(ctx?.provider ? { provider: ctx.provider } : {}),
      retranscribedFrom: row.assemblyai_id,
    },
  });
  if (!opened.ok) return NextResponse.json({ error: opened.error }, { status: opened.status });
  const { spec } = opened;
  // A re-run names its source meeting (`sourceId`), so it is never born a
  // standalone recording (design P7) — the placeholder is always a meeting row.
  if (!('id' in opened.placeholder)) {
    return NextResponse.json({ error: 'Re-transcribe did not open a meeting row' }, { status: 500 });
  }
  const placeholder = opened.placeholder;

  // A re-run of a meeting is still that meeting: whoever it is shared with
  // keeps access on the new row, with the same access level. Until P4 the
  // linked event did this indirectly (and re-shared invitees the owner had
  // removed); now it is the source's own share list, nothing more.
  await carryShares(row.id, placeholder.id, ownerId).catch((err) =>
    console.warn(`[retranscribe] ${row.assemblyai_id}: carrying shares failed:`, err)
  );

  // The bytes are already on disk: hard-link them under the temp name the
  // pipeline expects (falls back to a copy on filesystems without links).
  // The pipeline renames the temp file to its permanent name on success and
  // deletes it on failure — the original stays put either way.
  const src = resolveAudioPath(row.local_audio_path);
  const tmp = resolveAudioPath(spec.tempFilename);
  try {
    await fsp.link(src, tmp);
  } catch {
    await fsp.copyFile(src, tmp);
  }

  const startedAt = new Date().toISOString();
  await mergeGmeetContextForUser(ownerId, row.assemblyai_id, {
    retranscribed: { at: startedAt, newId: placeholder.assemblyai_id, model: DEFAULT_SPEECH_MODEL },
  });

  void (async () => {
    try {
      const result = await finalizeUpload(owner, spec, bytes);
      if ('transcript' in result.body) {
        await mergeGmeetContextForUser(
          ownerId,
          row.assemblyai_id,
          { retranscribed: { at: startedAt, newId: result.body.transcript.assemblyai_id, model: DEFAULT_SPEECH_MODEL } },
          { quiet: true }
        );
        console.log(
          `[retranscribe] ${row.assemblyai_id} → ${result.body.transcript.assemblyai_id} (${DEFAULT_SPEECH_MODEL})`
        );
      } else {
        console.error(`[retranscribe] ${row.assemblyai_id} failed:`, result.body);
        await mergeGmeetContextForUser(ownerId, row.assemblyai_id, { retranscribed: null as never });
      }
    } catch (err) {
      console.error(`[retranscribe] ${row.assemblyai_id} crashed:`, err);
      await mergeGmeetContextForUser(ownerId, row.assemblyai_id, { retranscribed: null as never }).catch(
        () => {}
      );
    }
  })();

  return NextResponse.json(
    { ok: true, mode: 'new-row', newId: placeholder.assemblyai_id, model: DEFAULT_SPEECH_MODEL },
    { status: 202 }
  );
}

/** Copy one meeting's shares onto its re-run (same owner, same access; a
 * link-born share stays link-born so "Unlink from event" still takes it). */
async function carryShares(fromId: number, toId: number, ownerUserId: string): Promise<void> {
  const shares = await listByTranscript(fromId);
  for (const s of shares) {
    const origin = (s as { origin?: string | null }).origin;
    await addShare({
      transcriptId: toId,
      ownerUserId,
      sharedByUserId: s.shared_by_user_id,
      sharedWithEmail: s.shared_with_email,
      sharedWithName: s.shared_with_name,
      sharedWithPplId: s.shared_with_ppl_id,
      access: s.access,
      ...(origin === SHARE_ORIGIN_EVENT_LINK ? { origin: SHARE_ORIGIN_EVENT_LINK } : {}),
    });
  }
}

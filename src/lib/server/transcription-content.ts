import 'server-only';
import { listVersionHeads, loadVersionPayloads, meetingRecordingRef } from '@/db-ops/transcriptions';
import { getForUser as getSpeakerMappings } from '@/db-ops/speaker-mappings';
import { resolveMeetingContent, resolveMeetingContentForVersion } from '@/lib/server/recordings';
import { contentUtterances, labelSpaceOf } from '@/lib/transcription-merge-plan';
import type { StoredTranscript, TranscriptResponse } from '@/lib/format';
import type { TranscriptionContentResponse } from '@/lib/transcriptions';

/**
 * `GET …/transcriptions/:tid/content` — ONE version's text, active or not
 * (docs/transcription-merge-spec.md §3b), so an agent can read the
 * Indonesian pass before deciding to merge or switch.
 *
 * PRIVACY. The caller has gated first: `resolveAccess` on the meeting
 * (readers allowed), or ownership of a bare recording. Two further rules live
 * here:
 *  - `tid` is honoured only when it is a version of THE recording the caller
 *    was gated on — any other uuid is the same 404 as a missing one;
 *  - a meeting's text goes through its clips (`resolveMeetingContentForVersion`),
 *    so a meeting holding a window of a recording never serves the rest.
 * Speaker NAMES are the owner's confirmed names — what
 * `GET …/speakers` already shows every reader of the meeting — and only on a
 * version whose labels ARE the active version's; never anyone's edits.
 */

export type VersionContentResult =
  | { ok: true; body: TranscriptionContentResponse }
  | { ok: false; status: number; error: string };

const NOT_FOUND: VersionContentResult = { ok: false, status: 404, error: 'Not found' };

async function headsFor(recordingId: string, tid: string) {
  const heads = await listVersionHeads(recordingId);
  const head = heads.find((h) => h.id === tid) ?? null;
  const mergeBaseOf = (id: string) => heads.find((h) => h.id === id)?.mergeBase ?? null;
  return { head, mergeBaseOf };
}

export async function meetingVersionContent(
  row: StoredTranscript,
  ownerUserId: string,
  tid: string
): Promise<VersionContentResult> {
  const ref = await meetingRecordingRef(row.id);
  if (!ref) return NOT_FOUND;
  const { head, mergeBaseOf } = await headsFor(ref.recordingId, tid);
  if (!head) return NOT_FOUND;
  if (head.status !== 'completed') {
    return { ok: false, status: 409, error: `That version is ${head.status === 'error' ? 'a failed run' : 'still running'}.` };
  }

  const active = ref.activeTranscriptionId === tid;
  let content: TranscriptResponse | null;
  if (active) {
    // Exactly what `/content` serves.
    content = (await resolveMeetingContent(row)).content;
  } else {
    const payload = (await loadVersionPayloads(ref.recordingId, [tid])).get(tid);
    if (!payload) return NOT_FOUND;
    content = await resolveMeetingContentForVersion(row, ref.recordingId, { id: tid, payload });
  }
  if (!content) return { ok: false, status: 409, error: 'That version has no stored text.' };

  const sameLabels =
    !!ref.activeTranscriptionId &&
    labelSpaceOf(tid, mergeBaseOf) === labelSpaceOf(ref.activeTranscriptionId, mergeBaseOf);
  let names: Map<string, string> | null = null;
  if (sameLabels) {
    const mapping = await getSpeakerMappings(ownerUserId, row.assemblyai_id);
    names = new Map(
      ((mapping?.speaker_labels ?? []) as Array<{ originalSpeaker: string; customName: string }>).map(
        (l) => [l.originalSpeaker, l.customName]
      )
    );
  }

  return {
    ok: true,
    body: {
      transcriptionId: tid,
      active,
      utterances: contentUtterances(content, names),
      languageCode: content.language_code ?? null,
      provider: head.provider,
    },
  };
}

/** The same for a bare recording (owner-gated by the caller): no meeting, so no names. */
export async function recordingVersionContent(
  recordingId: string,
  activeTranscriptionId: string | null,
  tid: string
): Promise<VersionContentResult> {
  const { head } = await headsFor(recordingId, tid);
  if (!head) return NOT_FOUND;
  if (head.status !== 'completed') {
    return { ok: false, status: 409, error: `That version is ${head.status === 'error' ? 'a failed run' : 'still running'}.` };
  }
  const payload = (await loadVersionPayloads(recordingId, [tid])).get(tid);
  if (!payload) return { ok: false, status: 409, error: 'That version has no stored text.' };
  return {
    ok: true,
    body: {
      transcriptionId: tid,
      active: activeTranscriptionId === tid,
      utterances: contentUtterances(payload, null),
      languageCode: payload.language_code ?? null,
      provider: head.provider,
    },
  };
}

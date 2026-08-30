import 'server-only';
import { getForUser, mergeGmeetContextForUser } from '@/db-ops/transcripts';
import {
  getForUser as getMappingsForUser,
  upsertForUser as upsertMappingsForUser,
  type SpeakerLabel,
} from '@/db-ops/speaker-mappings';
import { getContentCached, generateAutoNotes, generateAutoReport } from '@/lib/server/auto-notes';
import { enrollFromTranscript } from '@/lib/server/voiceprint';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';

/**
 * Automatic speaker-review for series-auto-imported rows: the human review
 * gate stays the default, but when EVERY speaker that matters is identified
 * with high confidence there is nothing to resolve — apply the suggested
 * names and fire the configured generation unattended. Anything short of
 * that leaves the gate in place and DMs the owner to come review.
 *
 * Confidence sources (speaker_mappings.suggestions):
 *  - voiceprint match (source 'voice', cosine similarity) ≥ VOICE_MIN
 *  - the dedicated speaker-ID pass (via 'id', model-reported) ≥ ID_MIN
 * Speakers whose transcript label is already a real name (Meet Doc / Teams
 * VTT imports) need no resolution at all, and speakers with a single
 * utterance are noise the human reviewer routinely skips too.
 *
 * Only rows carrying gmeet_context.autoImport or .autoSync are touched — manual
 * imports and uploads keep the human gate unconditionally.
 */

const VOICE_MIN = 0.62;
const ID_MIN = 0.85;
/** Speakers with fewer utterances than this may stay unnamed without
 * blocking the jump-through (matches what human reviewers do). */
const MIN_UTTERANCES = 2;

/** AAI diarization labels look like "A" / "B" / "Speaker 1" — anything else
 * is already a real name (transcript-mode imports). */
function isDiarizationLabel(speaker: string): boolean {
  return /^[A-Z]{1,2}$/.test(speaker.trim()) || /^speaker\s*\d+$/i.test(speaker.trim());
}

export async function maybeAutoReview(ownerUserId: string, assemblyaiId: string): Promise<void> {
  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  const ai = row.gmeet_context?.autoImport;
  const as = row.gmeet_context?.autoSync;
  if (!ai && !as) return;
  // One shape for both automatic paths: who ran it, how to describe the
  // source in DMs, and everyone who should hear about it (account auto-sync
  // watchers were shared onto the row and want the same notes-ready DM).
  const auto = {
    byUserId: (ai ?? as)!.byUserId,
    byEmail: (ai ?? as)!.byEmail,
    source: ai ? `series *${ai.seriesTitle ?? ai.seriesId}*` : 'account auto-sync',
    recipients: Array.from(new Set([(ai ?? as)!.byEmail, ...(as?.watchers ?? [])])),
  };
  if (row.gmeet_context?.autoReview) return; // evaluated once, ever

  const pref = row.gmeet_context?.uploadPrefs?.report ?? 'summary';
  const url = `${APP_URL}/transcript/${assemblyaiId}`;
  const title = row.title?.trim() || 'Untitled meeting';
  const nowIso = new Date().toISOString();

  const content = await getContentCached(ownerUserId, row);
  const utterances = content?.utterances ?? [];
  if (utterances.length === 0) return; // not evaluable yet — retried on next completion hook

  const counts = new Map<string, number>();
  for (const u of utterances) counts.set(u.speaker, (counts.get(u.speaker) ?? 0) + 1);

  const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
  const existing = mappings?.speaker_labels ?? [];
  const suggestions = mappings?.suggestions ?? {};
  const named = new Map(
    existing.filter((l) => l.customName.trim()).map((l) => [l.originalSpeaker, l])
  );

  const applied: SpeakerLabel[] = [];
  let blocker: string | null = null;
  for (const [speaker, n] of counts) {
    if (named.has(speaker)) continue; // human (or a prior pass) already named it
    if (!isDiarizationLabel(speaker)) continue; // already a real name
    if (n < MIN_UTTERANCES) continue; // noise speaker — reviewers skip these too
    const s = suggestions[speaker];
    const confident =
      !!s?.name?.trim() &&
      ((s.source === 'voice' && s.confidence >= VOICE_MIN) ||
        (s.via === 'id' && s.confidence >= ID_MIN));
    if (!confident) {
      blocker = s?.name
        ? `"${speaker}" → ${s.name} only at ${(s.confidence * 100).toFixed(0)}% (${s.via === 'id' ? 'AI pass' : (s.source ?? 'context')})`
        : `no confident identification for speaker "${speaker}"`;
      break;
    }
    applied.push({ originalSpeaker: speaker, customName: s!.name.trim(), description: '' });
  }

  if (blocker) {
    await mergeGmeetContextForUser(ownerUserId, assemblyaiId, {
      autoReview: { evaluatedAt: nowIso, passed: false, reason: blocker },
    });
    for (const to of auto.recipients) {
      void notifyUser({
        kind: 'needs_review',
        toEmail: to,
        text: `Auto-imported *${title}* (${auto.source}) — speaker names need a quick review before the summary: <${url}|review speakers>`,
        dedupeKey: `mw-needs-review:${assemblyaiId}:${to}`,
      });
    }
    return;
  }

  // ---- Jump through the gate: apply names, enroll, generate, notify -------
  if (applied.length > 0) {
    const merged = [...existing];
    for (const l of applied) {
      const i = merged.findIndex((e) => e.originalSpeaker === l.originalSpeaker);
      if (i >= 0) merged[i] = { ...merged[i]!, customName: l.customName };
      else merged.push(l);
    }
    await upsertMappingsForUser(ownerUserId, assemblyaiId, merged);
    // Same free-enrollment rule as a human confirm.
    void (async () => {
      await enrollFromTranscript(row.local_audio_path, content, merged);
    })().catch((err) => console.warn('[auto-review] voiceprint enroll failed:', err));
  }

  await mergeGmeetContextForUser(ownerUserId, assemblyaiId, {
    autoReview: {
      evaluatedAt: nowIso,
      passed: true,
      generated: pref === 'later' ? null : pref,
    },
  });
  console.log(
    `[auto-review] ${assemblyaiId}: passed (${applied.length} auto-named) — generating ${pref}`
  );
  if (pref === 'later') return;

  const triggeredBy = { userId: auto.byUserId, email: auto.byEmail };
  if (pref === 'detailed-video' || pref === 'detailed-text') {
    await generateAutoReport(ownerUserId, assemblyaiId, {
      triggeredBy,
      useVideo: pref === 'detailed-video',
    });
  } else {
    await generateAutoNotes(ownerUserId, assemblyaiId, { triggeredBy });
  }

  const after = await getForUser(ownerUserId, assemblyaiId);
  const ok =
    pref === 'summary'
      ? after?.auto_notes_status === 'completed'
      : after?.auto_report_status === 'completed';
  if (ok) {
    for (const to of auto.recipients) {
      void notifyUser({
        kind: 'report_ready',
        toEmail: to,
        text: `${pref === 'summary' ? 'Summary' : 'Detailed report'} ready for *${title}* (auto-imported via ${auto.source}, speakers auto-identified) → <${url}|open>`,
        dedupeKey: `mw-report-ready:${assemblyaiId}:${to}`,
      });
    }
  }
}

import 'server-only';
import { getForUser, mergeGmeetContextForUser } from '@/db-ops/transcripts';
import {
  getForUser as getMappingsForUser,
  upsertForUser as upsertMappingsForUser,
} from '@/db-ops/speaker-mappings';
import { getContentCached, generateAutoReport } from '@/lib/server/auto-notes';
import { enrollFromTranscript } from '@/lib/server/voiceprint';
import { resolveMeetingContent } from '@/lib/server/recordings';
import { notifyUser, APP_URL } from '@/lib/server/darth-notify';
import { dm, headlines, meetingLine, runKey } from '@/lib/server/dm-copy';
import { autoMarkerOf, autoRecipients, autoSourceLabel } from '@/lib/auto-marker';
import { storedReportPref } from '@/lib/report-pref';
import { evaluateAutoReview } from '@/lib/auto-review-eval';
import { AUTO_PROCEED_GRACE_MIN, autoProceedDue, autoProceedFactsOf } from '@/lib/auto-proceed';
import { identityForUser } from '@/db-ops/transcript-activity';

/**
 * Automatic speaker-review for series-auto-imported rows: the human review
 * gate stays the default, but when EVERY speaker that matters is identified
 * with high confidence there is nothing to resolve — apply the suggested
 * names and fire the configured generation unattended. Anything short of
 * that leaves the gate in place and DMs the owner to come review.
 *
 * The DECISION (thresholds, noise speakers, real-name labels, what to
 * enrol) is `evaluateAutoReview` in lib/auto-review-eval.ts — pure, shared
 * with `autoProceedAfterGrace` below. This module is the side effects.
 *
 * `maybeAutoReview` touches only rows carrying an automation marker
 * (lib/auto-marker: gmeet_context.autoImport or .autoSync) — manual imports
 * and uploads keep the human gate at completion. Since 2026-10-27 those
 * manual rows get a second chance through `autoProceedAfterGrace`: the
 * sweeper evaluates them once, AUTO_PROCEED_GRACE_MIN after the speaker pass
 * finished, if nobody acted (lib/auto-proceed.ts has the eligibility rule).
 */

export async function maybeAutoReview(
  ownerUserId: string,
  assemblyaiId: string,
  /** Phase 2: the transcription that has just become live, when this is a
   * re-run. It goes into the two DM dedupe keys below so the second version's
   * "needs review" / "report ready" messages are not swallowed as duplicates
   * of the first version's (landmine #9). */
  transcriptionId?: string | null
): Promise<void> {
  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || row.status !== 'completed') return;
  const marker = autoMarkerOf(row.gmeet_context);
  if (!marker) return;
  // One shape for both automatic paths (lib/auto-marker): who ran it, how to
  // describe the source in DMs, and everyone who should hear about it —
  // importer + watchers, series or account alike. (Until 2026-09-08 series
  // rows carried no watchers, so a blocked review DM'd only the enabler.)
  const auto = {
    byUserId: marker.byUserId,
    byEmail: marker.byEmail,
    // Curated series v2 (§11.6): only the enabler (an owner/editor of the
    // series) is told its NAME — a watcher may not be able to see it.
    source: (to: string) =>
      marker.source === 'series' && to.trim().toLowerCase() !== marker.byEmail.trim().toLowerCase()
        ? 'a series auto-import'
        : autoSourceLabel(marker),
    recipients: autoRecipients(marker),
  };
  if (row.gmeet_context?.autoReview) return; // evaluated once, ever

  // Every generation writes BOTH tiers since 2026-09-21: firing the report
  // is what produces them (generateAutoReport distils the summary from its
  // own session). The pref only picks the report's flavour, or 'later'.
  // A row saved with the retired 'summary' reads as the detailed default.
  const pref = storedReportPref(row.gmeet_context?.uploadPrefs?.report);
  const url = `${APP_URL}/transcript/${assemblyaiId}`;
  const title = row.title?.trim() || 'Untitled meeting';
  const nowIso = new Date().toISOString();

  const content = await getContentCached(ownerUserId, row);
  const utterances = content?.utterances ?? [];
  if (utterances.length === 0) return; // not evaluable yet — retried on next completion hook

  const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
  const { blocker, applied, merged } = evaluateAutoReview({
    utterances,
    labels: mappings?.speaker_labels ?? [],
    suggestions: mappings?.suggestions,
  });

  if (blocker) {
    await mergeGmeetContextForUser(ownerUserId, assemblyaiId, {
      autoReview: { evaluatedAt: nowIso, passed: false, reason: blocker },
    });
    for (const to of auto.recipients) {
      void notifyUser({
        kind: 'needs_review',
        toEmail: to,
        text: dm(
          `👀 *Speakers need a quick look before the notes can be written*`,
          meetingLine({ title, when: row.recorded_at ?? row.created_at, duration: row.duration, speakerCount: row.speaker_count }),
          `Auto-imported via ${auto.source(to)}. What blocked the automatic pass: ${blocker}.`,
          `Confirm the names (usually 30 seconds) and the ${pref === 'later' ? 'notes' : 'summary + detailed report'} generates itself → <${url}|Review speakers>`
        ),
        dedupeKey: `mw-needs-review:${assemblyaiId}${runKey(transcriptionId)}:${to}`,
      });
    }
    return;
  }

  // ---- Jump through the gate: apply names, enroll, generate, notify -------
  if (applied.length > 0) {
    await upsertMappingsForUser(ownerUserId, assemblyaiId, merged);
    // Same free-enrollment rule as a human confirm (every name — the series
    // path enrols as it always has; the grace path below is the strict one).
    void (async () => {
      const resolved = await resolveMeetingContent(row);
      await enrollFromTranscript(resolved.media /* every file: a combined meeting embeds each recording's voices from ITS OWN file (mediaForSpeaker) */, content, merged);
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
    `[auto-review] ${assemblyaiId}: passed (${applied.length} auto-named) — generating summary + ${pref}`
  );
  if (pref === 'later') return;

  const triggeredBy = { userId: auto.byUserId, email: auto.byEmail };
  // One run, both tiers: the report pass verifies the most (frames,
  // attachments, cross-references) and the quick summary is distilled from
  // that same session when it lands. 'detailed-video' on a row that turns
  // out to have no video stream degrades to text-only inside the run.
  await generateAutoReport(ownerUserId, assemblyaiId, {
    triggeredBy,
    useVideo: pref === 'detailed-video',
  });

  const after = await getForUser(ownerUserId, assemblyaiId);
  const ok = after?.auto_report_status === 'completed';
  if (ok) {
    const gist = headlines(after?.auto_notes, 3);
    for (const to of auto.recipients) {
      void notifyUser({
        kind: 'report_ready',
        toEmail: to,
        text: dm(
          `📝 *Summary + detailed report ready*`,
          meetingLine({ title, when: row.recorded_at ?? row.created_at, duration: row.duration, speakerCount: row.speaker_count }),
          ...gist,
          `Auto-imported via ${auto.source(to)}, ${applied.length > 0 ? `${applied.length} speaker${applied.length === 1 ? '' : 's'} identified by voice` : 'speakers already named'} → <${url}|Read the full notes>`
        ),
        dedupeKey: `mw-report-ready:${assemblyaiId}${runKey(transcriptionId)}:${to}`,
      });
    }
  }
}

/**
 * The sweeper's grace-window pass for a MANUAL row (no automation marker):
 * a tray upload / make-meeting / split half whose speaker pass finished
 * AUTO_PROCEED_GRACE_MIN ago with nobody acting since. Same decision as the
 * series path (`evaluateAutoReview`), evaluated once, ever
 * (`gmeet_context.autoReview`, mode 'grace'):
 *
 *  - passed  → apply the names, enrol ONLY the strong matches
 *              (ENROLL_VOICE_MIN / ENROLL_ID_MIN — a 0.65 guess is named but
 *              never fed into a voiceprint), generate with the row's pref,
 *              DM the owner once ("written automatically — fix any name").
 *  - blocked → store the reason, send NO DM (the ready DM already went out
 *              at completion; the human gate stays).
 *
 * `listAutoProceedBacklog` (db-ops) picks candidates; `autoProceedDue` is
 * re-checked here on the fresh row because a person may have clicked
 * Generate, Hold or named someone since the query ran.
 */
export async function autoProceedAfterGrace(
  ownerUserId: string,
  assemblyaiId: string
): Promise<'proceeded' | 'blocked' | 'skipped'> {
  const row = await getForUser(ownerUserId, assemblyaiId);
  if (!row || !autoProceedDue(autoProceedFactsOf(row))) return 'skipped';

  const pref = storedReportPref(row.gmeet_context?.uploadPrefs?.report);
  const url = `${APP_URL}/transcript/${assemblyaiId}`;
  const title = row.title?.trim() || row.original_filename?.trim() || 'Untitled meeting';
  const nowIso = new Date().toISOString();

  const content = await getContentCached(ownerUserId, row);
  const utterances = content?.utterances ?? [];
  if (utterances.length === 0) return 'skipped'; // nothing to evaluate yet; stays pickable inside the window

  const mappings = await getMappingsForUser(ownerUserId, assemblyaiId);
  const ev = evaluateAutoReview({
    utterances,
    labels: mappings?.speaker_labels ?? [],
    suggestions: mappings?.suggestions,
  });

  if (!ev.passed) {
    await mergeGmeetContextForUser(ownerUserId, assemblyaiId, {
      autoReview: { evaluatedAt: nowIso, passed: false, mode: 'grace', reason: ev.blocker ?? 'blocked' },
    });
    console.log(`[auto-proceed] ${assemblyaiId}: blocked — ${ev.blocker}`);
    return 'blocked';
  }

  if (ev.applied.length > 0) {
    await upsertMappingsForUser(ownerUserId, assemblyaiId, ev.merged);
    if (ev.enroll.length > 0) {
      void (async () => {
        const resolved = await resolveMeetingContent(row);
        await enrollFromTranscript(resolved.media /* every file: a combined meeting embeds each recording's voices from ITS OWN file (mediaForSpeaker) */, content, ev.enroll);
      })().catch((err) => console.warn('[auto-proceed] voiceprint enroll failed:', err));
    }
  }

  await mergeGmeetContextForUser(ownerUserId, assemblyaiId, {
    autoReview: { evaluatedAt: nowIso, passed: true, mode: 'grace', generated: pref },
  });
  const owner = await identityForUser(ownerUserId);
  console.log(
    `[auto-proceed] ${assemblyaiId}: passed after ${AUTO_PROCEED_GRACE_MIN} min (${ev.applied.length} auto-named, ${ev.enroll.length} enrolled) — generating summary + ${pref}`
  );
  await generateAutoReport(ownerUserId, assemblyaiId, {
    triggeredBy: owner ? { userId: owner.userId, email: owner.email } : undefined,
    useVideo: pref === 'detailed-video',
  });

  const after = await getForUser(ownerUserId, assemblyaiId);
  if (owner && after?.auto_report_status === 'completed') {
    const names = ev.merged.map((l) => l.customName.trim()).filter(Boolean);
    void notifyUser({
      kind: 'report_ready',
      toEmail: owner.email,
      text: dm(
        `📝 *Summary written automatically*`,
        meetingLine({ title, when: row.recorded_at ?? row.created_at, duration: row.duration, speakerCount: row.speaker_count }),
        ...headlines(after.auto_notes, 2),
        `Nobody reviewed the speakers within ${AUTO_PROCEED_GRACE_MIN} min of the AI pass and every voice was identified confidently — ${names.length > 0 ? `speakers: ${names.join(', ')}` : 'speakers already named'}. Fix any name → <${url}|Open the meeting>`
      ),
      dedupeKey: `mw-auto-proceed:${assemblyaiId}:${owner.email}`,
    });
  }
  return 'proceeded';
}

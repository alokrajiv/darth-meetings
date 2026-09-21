'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { SpeakerSuggestionMap, StoredTranscript } from '@/lib/format';
import {
  DEFAULT_SPEECH_MODEL,
  LEGACY_SPEECH_MODEL,
  speechModelLabel,
} from '@/lib/aai-language';
import {
  aaiOutcome,
  aaiOutcomeNote,
  aaiOutcomeSentence,
  languageLabel,
  pctLabel,
} from '@/lib/aai-outcome';
import { isPersonName } from '@/lib/speaker-name-kind';
import {
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Fingerprint,
  Loader2,
  Sparkles,
  Video,
} from 'lucide-react';

interface TranscriptSourcesCardProps {
  row: StoredTranscript;
  suggestions: SpeakerSuggestionMap;
  canEdit: boolean;
  /** Offline mode: re-transcribe actions need the server — shown but inert. */
  disabled?: boolean;
}

/**
 * "Sources" rail card: which transcript/diarization sources exist on this
 * row (summaries and name-guessing automatically use everything present),
 * plus multi-video coverage. The recording itself (source, segments, media
 * availability, fetch/add recovery) lives in RecordingCard — this card keeps
 * only the analysis-side facts.
 */
export function TranscriptSourcesCard({
  row,
  suggestions,
  canEdit,
  disabled = false,
}: TranscriptSourcesCardProps) {
  const [error, setError] = useState<string | null>(null);

  const isMeetPrimary = row.assemblyai_id.startsWith('gmeet-');
  // Teams quick import: the primary content IS the Teams VTT (no AAI ran).
  const isTeamsPrimary = row.assemblyai_id.startsWith('teams-');
  const ctx = row.gmeet_context;
  const isTeams = ctx?.provider === 'teams';
  // Sidecar cross-check only makes sense when the PRIMARY is diarized audio
  // (video/both imports) — on quick imports the sidecar is the same content.
  const hasSidecar =
    !isMeetPrimary && !isTeamsPrimary && (ctx?.meetTranscript?.utterances?.length ?? 0) > 0;

  // A voiceprint enrolled under a group label ("mixed") is not a person heard
  // — it never reaches this list (docs/transcript-page-redesign.md §5).
  const voiceMatches = Object.values(suggestions).filter(
    (s) => s.source === 'voice' && isPersonName(s.name)
  );
  const alignMatches = Object.values(suggestions).filter(
    (s) => s.source === 'context' && s.confidence > 0 && isPersonName(s.name)
  );

  const recordingFileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  const teamsRecordingId = isTeams ? ctx?.teams?.recordingId : undefined;
  /** A recording we know how to get: Drive file (Meet) or Graph id (Teams). */
  const knownRecording = recordingFileId ?? teamsRecordingId;
  // --- Multi-video meetings (stop-restart recording → several Drive files).
  // Every segment beyond the primary is tracked in videoParts; segments
  // Google is still generating are counted from the actuals snapshot while
  // the pending watch is live. Surfacing these is the whole point — a second
  // video that exists but isn't shown reads as "the meeting is missing".
  const videoParts = ctx?.videoParts ?? [];
  const partsStored = videoParts.filter((p) => p.filename).length;
  const partsFetching = videoParts.filter((p) => !p.filename).length;
  const partsGenerating =
    ctx?.recordingPending?.status === 'waiting'
      ? (ctx?.actuals?.recordings ?? []).filter((r) => !r.fileId).length
      : 0;
  const totalVideos =
    (row.local_audio_path || knownRecording ? 1 : 0) +
    videoParts.length +
    partsGenerating;
  const multiVideo = totalVideos > 1;
  // The AAI transcription ran on the primary video only — when other
  // segments exist, the transcript does NOT cover them. Say so loudly.
  const transcriptCoversPartOnly =
    multiVideo && !isMeetPrimary && !isTeamsPrimary;

  // Cheap pooled-mic tell on quick imports: Meet's snapshot knows who
  // actually JOINED; if clearly more people joined than Meet heard voices,
  // several of them almost certainly shared one room mic. Pure metadata —
  // no audio analysis needed. (Silent joiners make this a hint, not proof.)
  // Deliberately a recommendation, never an auto-run — and only shown when
  // acting on it is actually possible (audio stored, or fetchable from
  // Drive). The user makes the call.
  const joinedCount = (ctx?.actuals?.participants ?? []).filter(
    (p) => p.kind !== 'phone'
  ).length;
  const pooledMicSuspected =
    isMeetPrimary &&
    (!!row.local_audio_path || !!recordingFileId) &&
    joinedCount > 0 &&
    (row.speaker_count ?? 0) > 0 &&
    joinedCount - (row.speaker_count ?? 0) >= 2;

  // Quick imports (gmeet-/teams- primaries) never ran AssemblyAI: the text
  // is what Meet/Teams wrote, so no acoustic diarization, no voiceprints.
  // When the meeting's video is stored (or fetchable), offer the full
  // pipeline over it — same re-run-from-local path as the multi-video
  // combine below; the native transcript rides along as the sidecar.
  const [retranscribing, setRetranscribing] = useState<null | 'fetching' | 'submitting'>(
    null
  );
  const canRetranscribeFromVideo =
    canEdit &&
    (isMeetPrimary || isTeamsPrimary) &&
    (!!row.local_audio_path || !!knownRecording) &&
    !partsFetching &&
    partsGenerating === 0;
  const retranscribeFromVideo = async () => {
    const needsFetch = !row.local_audio_path;
    if (
      !window.confirm(
        `Re-transcribe this meeting from its video with AssemblyAI (acoustic speaker separation + voiceprints)?` +
          (needsFetch
            ? ` The recording is downloaded from ${isTeams ? 'Microsoft 365' : 'Google Drive'} first.`
            : '') +
          ' Takes a few minutes and uses transcription credit; a new transcript is created alongside this one, which stays untouched.'
      )
    ) {
      return;
    }
    setError(null);
    try {
      if (needsFetch) {
        setRetranscribing('fetching');
        const fr = await fetch(`/api/transcripts/${row.assemblyai_id}/fetch-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const fp = (await fr.json().catch(() => ({}))) as { error?: string };
        if (!fr.ok) throw new Error(fp.error || `Video fetch failed (${fr.status})`);
      }
      setRetranscribing('submitting');
      const res = await fetch('/api/gmeet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: (ctx?.meetTranscript?.utterances?.length ?? 0) > 0 ? 'both' : 'video',
          sourceTranscriptId: row.assemblyai_id,
          force: true,
          event: {
            id: ctx?.eventId,
            title: ctx?.eventTitle ?? row.title ?? undefined,
            startTime: ctx?.startTime,
            endTime: ctx?.endTime,
            meetingCode: ctx?.meetingCode,
            attendees: ctx?.attendees ?? [],
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        transcript?: { assemblyai_id?: string };
        error?: string;
      };
      if (!res.ok || !payload.transcript?.assemblyai_id) {
        throw new Error(payload.error || `Failed (${res.status})`);
      }
      window.location.href = `/transcript/${payload.transcript.assemblyai_id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-transcribe failed');
      setRetranscribing(null);
    }
  };

  const [combining, setCombining] = useState(false);
  // One-click fix for the "transcript covers Video 1 only" state: the server
  // concatenates the stored segments and runs a fresh AAI transcription over
  // the whole meeting (new row alongside; this one stays untouched).
  const canCombineRetranscribe =
    canEdit && transcriptCoversPartOnly && !!row.local_audio_path && partsStored > 0;
  const combineAndRetranscribe = async () => {
    if (
      !window.confirm(
        `Combine all ${partsStored + 1} videos and transcribe the full meeting with AssemblyAI? ` +
          'Takes a few minutes and uses transcription credit; a new transcript is created alongside this one.'
      )
    ) {
      return;
    }
    setCombining(true);
    setError(null);
    try {
      const res = await fetch('/api/gmeet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: ctx?.meetingCode || ctx?.transcriptDocId ? 'both' : 'video',
          sourceTranscriptId: row.assemblyai_id,
          force: true,
          event: {
            id: ctx?.eventId,
            title: ctx?.eventTitle,
            startTime: ctx?.startTime,
            endTime: ctx?.endTime,
            meetingCode: ctx?.meetingCode,
            attendees: ctx?.attendees ?? [],
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        transcript?: { assemblyai_id?: string };
        error?: string;
      };
      if (!res.ok || !payload.transcript?.assemblyai_id) {
        throw new Error(payload.error || `Failed (${res.status})`);
      }
      window.location.href = `/transcript/${payload.transcript.assemblyai_id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Combine & re-transcribe failed');
      setCombining(false);
    }
  };

  // --- "Re-transcribe with the newer model": AAI-transcribed rows (uuid
  // ids) that ran on the pre-2026-09 model and still have their audio. A
  // new row is created alongside; this one stays and points at it.
  const isAaiRow = !isMeetPrimary && !isTeamsPrimary && !row.assemblyai_id.startsWith('up-');
  const rowModel = row.speech_model ?? LEGACY_SPEECH_MODEL;
  const onOlderModel = isAaiRow && rowModel !== DEFAULT_SPEECH_MODEL;
  const retranscribed = ctx?.retranscribed ?? null;
  const canUpgradeModel = canEdit && onOlderModel && !!row.local_audio_path && !retranscribed;
  const [upgrading, setUpgrading] = useState(false);
  const [upgradedTo, setUpgradedTo] = useState<string | null>(retranscribed?.newId ?? null);
  const upgradeModel = async () => {
    if (
      !window.confirm(
        `Re-transcribe this meeting with AssemblyAI ${speechModelLabel(DEFAULT_SPEECH_MODEL)}? ` +
          'Better punctuation, speaker separation and mixed-language handling; a few English words inside ' +
          'Chinese speech may come back split ("em ail"). Takes a few minutes and uses transcription credit; ' +
          'a new transcript is created alongside this one, which stays untouched. You get a Slack DM when it is ready.'
      )
    ) {
      return;
    }
    setUpgrading(true);
    setError(null);
    try {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/retranscribe`, { method: 'POST' });
      const payload = (await res.json().catch(() => ({}))) as { newId?: string; error?: string };
      if (!res.ok || !payload.newId) throw new Error(payload.error || `Failed (${res.status})`);
      setUpgradedTo(payload.newId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-transcribe failed');
    } finally {
      setUpgrading(false);
    }
  };

  const pct = (c: number) => `${Math.round(c * 100)}%`;

  // --- What AssemblyAI actually did (lib/aai-outcome.ts). Until 2026-09-21
  // this card printed the model we ASKED for, which was plainly false on the
  // rows AAI downgraded to Universal-2. One plain sentence for everyone, a
  // calm amber line when the outcome affects how the text should be read,
  // and the raw facts behind a disclosure for whoever wants them.
  const outcome = aaiOutcome(row);
  const outcomeSentence = isAaiRow ? aaiOutcomeSentence(outcome) : null;
  const outcomeNote = isAaiRow ? aaiOutcomeNote(outcome) : null;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Sources
      </div>
      <ul className="mt-2 space-y-1.5 text-xs">
        <li className="flex items-start gap-2">
          <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span>
            {isMeetPrimary ? (
              <>
                <span className="font-medium">Google Meet transcript</span>
                <span className="text-muted-foreground">
                  {' '}
                  — Google&apos;s speaker labels (device-level; a shared room mic is one
                  speaker)
                </span>
              </>
            ) : isTeamsPrimary ? (
              <>
                <span className="font-medium">Microsoft Teams transcript</span>
                <span className="text-muted-foreground">
                  {' '}
                  — Teams&apos; speaker labels (device-level; a shared room mic is one
                  speaker)
                </span>
              </>
            ) : (
              <>
                <span className="font-medium">Voice-level diarization</span>
                <span className="text-muted-foreground">
                  {' '}
                  — speakers separated acoustically from the audio
                </span>
              </>
            )}
          </span>
        </li>
        {hasSidecar && (
          <li className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-ok" />
            <span>
              <span className="font-medium">
                {isTeams ? 'Teams' : 'Meet'} transcript cross-check
              </span>
              <span className="text-muted-foreground">
                {' '}
                — {isTeams ? "Microsoft's" : "Google's"} transcript rides along; summaries
                use it to fix names and garbled words
              </span>
            </span>
          </li>
        )}
        {voiceMatches.length > 0 && (
          <li className="flex items-start gap-2">
            <Fingerprint className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">
                Voiceprint: {voiceMatches.length} speaker{voiceMatches.length > 1 ? 's' : ''}{' '}
                matched
              </span>
              <span className="text-muted-foreground">
                {' '}
                ({voiceMatches.map((s) => `${s.name} ${pct(s.confidence)}`).join(', ')})
              </span>
            </span>
          </li>
        )}
        {alignMatches.length > 0 && (
          <li className="flex items-start gap-2">
            <AudioWaveform className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">
                Meet-timeline match: {alignMatches.length} speaker
                {alignMatches.length > 1 ? 's' : ''}
              </span>
              <span className="text-muted-foreground">
                {' '}
                ({alignMatches.map((s) => `${s.name} ${pct(s.confidence)}`).join(', ')})
              </span>
            </span>
          </li>
        )}
        {/* Segments (Darth Recorder / stitched uploads) moved to the Recording card — components/recording-card.tsx */}
        {multiVideo && (
          <li className="flex items-start gap-2">
            <Video className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">
                {totalVideos} videos in this meeting
              </span>
              <span className="text-muted-foreground">
                {' '}
                — the recording was stopped and restarted, so Meet made separate files.
                {partsStored > 0 && ' Switch between them in the player.'}
              </span>
              {partsFetching > 0 && (
                <span className="mt-0.5 block text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {partsFetching} video{partsFetching > 1 ? 's' : ''} downloading from
                    Drive…
                  </span>
                </span>
              )}
              {partsGenerating > 0 && (
                <span className="mt-0.5 block text-amber-600 dark:text-amber-500">
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {partsGenerating} video{partsGenerating > 1 ? 's' : ''} — Google is
                    still preparing the file; we check every minute and attach it
                    automatically.
                  </span>
                </span>
              )}
            </span>
          </li>
        )}
      </ul>
      {transcriptCoversPartOnly && (
        <p className="mt-2 rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Heads-up: the transcript and AI notes cover <span className="font-semibold">Video 1
          only</span> — the other video{totalVideos > 2 ? 's are' : ' is'} playable in the
          player but not transcribed.
        </p>
      )}
      {canRetranscribeFromVideo && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
          disabled={disabled || retranscribing !== null}
          onClick={() => void retranscribeFromVideo()}
          title={disabled ? 'Not available offline' : `This transcript is the text ${isTeams ? 'Teams' : 'Meet'} wrote — no acoustic speaker separation or voiceprint matching ran. Run the full AssemblyAI pipeline over the meeting video; a new transcript is created alongside this one`}
        >
          {retranscribing ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <AudioWaveform className="h-4 w-4 text-primary" />
          )}
          {retranscribing === 'fetching'
            ? 'Downloading the video…'
            : retranscribing === 'submitting'
              ? 'Submitting for transcription…'
              : row.local_audio_path
                ? 'Re-transcribe from video'
                : 'Fetch video & re-transcribe'}
        </Button>
      )}
      {canCombineRetranscribe && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
          disabled={disabled || combining}
          onClick={() => void combineAndRetranscribe()}
          title={disabled ? 'Not available offline' : 'Concatenate every stored video of this meeting and run a fresh AssemblyAI transcription over the whole thing — a new transcript is created alongside this one'}
        >
          {combining ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Video className="h-4 w-4 text-primary" />
          )}
          {combining
            ? 'Combining & submitting…'
            : `Transcribe all ${partsStored + 1} videos together`}
        </Button>
      )}
      {isAaiRow && outcomeSentence && (
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {outcomeSentence}
          {upgradedTo && (
            <>
              {' '}
              Re-run with {speechModelLabel(DEFAULT_SPEECH_MODEL)}
              {retranscribed?.at ? ` on ${new Date(retranscribed.at).toLocaleDateString()}` : ''} →{' '}
              <a className="underline" href={`/transcript/${upgradedTo}`}>
                open the new transcript
              </a>
              .
            </>
          )}
        </p>
      )}
      {outcomeNote && (
        <p className="mt-1.5 rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {outcomeNote}
        </p>
      )}
      {isAaiRow && outcomeSentence && (
        <>
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Advanced details
            {advancedOpen ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
          {advancedOpen && (
            <div className="mt-1 space-y-0.5 rounded-md border bg-muted/30 px-2 py-1.5 text-[11px] leading-snug">
              <AdvancedRow label="Model asked for">
                {outcome.requested ? speechModelLabel(outcome.requested) : 'not recorded'}
              </AdvancedRow>
              <AdvancedRow label="Model that ran">
                {outcome.used ? speechModelLabel(outcome.used) : 'not recorded'}
                {outcome.downgraded ? ' — AssemblyAI fell back' : ''}
              </AdvancedRow>
              <AdvancedRow label="Language">
                {outcome.languageCode
                  ? `${languageLabel(outcome.languageCode)} (${outcome.languageCode})`
                  : 'not recorded'}
                {outcome.languageDetected
                  ? ` · detected by AssemblyAI${
                      outcome.languageConfidence !== null
                        ? `, ${pctLabel(outcome.languageConfidence)} confident`
                        : ''
                    }`
                  : ' · set by us, no detection'}
              </AdvancedRow>
              <AdvancedRow label="Transcript confidence">
                {outcome.asrConfidence !== null
                  ? pctLabel(outcome.asrConfidence)
                  : 'not recorded'}
              </AdvancedRow>
              <AdvancedRow label="Attendee-name hints">
                {outcome.keytermsSent > 0
                  ? `${outcome.keytermsSent} sent${
                      outcome.keytermsDropped ? ', not applied by AssemblyAI' : ''
                    }`
                  : 'none sent'}
              </AdvancedRow>
              {outcome.warnings.length > 0 && (
                <AdvancedRow label="AssemblyAI warnings">
                  <span className="space-y-0.5">
                    {outcome.warnings.map((w, i) => (
                      <span key={i} className="block break-words">
                        {w}
                      </span>
                    ))}
                  </span>
                </AdvancedRow>
              )}
              <AdvancedRow label="Job id">
                <span className="break-all font-mono">{outcome.jobId ?? '—'}</span>
              </AdvancedRow>
              {outcome.noteworthy && (
                <p className="pt-1 text-muted-foreground">
                  why: docs/eval-aai-code-switching-2026-09-21.md
                </p>
              )}
            </div>
          )}
        </>
      )}
      {canUpgradeModel && !upgradedTo && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
          disabled={disabled || upgrading}
          onClick={() => void upgradeModel()}
          title={
            disabled
              ? 'Not available offline'
              : outcome.downgraded
                ? // AAI already fell back once for this language — asking for
                  // the newer model again lands on exactly the same one.
                  `AssemblyAI does not support ${languageLabel(outcome.languageCode) ?? 'this language'} on ${speechModelLabel(DEFAULT_SPEECH_MODEL)}, so a re-run would produce the same result — see Advanced details`
                : `Run this meeting's stored audio through AssemblyAI ${speechModelLabel(DEFAULT_SPEECH_MODEL)} — a new transcript is created alongside this one`
          }
        >
          {upgrading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Sparkles className="h-4 w-4 text-primary" />
          )}
          {upgrading ? 'Submitting…' : `Re-transcribe with ${speechModelLabel(DEFAULT_SPEECH_MODEL)}`}
        </Button>
      )}
      {pooledMicSuspected && (
        <p className="mt-2 rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {joinedCount} people joined but Meet heard only {row.speaker_count} voice
          {(row.speaker_count ?? 0) > 1 ? 's' : ''} — several likely shared one room mic.
          &ldquo;Diarize with AssemblyAI&rdquo; separates them by voice
          {row.local_audio_path
            ? '.'
            : ' (fetch the video first — see Recording above).'}
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Summaries and name guesses automatically use everything listed here.
      </p>
    </div>
  );
}

/** Label/value row inside the Advanced details disclosure. */
function AdvancedRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

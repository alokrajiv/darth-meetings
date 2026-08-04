'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getGoogleAccessToken } from '@/lib/google-token';
import type { SpeakerSuggestionMap, StoredTranscript } from '@/lib/format';
import {
  AudioLines,
  AudioWaveform,
  CheckCircle2,
  FileText,
  Fingerprint,
  Loader2,
} from 'lucide-react';

interface TranscriptSourcesCardProps {
  row: StoredTranscript;
  suggestions: SpeakerSuggestionMap;
  /** Player-level truth: false once the <audio> element errored. */
  audioAvailable: boolean;
  canEdit: boolean;
  /** Called after the Drive recording landed on the server. */
  onAudioFetched: () => void;
}

/**
 * "Sources" rail card: which transcript/diarization sources exist on this
 * row (summaries and name-guessing automatically use everything present),
 * plus whether audio playback is available — with a "Fetch audio" action
 * for Meet quick-imports whose recording is known on Drive but whose bytes
 * were never pulled (transcript-only imports have no audio by design).
 */
export function TranscriptSourcesCard({
  row,
  suggestions,
  audioAvailable,
  canEdit,
  onAudioFetched,
}: TranscriptSourcesCardProps) {
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMeetPrimary = row.assemblyai_id.startsWith('gmeet-');
  const ctx = row.gmeet_context;
  const hasSidecar = !isMeetPrimary && (ctx?.meetTranscript?.utterances?.length ?? 0) > 0;

  const voiceMatches = Object.values(suggestions).filter((s) => s.source === 'voice');
  const alignMatches = Object.values(suggestions).filter(
    (s) => s.source === 'context' && s.confidence > 0
  );

  const hasAudio =
    audioAvailable && !!(row.local_audio_path || row.audio_url || row.source === 'uploaded');
  const recordingFileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  const canFetchAudio = !hasAudio && !row.local_audio_path && !!recordingFileId && canEdit;

  const fetchAudio = async () => {
    setFetching(true);
    setError(null);
    try {
      const token = await getGoogleAccessToken(); // popup — user gesture
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/fetch-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || `Failed (${res.status})`);
      onAudioFetched();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio fetch failed');
    } finally {
      setFetching(false);
    }
  };

  const pct = (c: number) => `${Math.round(c * 100)}%`;

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
              <span className="font-medium">Meet transcript cross-check</span>
              <span className="text-muted-foreground">
                {' '}
                — Google&apos;s transcript rides along; summaries use it to fix names and
                garbled words
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
        <li className="flex items-start gap-2">
          <AudioLines
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${hasAudio ? 'text-status-ok' : 'text-muted-foreground'}`}
          />
          <span>
            {hasAudio ? (
              <>
                <span className="font-medium">Audio available</span>
                <span className="text-muted-foreground"> — playback &amp; voiceprints work</span>
              </>
            ) : recordingFileId ? (
              <span className="text-muted-foreground">
                No audio stored — the recording is on Drive
              </span>
            ) : (
              <span className="text-muted-foreground">
                No audio — this import never had a recording
              </span>
            )}
          </span>
        </li>
      </ul>
      {canFetchAudio && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
          disabled={fetching}
          onClick={() => void fetchAudio()}
          title="Download the recording from Drive to this server so the play bar works — no re-transcription, the transcript stays as-is"
        >
          {fetching ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <AudioLines className="h-4 w-4 text-primary" />
          )}
          {fetching ? 'Fetching from Drive…' : 'Fetch audio for playback'}
        </Button>
      )}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Summaries and name guesses automatically use everything listed here.
      </p>
    </div>
  );
}

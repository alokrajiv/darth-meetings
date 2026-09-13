'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { GmeetContext } from '@/lib/format';
import { AudioWaveform, Loader2 } from 'lucide-react';

interface RerunDiarizationButtonProps {
  assemblyaiId: string;
  gmeetContext: GmeetContext | null | undefined;
  /** Whether this row already has the recording's audio stored locally
   * (fetch-audio). Diarization runs on that copy — without it the button
   * renders disabled with a pointer to the Sources card. */
  hasLocalAudio: boolean;
  /** Compact rendering for a quick-actions rail. */
  size?: 'sm' | 'default';
  /** Button variant — e.g. 'ghost' to match a rail's justify-start recipe. */
  variant?: 'outline' | 'ghost';
  /** Applied directly to the Button so callers control width/alignment. */
  className?: string;
  /** Offline mode: the run needs the server, keep the button visible but inert. */
  disabled?: boolean;
}

/**
 * "Diarize with AssemblyAI": upgrade a Meet-transcript-only import (device-
 * level speaker attribution — one room mic = one speaker) to a voice-level
 * AAI transcription. Runs on the recording ALREADY stored by "Fetch video
 * for playback" — one Drive download total, no Google popup here; the server
 * reuses the stored Meet context (actuals + transcript sidecar) too. A NEW
 * transcript row is created (processing) and we navigate to it; the quick
 * import stays untouched.
 *
 * Renders only on Meet quick-imports (rows that are already AAI-diarized
 * have nothing to gain); disabled until the audio has been fetched.
 */
export function RerunDiarizationButton({
  assemblyaiId,
  gmeetContext,
  hasLocalAudio,
  size = 'sm',
  variant = 'outline',
  className,
  disabled = false,
}: RerunDiarizationButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoFileId = gmeetContext?.videoFileId ?? gmeetContext?.actuals?.recordings?.[0]?.fileId;
  if (!assemblyaiId.startsWith('gmeet-') || (!videoFileId && !hasLocalAudio)) return null;

  const run = async () => {
    if (
      !window.confirm(
        'Run voice-level speaker separation (AssemblyAI) on the stored audio? ' +
          'Takes a few minutes and uses transcription credit; a new transcript is created alongside this one — the Meet transcript stays untouched.'
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gmeet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'both',
          sourceTranscriptId: assemblyaiId,
          videoFileId,
          force: true,
          event: {
            id: gmeetContext?.eventId,
            title: gmeetContext?.eventTitle,
            startTime: gmeetContext?.startTime,
            endTime: gmeetContext?.endTime,
            meetingCode: gmeetContext?.meetingCode,
            attendees: gmeetContext?.attendees ?? [],
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        transcript?: { assemblyai_id?: string };
        existing?: { assemblyai_id?: string };
        error?: string;
      };
      if (res.status === 409 && payload.existing?.assemblyai_id) {
        window.location.href = `/transcript/${payload.existing.assemblyai_id}`;
        return;
      }
      if (!res.ok) throw new Error(payload.error || `Failed (${res.status})`);
      const newId = payload.transcript?.assemblyai_id;
      if (newId) window.location.href = `/transcript/${newId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start diarization');
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => void run()}
        disabled={disabled || busy || !hasLocalAudio}
        title={
          disabled
            ? 'Not available offline'
            : hasLocalAudio
            ? 'Voice-level speaker separation from the stored audio — for meetings where several people shared one mic'
            : 'Fetch video for playback first (Sources card below) — diarization runs on that stored copy'
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <AudioWaveform className="h-4 w-4 text-muted-foreground" />
        )}
        {busy ? 'Submitting to AssemblyAI…' : 'Diarize with AssemblyAI'}
      </Button>
      {error && <p className="px-2 text-xs text-destructive">{error}</p>}
    </>
  );
}

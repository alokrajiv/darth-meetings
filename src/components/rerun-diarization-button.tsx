'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { getGoogleAccessToken } from '@/lib/google-token';
import type { GmeetContext } from '@/lib/format';
import { AudioWaveform, Loader2 } from 'lucide-react';

interface RerunDiarizationButtonProps {
  assemblyaiId: string;
  gmeetContext: GmeetContext | null | undefined;
  /** Compact rendering for a quick-actions rail. */
  size?: 'sm' | 'default';
  className?: string;
}

/**
 * "Re-run with diarization": upgrade a Meet-transcript-only import (device-
 * level speaker attribution) to a full AAI transcription of the recording
 * (voice-level separation). Fetches the video from Drive with a fresh
 * browser Google token and submits it through the normal import pipeline —
 * a NEW transcript row is created (processing) and we navigate to it; the
 * quick import stays untouched.
 *
 * Renders nothing unless this row IS a Meet quick-import that has a known
 * recording on Drive.
 */
export function RerunDiarizationButton({
  assemblyaiId,
  gmeetContext,
  size = 'sm',
  className,
}: RerunDiarizationButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoFileId = gmeetContext?.videoFileId ?? gmeetContext?.actuals?.recordings?.[0]?.fileId;
  if (!assemblyaiId.startsWith('gmeet-') || !videoFileId) return null;

  const run = async () => {
    if (
      !window.confirm(
        'Re-transcribe the original recording with voice-level speaker separation? ' +
          'This fetches the video from Drive and takes a few minutes; a new transcript is created alongside this one.'
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await getGoogleAccessToken(); // popup — user gesture
      const res = await fetch('/api/gmeet/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: token,
          mode: 'both',
          videoFileId,
          transcriptDocId: gmeetContext?.transcriptDocId,
          conferenceRecordName: gmeetContext?.actuals?.conferenceRecordName,
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
      setError(err instanceof Error ? err.message : 'Failed to start re-run');
      setBusy(false);
    }
  };

  return (
    <span className={className}>
      <Button variant="outline" size={size} onClick={() => void run()} disabled={busy} title="Fetch the recording from Drive and re-transcribe with voice-level speaker separation">
        {busy ? (
          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
        ) : (
          <AudioWaveform className="h-4 w-4 mr-1.5" />
        )}
        {busy ? 'Fetching recording…' : 'Re-run diarization'}
      </Button>
      {error && <span className="ml-2 text-xs text-red-500">{error}</span>}
    </span>
  );
}

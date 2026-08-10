'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { SpeakerSuggestionMap, StoredTranscript } from '@/lib/format';
import {
  AudioLines,
  AudioWaveform,
  CheckCircle2,
  FileText,
  Fingerprint,
  Loader2,
  Upload,
  Video,
} from 'lucide-react';

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts / nginx.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

interface TranscriptSourcesCardProps {
  row: StoredTranscript;
  suggestions: SpeakerSuggestionMap;
  /** Player-level truth: false once the <audio> element errored. */
  audioAvailable: boolean;
  canEdit: boolean;
  /** Drive-recording fetch state lives in the page — it auto-fetches on
   * load, and the report dialog needs to see the same in-flight state. */
  videoFetching: boolean;
  videoFetchError: string | null;
  onFetchVideo: () => void;
}

/**
 * "Sources" rail card: which transcript/diarization sources exist on this
 * row (summaries and name-guessing automatically use everything present),
 * plus whether playback is available — with a "Fetch video" retry action
 * for Meet quick-imports whose recording is known on Drive but whose bytes
 * were never pulled (the page auto-fetches on load; transcript-only imports
 * have no recording by design).
 */
export function TranscriptSourcesCard({
  row,
  suggestions,
  audioAvailable,
  canEdit,
  videoFetching,
  videoFetchError,
  onFetchVideo,
}: TranscriptSourcesCardProps) {
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const isMeetPrimary = row.assemblyai_id.startsWith('gmeet-');
  // Teams quick import: the primary content IS the Teams VTT (no AAI ran).
  const isTeamsPrimary = row.assemblyai_id.startsWith('teams-');
  const ctx = row.gmeet_context;
  const isTeams = ctx?.provider === 'teams';
  // Sidecar cross-check only makes sense when the PRIMARY is diarized audio
  // (video/both imports) — on quick imports the sidecar is the same content.
  const hasSidecar =
    !isMeetPrimary && !isTeamsPrimary && (ctx?.meetTranscript?.utterances?.length ?? 0) > 0;

  const voiceMatches = Object.values(suggestions).filter((s) => s.source === 'voice');
  const alignMatches = Object.values(suggestions).filter(
    (s) => s.source === 'context' && s.confidence > 0
  );

  const hasAudio =
    audioAvailable && !!(row.local_audio_path || row.audio_url || row.source === 'uploaded');
  const recordingFileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  const teamsRecordingId = isTeams ? ctx?.teams?.recordingId : undefined;
  /** A recording we know how to get: Drive file (Meet) or Graph id (Teams). */
  const knownRecording = recordingFileId ?? teamsRecordingId;
  const recordingHost = teamsRecordingId && !recordingFileId ? 'Microsoft 365' : 'Drive';
  // Meet recorded the meeting but Google hadn't finished the file at import
  // time — the server re-checks every minute and attaches it automatically.
  const recordingProcessing =
    !row.local_audio_path && !knownRecording && ctx?.recordingPending?.status === 'waiting';
  const recordingNeverCame =
    !row.local_audio_path &&
    !knownRecording &&
    (ctx?.recordingPending?.status === 'gone' || ctx?.recordingPending?.status === 'gave-up');
  const canFetchAudio = !hasAudio && !row.local_audio_path && !!knownRecording && canEdit;
  // Text-only imports (Teams export, pasted transcript, …) with no known
  // recording anywhere: offer to upload the meeting's audio/video and run a
  // real AAI transcription. New row alongside, this import stays untouched.
  const canUploadRecording =
    canEdit &&
    row.source === 'imported' &&
    !isMeetPrimary &&
    !row.local_audio_path &&
    !knownRecording;

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

  const uploadAndRetranscribe = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('File is larger than the 4GB upload limit.');
      return;
    }
    if (
      !window.confirm(
        `Transcribe "${file.name}" with AssemblyAI (voice-level speakers + timings)? ` +
          'A new transcript is created alongside this one — this import stays untouched.'
      )
    ) {
      return;
    }
    setError(null);
    setUploadPct(0);

    // Raw-body XHR (not fetch): the file IS the body — the server streams it
    // to disk — and xhr.upload.onprogress gives real progress on multi-GB
    // sends. Same shape as the home-page uploader.
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ source_id: row.assemblyai_id });
    xhr.open('POST', `/api/transcripts?${qs}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        setUploadPct(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        const payload = JSON.parse(xhr.responseText || '{}') as {
          transcript?: { assemblyai_id?: string };
          error?: string;
        };
        if (xhr.status !== 201 || !payload.transcript?.assemblyai_id) {
          throw new Error(payload.error || `Upload failed (${xhr.status})`);
        }
        window.location.href = `/transcript/${payload.transcript.assemblyai_id}`;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
        setUploadPct(null);
      }
    };
    xhr.onerror = () => {
      setError('Upload failed — network error');
      setUploadPct(null);
    };
    xhr.send(file);
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
        <li className="flex items-start gap-2">
          <AudioLines
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${hasAudio ? 'text-status-ok' : 'text-muted-foreground'}`}
          />
          <span>
            {hasAudio && /\.(mp4|webm|mov|mkv|m4v)$/i.test(row.local_audio_path ?? '') ? (
              <>
                <span className="font-medium">Video recording stored</span>
                <span className="text-muted-foreground">
                  {' '}
                  — toggle video in the player; AI summaries can read the screen shares
                </span>
              </>
            ) : hasAudio ? (
              <>
                <span className="font-medium">Audio available</span>
                <span className="text-muted-foreground"> — playback &amp; voiceprints work</span>
              </>
            ) : knownRecording && videoFetching ? (
              <span className="text-muted-foreground">
                Fetching the video from {recordingHost} — playback and screen-reading unlock
                when it lands
              </span>
            ) : knownRecording ? (
              <span className="text-muted-foreground">
                No recording stored — the video is on {recordingHost}
              </span>
            ) : recordingProcessing ? (
              <span className="text-amber-600 dark:text-amber-500">
                <span className="font-medium">
                  Meet recorded this meeting — Google is still preparing the video.
                </span>{' '}
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  We check every minute and attach it automatically when it lands.
                </span>
              </span>
            ) : recordingNeverCame ? (
              <span className="text-muted-foreground">
                Meet recorded this meeting, but the video never appeared on Drive — it may
                not have been saved
              </span>
            ) : (
              <span className="text-muted-foreground">
                No audio — this import never had a recording
              </span>
            )}
          </span>
        </li>
      </ul>
      {pooledMicSuspected && (
        <p className="mt-2 rounded-md border border-amber-400/50 bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {joinedCount} people joined but Meet heard only {row.speaker_count} voice
          {(row.speaker_count ?? 0) > 1 ? 's' : ''} — several likely shared one room mic.
          &ldquo;Diarize with AssemblyAI&rdquo; separates them by voice
          {row.local_audio_path ? '.' : ' (fetch the video first).'}
        </p>
      )}
      {canUploadRecording && (
        <>
          <input
            ref={uploadInputRef}
            type="file"
            accept="audio/*,video/*,.mp4,.m4a,.mp3,.wav,.webm,.mkv,.mov"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) uploadAndRetranscribe(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
            disabled={uploadPct !== null}
            onClick={() => uploadInputRef.current?.click()}
            title="Upload the meeting's recording (audio or video) and transcribe it with AssemblyAI — voice-level speakers and real timings; a new transcript is created alongside this import"
          >
            {uploadPct !== null ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Upload className="h-4 w-4 text-primary" />
            )}
            {uploadPct === null
              ? 'Upload recording & re-transcribe'
              : uploadPct < 100
                ? `Uploading… ${uploadPct}%`
                : 'Submitting to AssemblyAI…'}
          </Button>
        </>
      )}
      {canFetchAudio && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 h-8 w-full justify-start gap-2 text-[13px]"
          disabled={videoFetching}
          onClick={onFetchVideo}
          title={`Download the video from ${recordingHost} to this server so playback works — no re-transcription, the transcript stays as-is`}
        >
          {videoFetching ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Video className="h-4 w-4 text-primary" />
          )}
          {videoFetching ? `Fetching from ${recordingHost}…` : 'Fetch video for playback'}
        </Button>
      )}
      {videoFetchError && <p className="mt-1.5 text-xs text-destructive">{videoFetchError}</p>}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
        Summaries and name guesses automatically use everything listed here.
      </p>
    </div>
  );
}

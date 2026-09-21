'use client';

import { useRef, useState } from 'react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { formatDuration, formatTime, type StoredTranscript, type TranscriptAccess } from '@/lib/format';
import { recordingFacts } from '@/lib/recording-facts';
import {
  ChevronDown,
  ChevronUp,
  FileAudio,
  FileText,
  Laptop,
  Loader2,
} from 'lucide-react';

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts / nginx.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

interface RecordingCardProps {
  row: StoredTranscript;
  access: TranscriptAccess;
  ownerEmail?: string | null;
  ownerName?: string | null;
  canEdit: boolean;
  /** Player-level truth: false once the <audio> element errored. */
  audioAvailable: boolean;
  /** Drive/Graph recording fetch state lives in the page — it auto-fetches
   * on load, and the report dialog needs to see the same in-flight state. */
  videoFetching: boolean;
  videoFetchError: string | null;
  onFetchVideo: () => void;
}

/**
 * "Recording" — the rail block that treats the recording as an object
 * (docs/transcript-page-redesign.md §3.6): one source sentence, one facts
 * line, the segments behind a disclosure, and a recovery line ONLY when
 * something is missing. Replaces the About card's SOURCE / AUDIO / VIDEO
 * rows; the model is the pure `recordingFacts()`.
 */
export function RecordingCard({
  row,
  access,
  ownerEmail,
  ownerName,
  canEdit,
  audioAvailable,
  videoFetching,
  videoFetchError,
  onFetchVideo,
}: RecordingCardProps) {
  const facts = recordingFacts({ ...row, access, owner_email: ownerEmail, owner_name: ownerName });
  const ctx = row.gmeet_context;
  const [segmentsOpen, setSegmentsOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // --- Where the bytes are (recovery states, as MeetingInfoCard had them) --
  const hasAudio =
    audioAvailable && !!(row.local_audio_path || row.audio_url || row.source === 'uploaded');
  const hasLocalVideo = facts.media === 'video' && !!row.local_audio_path;
  const recordingFileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  const teamsRecordingId = ctx?.provider === 'teams' ? ctx?.teams?.recordingId : undefined;
  /** A recording we know how to get: Drive file (Meet) or Graph id (Teams). */
  const knownRecording = recordingFileId ?? teamsRecordingId;
  const recordingHost = teamsRecordingId && !recordingFileId ? 'Microsoft 365' : 'Google Drive';
  const recordingProcessing =
    !row.local_audio_path && !knownRecording && ctx?.recordingPending?.status === 'waiting';
  const recordingNeverCame =
    !row.local_audio_path &&
    !knownRecording &&
    (ctx?.recordingPending?.status === 'gone' || ctx?.recordingPending?.status === 'gave-up');
  const canFetchRecording = canEdit && !row.local_audio_path && !!knownRecording;
  const canAddRecording =
    canEdit && !hasLocalVideo && !knownRecording && !recordingProcessing && row.status === 'completed';
  const partsFetching = (ctx?.videoParts ?? []).filter((p) => !p.filename).length;
  const partsGenerating =
    ctx?.recordingPending?.status === 'waiting'
      ? (ctx?.actuals?.recordings ?? []).filter((r) => !r.fileId).length
      : 0;

  // Same raw-body upload-and-redo flow as the home-page uploader: the file
  // IS the body, `?source_id=` makes the new row inherit this meeting's
  // title / language / date and speaker names as recognition hints.
  const uploadRecording = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('File is larger than the 4GB upload limit.');
      return;
    }
    if (
      !window.confirm(
        `Add "${file.name}" as this meeting's recording? ` +
          'It gets transcribed from scratch — a new transcript is created alongside this one, and this one stays untouched.'
      )
    ) {
      return;
    }
    setUploadError(null);
    setUploadPct(0);
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ source_id: row.assemblyai_id });
    xhr.open('POST', `/api/transcripts?${qs}`);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) setUploadPct(Math.round((e.loaded / e.total) * 100));
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
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
        setUploadPct(null);
      }
    };
    xhr.onerror = () => {
      setUploadError('Upload failed — network error');
      setUploadPct(null);
    };
    xhr.send(file);
  };

  const Glyph =
    facts.source === 'mac' ? (
      <Laptop className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : facts.source === 'meet' ? (
      <MeetLogo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    ) : facts.source === 'teams' ? (
      <TeamsLogo className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    ) : facts.source === 'file' ? (
      <FileAudio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    );

  return (
    <div className="rounded-lg border bg-card p-3" data-recording-card data-recording-source={facts.source}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Recording
      </div>

      <div className="mt-2 flex items-start gap-2 text-xs" title={facts.filename ?? undefined}>
        {Glyph}
        <span className="min-w-0">
          <span className="font-medium">{facts.lead}</span>
          {facts.tail && <span className="text-muted-foreground"> {facts.tail}</span>}
        </span>
      </div>
      {facts.facts.length > 0 && (
        <div className="ml-[22px] mt-0.5 text-[11px] tabular-nums text-muted-foreground" data-recording-facts>
          {facts.facts.join(' · ')}
        </div>
      )}
      {facts.heldVsAdded && (
        <div className="ml-[22px] mt-0.5 text-[11px] text-muted-foreground">{facts.heldVsAdded}</div>
      )}

      {facts.segmentCount > 1 && (
        <>
          <button
            type="button"
            onClick={() => setSegmentsOpen((v) => !v)}
            aria-expanded={segmentsOpen}
            className="ml-[22px] mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            Segments
            {segmentsOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {segmentsOpen && (
            <div className="ml-[22px] mt-1 rounded-md border bg-muted/30 px-2 py-1.5 text-[11px] leading-snug">
              {facts.segments.length > 0 && (
                <div className="space-y-0.5 tabular-nums">
                  {facts.segments.map((s) => (
                    <div key={s.index} className="grid grid-cols-[14px_44px_1fr] gap-1.5" title={s.filename ?? undefined}>
                      <span className="text-muted-foreground">{s.index}</span>
                      <span>{s.offsetSec != null ? formatTime(s.offsetSec * 1000) : '—'}</span>
                      <span className="min-w-0 break-words">
                        {s.durationSec != null ? formatDuration(s.durationSec) : ''}
                        {s.comment ? <span className="text-muted-foreground"> — {s.comment}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {facts.segmentsNote && (
                <p className={`text-muted-foreground ${facts.segments.length > 0 ? 'mt-1.5' : ''}`}>
                  {facts.segmentsNote}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Extra Meet videos (stop/restart recordings) */}
      {facts.extraVideos > 0 && (
        <p className="ml-[22px] mt-1.5 text-[11px] leading-snug text-muted-foreground">
          {facts.extraVideos + 1} videos — the recording was stopped and restarted, so Meet made
          separate files. Switch between them in the player.
          {partsFetching > 0 && (
            <span className="mt-0.5 block">
              <span className="inline-flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                {partsFetching} video{partsFetching > 1 ? 's' : ''} downloading from Drive…
              </span>
            </span>
          )}
        </p>
      )}
      {partsGenerating > 0 && (
        <p className="ml-[22px] mt-1.5 inline-flex items-start gap-1 text-[11px] leading-snug text-amber-600 dark:text-amber-500">
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          <span>
            {partsGenerating} more video{partsGenerating > 1 ? 's' : ''} — Google is still preparing the
            file; we check every minute and attach it automatically.
          </span>
        </p>
      )}

      {/* Recovery lines — only when something is missing. */}
      {!hasAudio && !recordingProcessing && !videoFetching && !knownRecording && facts.source !== 'text' && (
        <p className="mt-2 text-xs font-medium">No audio available</p>
      )}
      {videoFetching ? (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Downloading from {recordingHost}…
        </p>
      ) : !row.local_audio_path && knownRecording ? (
        <p className="mt-2 text-xs text-muted-foreground">
          On {recordingHost}, not saved here yet.
          {canFetchRecording && (
            <>
              {' '}
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={onFetchVideo}
                title={`Download the video from ${recordingHost} to this server so playback works — the transcript stays as-is`}
              >
                Fetch from {recordingHost}
              </button>
            </>
          )}
        </p>
      ) : recordingProcessing ? (
        <p className="mt-2 inline-flex items-start gap-1 text-xs text-amber-600 dark:text-amber-500">
          <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
          <span>
            The meeting was recorded — Google is still preparing the video. It is attached
            automatically when ready.
          </span>
        </p>
      ) : null}
      {recordingNeverCame && (
        <p className="mt-2 text-xs text-muted-foreground">
          The meeting was recorded, but the video never appeared on Google Drive — it may not have
          been saved.
        </p>
      )}
      {canAddRecording && facts.media !== 'video' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Got the recording?{' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline disabled:opacity-50"
            disabled={uploadPct !== null}
            onClick={() => uploadInputRef.current?.click()}
            title="Upload the meeting's video (or audio) — it gets transcribed and a new transcript is created alongside this one"
          >
            {uploadPct === null ? 'Add it here…' : uploadPct < 100 ? `Uploading… ${uploadPct}%` : 'Processing…'}
          </button>
        </p>
      )}
      {canAddRecording && (
        <input
          ref={uploadInputRef}
          type="file"
          accept="audio/*,video/*,.mp4,.m4a,.mp3,.wav,.webm,.mkv,.mov"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) uploadRecording(file);
          }}
        />
      )}
      {videoFetchError && <p className="mt-1.5 text-xs text-destructive">{videoFetchError}</p>}
      {uploadError && <p className="mt-1.5 text-xs text-destructive">{uploadError}</p>}
    </div>
  );
}

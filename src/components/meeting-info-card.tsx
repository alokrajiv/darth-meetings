'use client';

import { useRef, useState } from 'react';
import { format } from 'date-fns';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import {
  formatDuration,
  type SpeakerLabel,
  type StoredTranscript,
} from '@/lib/format';
import { CalendarCheck2, CalendarX2, Loader2, Upload } from 'lucide-react';

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts / nginx.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

const VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)$/i;
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|opus|flac|wma|amr)$/i;

interface MeetingInfoCardProps {
  row: StoredTranscript;
  /** Applied speaker names (customName per diarized speaker). */
  speakerLabels: SpeakerLabel[];
  canEdit: boolean;
  /** Player-level truth: false once the <audio> element errored. */
  audioAvailable: boolean;
  /** Drive/Graph recording fetch state lives in the page — it auto-fetches
   * on load, and the report dialog needs to see the same in-flight state. */
  videoFetching: boolean;
  videoFetchError: string | null;
  onFetchVideo: () => void;
  /** Opens the existing Link-calendar-event dialog. */
  onLinkEvent: () => void;
}

/** Comma list capped at `cap` visible names with a "+N more" expander. */
function NameList({ names, cap = 8 }: { names: string[]; cap?: number }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? names : names.slice(0, cap);
  const hidden = names.length - shown.length;
  return (
    <span>
      {shown.join(', ')}
      {hidden > 0 && (
        <>
          {' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => setExpanded(true)}
          >
            +{hidden} more
          </button>
        </>
      )}
      {expanded && names.length > cap && (
        <>
          {' '}
          <button
            type="button"
            className="font-medium text-muted-foreground hover:underline"
            onClick={() => setExpanded(false)}
          >
            show fewer
          </button>
        </>
      )}
    </span>
  );
}

const safeDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * "About this meeting" — the first card in the detail page's right rail,
 * written for READERS: when the meeting happened (and whether that comes
 * from a calendar invite), where the recording came from, whether audio and
 * video are actually available (with the recovery paths inline when they
 * are not), who was involved, and the language. Interactive transcript
 * internals (diarization sources, voiceprints, multi-video coverage) stay
 * in the Sources card below.
 */
export function MeetingInfoCard({
  row,
  speakerLabels,
  canEdit,
  audioAvailable,
  videoFetching,
  videoFetchError,
  onFetchVideo,
  onLinkEvent,
}: MeetingInfoCardProps) {
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const ctx = row.gmeet_context;

  // --- When ------------------------------------------------------------
  // recorded_at is the curated "when the meeting happened" (calendar event
  // or set by hand); created_at is merely when the row landed here.
  const heldFromMeeting = safeDate(row.recorded_at) ?? safeDate(ctx?.startTime);
  const held = heldFromMeeting ?? safeDate(row.created_at);
  const eventStart = safeDate(ctx?.startTime);
  const eventEnd = safeDate(ctx?.endTime);
  // Show the calendar event's time range only when it agrees with the
  // curated meeting date (recorded_at can be set by hand and win).
  const useEventRange =
    !!held &&
    !!eventStart &&
    !!eventEnd &&
    format(eventStart, 'yyyy-MM-dd') === format(eventEnd, 'yyyy-MM-dd') &&
    format(held, 'yyyy-MM-dd') === format(eventStart, 'yyyy-MM-dd');
  const whenLabel = held
    ? useEventRange
      ? `${format(eventStart!, 'EEE d MMM yyyy')}, ${format(eventStart!, 'h:mm')}–${format(eventEnd!, 'h:mm a')}`
      : format(held, 'EEE d MMM yyyy, h:mm a')
    : null;
  const durationLabel = row.duration != null ? formatDuration(row.duration) : null;

  // --- Calendar linkage -------------------------------------------------
  const fromCalendar = !!ctx?.eventId;
  const eventTitle = ctx?.eventTitle?.trim();
  const eventTitleDiffers =
    !!eventTitle && !!row.title && eventTitle.toLowerCase() !== row.title.trim().toLowerCase();

  // --- Provenance -------------------------------------------------------
  const isImported = row.source === 'imported';
  const isTeams = isImported && ctx?.provider === 'teams';
  const isMeet =
    isImported &&
    !isTeams &&
    (!!ctx || !!row.drive_file_id || row.assemblyai_id.startsWith('gmeet-'));
  const filename = row.original_filename;
  const hasLocalVideo = VIDEO_EXT.test(row.local_audio_path ?? '');
  const uploadedKind =
    hasLocalVideo || VIDEO_EXT.test(filename ?? '')
      ? 'video'
      : AUDIO_EXT.test(filename ?? '')
        ? 'audio'
        : 'recording';
  // "held 4 Aug, imported 11 Aug" — only when we know the meeting date
  // independently of created_at and it's a different day.
  const created = safeDate(row.created_at);
  const heldVsAdded =
    heldFromMeeting &&
    created &&
    format(heldFromMeeting, 'yyyy-MM-dd') !== format(created, 'yyyy-MM-dd')
      ? `held ${format(heldFromMeeting, heldFromMeeting.getFullYear() === created.getFullYear() ? 'd MMM' : 'd MMM yyyy')}, ${isImported ? 'imported' : 'uploaded'} ${format(created, 'd MMM')}`
      : null;

  // --- Media availability ----------------------------------------------
  const hasAudio =
    audioAvailable && !!(row.local_audio_path || row.audio_url || row.source === 'uploaded');
  const recordingFileId = ctx?.videoFileId ?? ctx?.actuals?.recordings?.[0]?.fileId;
  const teamsRecordingId = ctx?.provider === 'teams' ? ctx?.teams?.recordingId : undefined;
  /** A recording we know how to get: Drive file (Meet) or Graph id (Teams). */
  const knownRecording = recordingFileId ?? teamsRecordingId;
  const recordingHost = teamsRecordingId && !recordingFileId ? 'Microsoft 365' : 'Google Drive';
  // Meet recorded the meeting but Google hadn't finished the file at import
  // time — the server re-checks every minute and attaches it automatically.
  const recordingProcessing =
    !row.local_audio_path && !knownRecording && ctx?.recordingPending?.status === 'waiting';
  const recordingNeverCame =
    !row.local_audio_path &&
    !knownRecording &&
    (ctx?.recordingPending?.status === 'gone' || ctx?.recordingPending?.status === 'gave-up');
  const canFetchRecording = canEdit && !row.local_audio_path && !!knownRecording;
  // No video anywhere and nothing on the way: let the reader add the
  // recording themselves if they get hold of it (new transcript alongside —
  // this one stays untouched).
  const canAddRecording =
    canEdit &&
    !hasLocalVideo &&
    !knownRecording &&
    !recordingProcessing &&
    row.status === 'completed';
  const videoCount =
    (row.local_audio_path || knownRecording ? 1 : 0) + (ctx?.videoParts?.length ?? 0);

  // --- People -----------------------------------------------------------
  const inviteeNames: string[] = [];
  const seenInvitees = new Set<string>();
  for (const a of ctx?.attendees ?? []) {
    const key = (a.email || a.name || '').toLowerCase();
    if (!key || seenInvitees.has(key)) continue;
    seenInvitees.add(key);
    inviteeNames.push(a.name?.trim() || a.email);
  }
  const speakerNames: string[] = [];
  const seenSpeakers = new Set<string>();
  for (const l of speakerLabels) {
    const name = l.customName.trim();
    const key = name.toLowerCase();
    if (!name || seenSpeakers.has(key)) continue;
    seenSpeakers.add(key);
    speakerNames.push(name);
  }
  const speakerCount = row.speaker_count ?? (speakerNames.length || null);

  // --- Language ---------------------------------------------------------
  let language: string | null = null;
  if (row.language_code) {
    try {
      language =
        new Intl.DisplayNames(['en'], { type: 'language' }).of(
          row.language_code.replace(/_/g, '-')
        ) ?? row.language_code;
    } catch {
      language = row.language_code;
    }
  }

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

  const label = (text: string) => (
    <span className="pt-px text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {text}
    </span>
  );

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        About this meeting
      </div>
      <div className="mt-2 grid grid-cols-[64px_1fr] gap-x-2 gap-y-2 text-xs">
        {/* When */}
        {whenLabel && (
          <>
            {label('When')}
            <span>
              <span className="font-medium">{whenLabel}</span>
              {durationLabel && (
                <span className="text-muted-foreground"> · {durationLabel}</span>
              )}
            </span>
          </>
        )}

        {/* Calendar linkage */}
        {label('Calendar')}
        {fromCalendar ? (
          <span>
            <span className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              <CalendarCheck2 className="h-3 w-3" />
              From calendar invite
            </span>
            {eventTitleDiffers && (
              <span className="mt-0.5 block text-muted-foreground">
                Invite title: &ldquo;{eventTitle}&rdquo;
              </span>
            )}
          </span>
        ) : (
          <span className="text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <CalendarX2 className="h-3 w-3" />
              Not linked to a calendar event
            </span>
            {canEdit && (
              <>
                {' '}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={onLinkEvent}
                  title="Attach the calendar invite this meeting came from — fills the date, title, and attendees"
                >
                  Link…
                </button>
              </>
            )}
          </span>
        )}

        {/* Provenance */}
        {label('Source')}
        <span>
          <span className="inline-flex items-center gap-1.5 font-medium">
            {isTeams ? (
              <>
                <TeamsLogo className="h-3.5 w-3.5 shrink-0" />
                Imported from Microsoft Teams
              </>
            ) : isMeet ? (
              <>
                <MeetLogo className="h-3.5 w-3.5 shrink-0" />
                Imported from Google Meet
              </>
            ) : isImported ? (
              <>
                <Upload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                Imported transcript
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                Uploaded {uploadedKind}
              </>
            )}
          </span>
          {!isImported && filename && (
            <span className="block break-all text-muted-foreground">({filename})</span>
          )}
          {heldVsAdded && (
            <span className="block text-muted-foreground">{heldVsAdded}</span>
          )}
        </span>

        {/* Media availability — always both lines, so "no video" is said
            out loud instead of being inferred from silence. */}
        {label('Audio')}
        {hasAudio ? (
          <span>Available</span>
        ) : recordingProcessing || videoFetching || knownRecording ? (
          <span className="text-muted-foreground">Arrives with the video (see below)</span>
        ) : (
          <span className="font-medium">No audio available</span>
        )}

        {label('Video')}
        <span>
          {hasLocalVideo ? (
            <span>
              Available — use the player&apos;s video toggle
              {videoCount > 1 && (
                <span className="text-muted-foreground"> ({videoCount} videos)</span>
              )}
            </span>
          ) : videoFetching ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Downloading from {recordingHost}…
            </span>
          ) : knownRecording ? (
            <span className="text-muted-foreground">
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
            </span>
          ) : recordingProcessing ? (
            <span className="inline-flex items-start gap-1 text-amber-600 dark:text-amber-500">
              <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />
              <span>
                The meeting was recorded — Google is still preparing the video. It is
                attached automatically when ready.
              </span>
            </span>
          ) : (
            <span>
              <span className="font-medium">No video available</span>
              {recordingNeverCame && (
                <span className="block text-muted-foreground">
                  The meeting was recorded, but the video never appeared on Google Drive —
                  it may not have been saved.
                </span>
              )}
              {canAddRecording && (
                <span className="block text-muted-foreground">
                  Got the recording?{' '}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline disabled:opacity-50"
                    disabled={uploadPct !== null}
                    onClick={() => uploadInputRef.current?.click()}
                    title="Upload the meeting's video (or audio) — it gets transcribed and a new transcript is created alongside this one"
                  >
                    {uploadPct === null
                      ? 'Add it here…'
                      : uploadPct < 100
                        ? `Uploading… ${uploadPct}%`
                        : 'Processing…'}
                  </button>
                </span>
              )}
            </span>
          )}
        </span>

        {/* People */}
        {inviteeNames.length > 0 && (
          <>
            {label('Invited')}
            <span className="text-muted-foreground">
              {inviteeNames.length} {inviteeNames.length === 1 ? 'person' : 'people'} on the
              invite — <NameList names={inviteeNames} />
            </span>
          </>
        )}
        {(speakerCount != null || speakerNames.length > 0) && (
          <>
            {label('Speakers')}
            <span className="text-muted-foreground">
              {speakerCount != null &&
                `${speakerCount} ${speakerCount === 1 ? 'voice' : 'voices'} heard`}
              {speakerNames.length > 0 && (
                <>
                  {speakerCount != null && ' — '}
                  <NameList names={speakerNames} />
                </>
              )}
            </span>
          </>
        )}

        {/* Language */}
        {language && (
          <>
            {label('Language')}
            <span className="text-muted-foreground">{language}</span>
          </>
        )}
      </div>

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

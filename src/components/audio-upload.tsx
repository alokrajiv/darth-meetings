'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Upload,
  FileAudio,
  X,
  CheckCircle,
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
  Film,
  FileText,
} from 'lucide-react';
import {
  getGoogleAccessToken,
  connectGoogle,
  GoogleNotConnectedError,
} from '@/lib/google-token';
import type { StoredTranscript } from '@/lib/format';

/** DOM id of the hidden file input — lets the page header's "Upload media"
 * button trigger the picker without threading refs across components. */
export const AUDIO_UPLOAD_INPUT_ID = 'audio-upload-file-input';

interface AudioUploadProps {
  onTranscriptCreated?: () => void;
}

const LANGUAGE_OPTIONS = [
  { code: '', label: 'Auto Detect' },
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
];

interface UploadStatus {
  file: File;
  status: 'uploading' | 'transcribing' | 'completed' | 'error';
  progress: number;
  transcriptId?: string;
  error?: string;
}

/** What the stepper attaches to the upload when the user links a calendar
 * event — mirrors the Meet-import event payload so gmeet_context comes out
 * identical downstream (people context, speaker-ID hints, dedupe). */
interface LinkedEvent {
  id: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  meetingCode?: string;
  recurringEventId?: string;
  iCalUID?: string;
  organizerEmail?: string;
  attendees: Array<{ email: string; name?: string; responseStatus?: string }>;
}

interface CalendarEventLite {
  id: string;
  summary?: string;
  recurringEventId?: string;
  iCalUID?: string;
  organizer?: { email?: string };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  conferenceData?: { conferenceId?: string };
}

type ReportPref = 'summary' | 'detailed-video' | 'detailed-text' | 'later';
type DialogStep = 'files' | 'link' | 'process';

const POLL_INTERVAL_MS = 3000;

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts.
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

const VIDEO_FILE_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;

function localDateOf(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDateOf(d);
}

function fmtEventTime(e: CalendarEventLite): string {
  const iso = e.start?.dateTime;
  if (!iso) return 'all day';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AudioUpload({ onTranscriptCreated }: AudioUploadProps) {
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- stepper state ---
  const [step, setStep] = useState<DialogStep>('files');
  /** null = unknown (not probed yet); false = Google not connected. */
  const [googleOk, setGoogleOk] = useState<boolean | null>(null);
  const [linkDate, setLinkDate] = useState<string>(localDateOf(new Date()));
  const [dayEvents, setDayEvents] = useState<CalendarEventLite[]>([]);
  const [eventsBusy, setEventsBusy] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [reportPref, setReportPref] = useState<ReportPref>('summary');

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const updateUpload = (file: File, patch: Partial<UploadStatus>) => {
    setUploads((prev) =>
      prev.map((u) => (u.file === file ? { ...u, ...patch } : u))
    );
  };

  const pollUntilDone = async (file: File, transcriptId: string) => {
    // Poll /api/transcripts/:id until status is final. The server refreshes
    // against AssemblyAI on each GET.
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(`/api/transcripts/${transcriptId}`);
      if (!res.ok) {
        throw new Error(`Status check failed: ${res.status}`);
      }
      const { transcript } = (await res.json()) as { transcript: StoredTranscript };

      let progress = 50;
      switch (transcript.status) {
        case 'queued':
          progress = 60;
          break;
        case 'processing':
          progress = 80;
          break;
        case 'completed':
          progress = 100;
          break;
        case 'error':
          progress = 0;
          break;
      }
      updateUpload(file, { progress });

      if (transcript.status === 'completed') {
        updateUpload(file, { status: 'completed', progress: 100 });
        onTranscriptCreated?.();
        return;
      }
      if (transcript.status === 'error') {
        updateUpload(file, { status: 'error', error: 'Transcription failed' });
        return;
      }
    }
  };

  // Raw-body upload via XHR: the file IS the request body (the server
  // streams it to disk — no multipart, no server-side buffering), and
  // xhr.upload.onprogress gives real progress, which matters when a
  // multi-GB file takes minutes to send. Linked-event context and the
  // report preference ride along as a header + query param.
  const uploadFile = (
    file: File,
    languageCode: string,
    linked: LinkedEvent | null,
    pref: ReportPref
  ): Promise<StoredTranscript> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams();
      if (languageCode) params.set('language_code', languageCode);
      if (pref !== 'summary') params.set('report_pref', pref);
      const qs = params.size > 0 ? `?${params}` : '';
      xhr.open('POST', `/api/transcripts${qs}`);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      if (linked) {
        xhr.setRequestHeader('x-linked-event', encodeURIComponent(JSON.stringify(linked)));
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          // Upload owns the 0–50% band; transcription polling owns the rest.
          updateUpload(file, { progress: Math.round((e.loaded / e.total) * 50) });
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(
              (JSON.parse(xhr.responseText) as { transcript: StoredTranscript })
                .transcript
            );
          } catch {
            reject(new Error('Upload failed: invalid server response'));
          }
        } else {
          let detail: string = xhr.responseText || String(xhr.status);
          try {
            detail = (JSON.parse(xhr.responseText) as { error?: string }).error ?? detail;
          } catch {
            // keep raw text
          }
          reject(new Error(`Upload failed: ${detail}`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(file);
    });

  const submitForTranscription = async (
    file: File,
    languageCode: string,
    linked: LinkedEvent | null,
    pref: ReportPref
  ) => {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is ${formatFileSize(file.size)} — the upload limit is ${formatFileSize(MAX_FILE_BYTES)}`
      );
    }

    updateUpload(file, { status: 'uploading', progress: 0 });

    const transcript = await uploadFile(file, languageCode, linked, pref);

    updateUpload(file, {
      status: 'transcribing',
      progress: 50,
      transcriptId: transcript.assemblyai_id,
    });
    // Surface to the parent right away so the newly queued row shows up in
    // the list, even before it finishes transcribing.
    onTranscriptCreated?.();

    await pollUntilDone(file, transcript.assemblyai_id);
  };

  const startUpload = useCallback(
    async (
      files: File[],
      languageCode: string,
      linked: LinkedEvent | null,
      pref: ReportPref
    ) => {
      for (const file of files) {
        const uploadStatus: UploadStatus = {
          file,
          status: 'uploading',
          progress: 0,
        };
        setUploads((prev) => [...prev, uploadStatus]);

        try {
          await submitForTranscription(file, languageCode, linked, pref);
        } catch (error) {
          updateUpload(file, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Upload failed',
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handleFilesSelected = useCallback((files: FileList) => {
    const list = Array.from(files);
    setPendingFiles(list);
    setSelectedLanguage('');
    setStep('files');
    setSelectedEventId(null);
    setEventsError(null);
    setDayEvents([]);
    setReportPref('summary');
    // Meetings are usually uploaded soon after they happened — the file's
    // own timestamp is a better first guess for the calendar day than today.
    const stamp = list[0]?.lastModified;
    setLinkDate(localDateOf(stamp ? new Date(stamp) : new Date()));
    setIsDialogOpen(true);
  }, []);

  /** Load the day's calendar events for the link step (silent server-minted
   * token — same as the Meet import dialog). */
  const loadDayEvents = useCallback(async (forDate: string) => {
    setEventsBusy(true);
    setEventsError(null);
    try {
      const token = await getGoogleAccessToken();
      setGoogleOk(true);
      const params = new URLSearchParams({
        timeMin: new Date(`${forDate}T00:00:00`).toISOString(),
        timeMax: new Date(`${forDate}T23:59:59.999`).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        fields:
          'items(id,summary,recurringEventId,iCalUID,organizer(email),start,end,attendees(email,displayName,responseStatus),conferenceData(conferenceId))',
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
      const data = (await res.json()) as { items?: CalendarEventLite[] };
      setDayEvents((data.items ?? []).filter((e) => e.start?.dateTime));
    } catch (err) {
      if (err instanceof GoogleNotConnectedError) {
        setGoogleOk(false);
      } else {
        setEventsError(err instanceof Error ? err.message : 'Failed to load calendar');
      }
    } finally {
      setEventsBusy(false);
    }
  }, []);

  const changeLinkDate = (next: string) => {
    setLinkDate(next);
    setSelectedEventId(null);
    void loadDayEvents(next);
  };

  const goToLinkStep = () => {
    setStep('link');
    void loadDayEvents(linkDate);
  };

  const buildLinkedEvent = (): LinkedEvent | null => {
    if (!selectedEventId) return null;
    const e = dayEvents.find((ev) => ev.id === selectedEventId);
    if (!e) return null;
    return {
      id: e.id,
      title: e.summary,
      startTime: e.start?.dateTime,
      endTime: e.end?.dateTime,
      meetingCode: e.conferenceData?.conferenceId,
      recurringEventId: e.recurringEventId,
      iCalUID: e.iCalUID,
      organizerEmail: e.organizer?.email,
      attendees: (e.attendees ?? [])
        .filter((a) => a.email)
        .slice(0, 100)
        .map((a) => ({
          email: a.email!,
          name: a.displayName,
          responseStatus: a.responseStatus,
        })),
    };
  };

  const handleConfirmUpload = () => {
    setIsDialogOpen(false);
    startUpload(pendingFiles, selectedLanguage, buildLinkedEvent(), reportPref);
    setPendingFiles([]);
  };

  const handleCancelUpload = () => {
    setIsDialogOpen(false);
    setPendingFiles([]);
    setSelectedLanguage('');
  };

  // Page-wide drag & drop: the visible dropzone strip is gone (it cost a
  // full row of chrome) — instead, dragging files anywhere over the window
  // raises a fixed overlay, and dropping anywhere uploads. Depth counter
  // because dragenter/dragleave fire for every child element crossed.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setIsDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setIsDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleFilesSelected(e.dataTransfer.files);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFilesSelected]);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(e.target.files);
      }
      e.target.value = '';
    },
    [handleFilesSelected]
  );

  const removeUpload = (file: File) => {
    setUploads((prev) => prev.filter((u) => u.file !== file));
  };

  const getStatusIcon = (status: UploadStatus['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-status-ok" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      default:
        return <FileAudio className="h-4 w-4 text-primary" />;
    }
  };

  const getStatusText = (upload: UploadStatus) => {
    switch (upload.status) {
      case 'uploading':
        return 'Uploading...';
      case 'transcribing':
        return 'Transcribing...';
      case 'completed':
        return 'Completed';
      case 'error':
        return upload.error || 'Error';
      default:
        return 'Processing...';
    }
  };

  // Linking one calendar event to a batch makes no sense — the link step
  // only shows for single-file uploads (the overwhelmingly common case).
  const canLink = pendingFiles.length === 1;
  const hasVideoFile = pendingFiles.some(
    (f) => f.type.startsWith('video/') || VIDEO_FILE_RE.test(f.name)
  );
  const selectedEvent = selectedEventId
    ? dayEvents.find((e) => e.id === selectedEventId)
    : undefined;

  const reportOptions: Array<{
    value: ReportPref;
    icon: React.ReactNode;
    label: string;
    detail: string;
    hidden?: boolean;
  }> = [
    {
      value: 'summary',
      icon: <Sparkles className="h-4 w-4 text-primary" />,
      label: 'Quick summary',
      detail: 'Fast and clean — the default tier.',
    },
    {
      value: 'detailed-video',
      icon: <Film className="h-4 w-4 text-primary" />,
      label: 'Detailed report — with video frames',
      detail:
        'Wiki-style deep dive: Claude reads the screen shares and embeds screenshots and citations. Slower.',
      hidden: !hasVideoFile,
    },
    {
      value: 'detailed-text',
      icon: <FileText className="h-4 w-4 text-primary" />,
      label: 'Detailed report — text only',
      detail: 'Same deep dive without reading the video. Cheaper.',
    },
    {
      value: 'later',
      icon: <CalendarDays className="h-4 w-4 text-muted-foreground" />,
      label: 'Decide later',
      detail: 'Nothing generates until you pick on the meeting page.',
    },
  ];

  return (
    <>
      <div className={uploads.length > 0 ? 'mb-3 space-y-3' : ''}>
        <input
          id={AUDIO_UPLOAD_INPUT_ID}
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
        {isDragging && (
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary bg-card px-10 py-8 text-center shadow-lg">
              <Upload className="mx-auto h-6 w-6 text-primary" />
              <p className="mt-3 text-sm font-medium">Drop audio or video to upload</p>
              <p className="mt-1 text-xs text-muted-foreground">
                up to 4 GB · mp3 · m4a · mp4 · wav
              </p>
            </div>
          </div>
        )}

        {uploads.length > 0 && (
          <div className="space-y-2">
            {uploads.map((upload, index) => (
              <div
                key={`${upload.file.name}-${index}`}
                className="rounded-md border bg-card px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {getStatusIcon(upload.status)}
                    <span className="truncate text-sm font-medium">{upload.file.name}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatFileSize(upload.file.size)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{getStatusText(upload)}</span>
                    {(upload.status === 'completed' || upload.status === 'error') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => removeUpload(upload.file)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
                {(upload.status === 'uploading' || upload.status === 'transcribing') && (
                  <Progress value={upload.progress} className="mt-2 h-1" />
                )}
                {upload.status === 'error' && upload.error && (
                  <p className="mt-1 text-xs text-destructive">{upload.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {step === 'files' && 'Upload media'}
              {step === 'link' && 'Link to a calendar meeting?'}
              {step === 'process' && 'How should it be processed?'}
            </DialogTitle>
          </DialogHeader>

          {/* min-w-0 on every step wrapper: DialogContent is a grid, and
              without it a long filename sizes the item to min-content and
              paints outside the card. */}
          {step === 'files' && (
            <div className="min-w-0 space-y-4 py-2">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} selected:
                </p>
                <ul className="text-sm space-y-1">
                  {pendingFiles.map((file, i) => (
                    <li key={i} className="flex min-w-0 items-center gap-2">
                      <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate">{file.name}</span>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {formatFileSize(file.size)}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <Label htmlFor="language-select">Language</Label>
                <select
                  id="language-select"
                  value={selectedLanguage}
                  onChange={(e) => setSelectedLanguage(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {LANGUAGE_OPTIONS.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Select the primary language spoken in the recording, or use Auto Detect.
                </p>
              </div>
            </div>
          )}

          {step === 'link' && (
            <div className="min-w-0 space-y-3 py-2">
              <p className="text-xs text-muted-foreground">
                Linking pulls in the meeting&apos;s title, time and invitees — speaker
                name-guessing and the summary get real context, and colleagues browsing
                the archive see it as the meeting it was.
              </p>
              {googleOk === false ? (
                <div className="space-y-2.5 rounded-md border bg-muted/40 p-3">
                  <p className="text-xs text-muted-foreground">
                    Google isn&apos;t connected yet, so there&apos;s no calendar to pick
                    from. Connect it once and every future upload (and Meet import) can
                    link straight to its meeting.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => connectGoogle('/')}
                  >
                    <CalendarDays className="h-4 w-4" />
                    Connect Google Calendar
                  </Button>
                  <p className="text-[11px] text-muted-foreground">
                    Connecting leaves this page — you&apos;ll need to re-select the file
                    afterwards. Or skip for now and link the calendar event later from the
                    meeting page.
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changeLinkDate(shiftDate(linkDate, -1))}
                      disabled={eventsBusy}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Input
                      type="date"
                      value={linkDate}
                      onChange={(e) => e.target.value && changeLinkDate(e.target.value)}
                      className="w-36"
                      disabled={eventsBusy}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changeLinkDate(shiftDate(linkDate, 1))}
                      disabled={eventsBusy}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    {eventsBusy && (
                      <Loader2 className="ml-1 h-4 w-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className="max-h-[38vh] overflow-y-auto rounded-md border">
                    <label className="flex cursor-pointer items-center gap-2.5 border-b p-2.5 text-sm hover:bg-muted/50">
                      <input
                        type="radio"
                        name="upload-link-event"
                        checked={selectedEventId === null}
                        onChange={() => setSelectedEventId(null)}
                      />
                      <span className="text-muted-foreground">
                        Not from a calendar meeting
                      </span>
                    </label>
                    {dayEvents.length === 0 && !eventsBusy ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        No timed events on this day.
                      </p>
                    ) : (
                      dayEvents.map((e) => (
                        <label
                          key={e.id}
                          className="flex cursor-pointer items-center gap-2.5 border-b p-2.5 text-sm last:border-b-0 hover:bg-muted/50"
                        >
                          <input
                            type="radio"
                            name="upload-link-event"
                            checked={selectedEventId === e.id}
                            onChange={() => setSelectedEventId(e.id)}
                          />
                          <span className="w-14 shrink-0 text-xs text-muted-foreground">
                            {fmtEventTime(e)}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {e.summary ?? '(no title)'}
                          </span>
                          {(e.attendees?.length ?? 0) > 0 && (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {e.attendees!.length} invitee
                              {e.attendees!.length === 1 ? '' : 's'}
                            </span>
                          )}
                        </label>
                      ))
                    )}
                  </div>
                  {eventsError && (
                    <p className="text-xs text-destructive flex items-center gap-1">
                      <AlertCircle className="h-4 w-4" />
                      {eventsError}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {step === 'process' && (
            <div className="min-w-0 space-y-3 py-2">
              {selectedEvent && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <CalendarDays className="mr-1.5 inline h-3.5 w-3.5" />
                  Linked to <span className="font-medium">{selectedEvent.summary}</span>
                  {' · '}
                  {fmtEventTime(selectedEvent)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                First the AI guesses who&apos;s speaking (voiceprints + context), you
                confirm the names, and only then does this run — so it&apos;s written
                with real names from the start.
              </p>
              <div className="space-y-1.5">
                {reportOptions
                  .filter((o) => !o.hidden)
                  .map((o) => (
                    <label
                      key={o.value}
                      className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[:checked]:border-primary"
                    >
                      <input
                        type="radio"
                        name="upload-report-pref"
                        className="mt-0.5"
                        checked={reportPref === o.value}
                        onChange={() => setReportPref(o.value)}
                      />
                      <span className="text-sm">
                        <span className="flex items-center gap-2 font-medium">
                          {o.icon}
                          {o.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {o.detail}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={handleCancelUpload}>
              Cancel
            </Button>
            {step === 'files' && (
              <Button
                onClick={() => {
                  if (canLink) goToLinkStep();
                  else setStep('process');
                }}
                disabled={pendingFiles.length === 0}
              >
                Next
              </Button>
            )}
            {step === 'link' && (
              <>
                <Button variant="ghost" onClick={() => setStep('files')}>
                  Back
                </Button>
                <Button onClick={() => setStep('process')}>
                  {selectedEventId ? 'Next' : 'Skip'}
                </Button>
              </>
            )}
            {step === 'process' && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => (canLink && googleOk !== false ? setStep('link') : setStep('files'))}
                >
                  Back
                </Button>
                <Button onClick={handleConfirmUpload}>Start Transcription</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

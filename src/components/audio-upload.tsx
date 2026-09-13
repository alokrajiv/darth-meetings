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
  hasValidGoogleToken,
  connectGoogle,
  GoogleNotConnectedError,
} from '@/lib/google-token';
import type { StoredTranscript } from '@/lib/format';
import { uploadFileChunked } from '@/lib/chunked-upload';
import { OFFLINE_TITLE, useOfflineGate } from '@/lib/offline/offline-context';
import { isNetworkFailure } from '@/lib/offline/offline-fetch';

/** DOM id of the hidden file input (kept for tests/debug hooks). */
export const AUDIO_UPLOAD_INPUT_ID = 'audio-upload-file-input';

/** Entry point for the header's "Upload media" button and the calendar rows'
 * "Upload…" actions. Opens the dialog at the 'pick' step (drop zone + paste
 * lane) — a not-connected user hits the Google gate first, since connecting
 * navigates away and would discard anything picked beforehand. */
export const AUDIO_UPLOAD_OPEN_EVENT = 'mw-upload-media-open';

/** Optional pre-link: the calendar layers' "Upload…" action passes the event
 * it was clicked on — the 'pick' step shows it as a banner and the link step
 * lands pre-selected on that meeting. */
export interface MediaUploadPrefill {
  /** Local YYYY-MM-DD of the event. */
  date: string;
  eventId: string;
}

export function requestMediaUpload(prefill?: MediaUploadPrefill): void {
  window.dispatchEvent(
    new CustomEvent(AUDIO_UPLOAD_OPEN_EVENT, { detail: prefill ?? null })
  );
}

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
  /** Transient sub-status under the progress bar ("Resuming from 42%",
   * "Retrying chunk 12…"). */
  note?: string | null;
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
type DialogStep = 'connect' | 'pick' | 'files' | 'link' | 'process';

const POLL_INTERVAL_MS = 3000;

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts.
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

const VIDEO_FILE_RE = /\.(mp4|webm|mov|mkv|m4v)$/i;

/** Text documents that must NEVER be streamed to AssemblyAI as audio (the
 * sibl_minutes.rtf incident: 8KB of meeting minutes died minutes later as an
 * opaque transcoding error). These divert to the import-text lane, which
 * extracts text server-side and parses/normalizes it into a transcript. */
const TEXT_TRANSCRIPT_FILE_RE =
  /\.(txt|md|markdown|rtf|vtt|srt|docx|doc|pdf|json|csv|tsv|html|htm|log)$/i;
const TEXT_TRANSCRIPT_MIMES = new Set([
  'application/rtf',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const isTextTranscriptFile = (f: File) =>
  TEXT_TRANSCRIPT_FILE_RE.test(f.name) ||
  f.type.startsWith('text/') ||
  TEXT_TRANSCRIPT_MIMES.has(f.type);

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

function fmtEventDay(e: CalendarEventLite): string {
  const iso = e.start?.dateTime;
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export function AudioUpload({ onTranscriptCreated }: AudioUploadProps) {
  // Offline mode / network down: nothing here can reach the server. Every
  // network-backed control stays visible but disabled; a dropped or picked
  // file shows a short "Not available offline" notice instead of opening the
  // stepper. The ref feeds the window-level drop listeners.
  const { blocked } = useOfflineGate();
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const [offlineNotice, setOfflineNotice] = useState(false);
  const offlineNoticeTimer = useRef<number | null>(null);
  const flashOfflineNotice = useCallback(() => {
    setOfflineNotice(true);
    if (offlineNoticeTimer.current !== null) window.clearTimeout(offlineNoticeTimer.current);
    offlineNoticeTimer.current = window.setTimeout(() => {
      offlineNoticeTimer.current = null;
      setOfflineNotice(false);
    }, 2500);
  }, []);
  useEffect(
    () => () => {
      if (offlineNoticeTimer.current !== null) window.clearTimeout(offlineNoticeTimer.current);
    },
    []
  );
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  // Multi-file batches: stitch into ONE meeting (ordered concat + per-file
  // comments, one transcript) vs. N independent transcripts.
  const [stitchMode, setStitchMode] = useState(false);
  const [partComments, setPartComments] = useState<string[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Event to pre-link (calendar-row "Upload…" entry). Plain state, captured
   * when the dialog opens — the old ref-across-the-native-chooser approach
   * arrived null at handleFilesSelected, so the pre-link never applied. */
  const [prefill, setPrefill] = useState<MediaUploadPrefill | null>(null);

  // --- paste-a-transcript state (the 'pick' step's second lane) ---
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteResult, setPasteResult] = useState<{
    queued: boolean;
    id: string | null;
  } | null>(null);

  // --- text-file import state (the 'pick' step's third lane: a dropped
  // .rtf/.docx/.txt/… stages here instead of streaming to AAI as audio) ---
  const [textFiles, setTextFiles] = useState<File[]>([]);
  const [textBusy, setTextBusy] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  /** Names of text files dropped alongside media — listed on the files step
   * so a mixed drop doesn't silently swallow the documents. */
  const [skippedTextNames, setSkippedTextNames] = useState<string[]>([]);

  // --- stepper state ---
  const [step, setStep] = useState<DialogStep>('pick');
  /** null = unknown (not probed yet); false = Google not connected. */
  const [googleOk, setGoogleOk] = useState<boolean | null>(null);
  /** User clicked through the connect gate this session — don't nag again. */
  const [connectSkipped, setConnectSkipped] = useState(false);

  // Probe Google once on mount — drives the connect gate at flow start.
  // hasValidGoogleToken() answers instantly off the warm cache (the landing
  // page pre-warms it); otherwise it's one silent round-trip. Non-connect
  // errors (network blips) leave googleOk null, which never blocks.
  useEffect(() => {
    if (hasValidGoogleToken()) {
      setGoogleOk(true);
      return;
    }
    getGoogleAccessToken()
      .then(() => setGoogleOk(true))
      .catch((err) => {
        if (err instanceof GoogleNotConnectedError) setGoogleOk(false);
      });
  }, []);
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

  // Chunked, parallel, resumable upload (src/lib/chunked-upload.ts): the
  // file goes up as 4–8MB chunks, 4 in flight, each retried until the
  // server verifies it; a re-dropped file resumes from the chunks already
  // on the server. Linked-event context and the report preference ride in
  // the session-open call.
  const uploadFile = (
    file: File,
    languageCode: string,
    linked: LinkedEvent | null,
    pref: ReportPref,
    /** Multi-file single-meeting group: this file is part `index` of `total`.
     * Progress reports against `progressFile`'s entry in the group's shared
     * 0–50% band (`base` + `span`). */
    multi?: {
      group: string;
      index: number;
      total: number;
      comment?: string;
      progressFile: File;
      base: number;
      span: number;
    }
  ): Promise<StoredTranscript> => {
    const target = multi?.progressFile ?? file;
    const label = multi ? `${file.name}: ` : '';
    return uploadFileChunked(
      file,
      {
        languageCode: languageCode || undefined,
        linkedEvent: linked,
        reportPref: pref !== 'summary' ? pref : null,
        multi: multi
          ? { group: multi.group, index: multi.index, total: multi.total, comment: multi.comment }
          : null,
      },
      {
        onProgress: (loaded, total) => {
          // Upload owns the 0–50% band; transcription polling owns the rest.
          const frac = total > 0 ? loaded / total : 0;
          updateUpload(target, {
            progress: multi ? Math.round(multi.base + frac * multi.span) : Math.round(frac * 50),
          });
        },
        onResumed: (bytes, total) => {
          updateUpload(target, {
            note: `${label}Resuming — ${Math.round((bytes / total) * 100)}% was already on the server`,
          });
          setTimeout(() => updateUpload(target, { note: null }), 6000);
        },
        onNote: (note) => updateUpload(target, { note: note ? `${label}${note}` : null }),
      }
    );
  };

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

  /** Stitch path: N ordered files → one meeting. One progress entry (keyed on
   * the first file); files upload sequentially into the server-side group;
   * the last response is the real ingested row, then normal polling. */
  const submitStitchGroup = async (
    files: File[],
    comments: string[],
    languageCode: string,
    linked: LinkedEvent | null,
    pref: ReportPref
  ) => {
    const progressFile = files[0]!;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(
          `${file.name} is ${formatFileSize(file.size)} — the upload limit is ${formatFileSize(MAX_FILE_BYTES)}`
        );
      }
    }
    updateUpload(progressFile, { status: 'uploading', progress: 0 });
    const group = crypto.randomUUID();
    const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
    let doneBytes = 0;
    let last: StoredTranscript | null = null;
    for (const [i, file] of files.entries()) {
      last = await uploadFile(file, languageCode, i === 0 ? linked : null, i === 0 ? pref : 'summary', {
        group,
        index: i + 1,
        total: files.length,
        comment: comments[i]?.trim() || undefined,
        progressFile,
        base: (doneBytes / totalBytes) * 50,
        span: (file.size / totalBytes) * 50,
      });
      doneBytes += file.size;
    }
    updateUpload(progressFile, {
      status: 'transcribing',
      progress: 50,
      transcriptId: last!.assemblyai_id,
    });
    onTranscriptCreated?.();
    await pollUntilDone(progressFile, last!.assemblyai_id);
  };

  const startUpload = useCallback(
    async (
      files: File[],
      languageCode: string,
      linked: LinkedEvent | null,
      pref: ReportPref,
      stitch?: { comments: string[] }
    ) => {
      if (stitch && files.length > 1) {
        const progressFile = files[0]!;
        setUploads((prev) => [
          ...prev,
          { file: progressFile, status: 'uploading', progress: 0 },
        ]);
        try {
          await submitStitchGroup(files, stitch.comments, languageCode, linked, pref);
        } catch (error) {
          updateUpload(progressFile, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Upload failed',
          });
        }
        return;
      }
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

  const handleFilesSelected = useCallback(
    (files: FileList) => {
      const all = Array.from(files);
      if (all.length === 0) return;
      if (blockedRef.current) {
        flashOfflineNotice();
        return;
      }
      const texts = all.filter(isTextTranscriptFile);
      const list = all.filter((f) => !isTextTranscriptFile(f));

      // All-text selection → the import-text lane on the 'pick' step. The
      // media wizard's language/report steps don't apply to a document.
      if (list.length === 0) {
        setTextFiles(texts);
        setTextError(null);
        setPasteOpen(false);
        setPasteResult(null);
        setPasteError(null);
        setSkippedTextNames([]);
        setPendingFiles([]);
        // Same keep-the-pre-link rule as media: only inside the open dialog,
        // and only for a single file (one event ↔ one transcript).
        const keepTextLink = isDialogOpen && texts.length === 1;
        if (!keepTextLink) {
          setPrefill(null);
          setSelectedEventId(null);
          setDayEvents([]);
        }
        setStep(googleOk === false && !connectSkipped ? 'connect' : 'pick');
        setIsDialogOpen(true);
        return;
      }

      setSkippedTextNames(texts.map((f) => f.name));
      setTextFiles([]);
      setPendingFiles(list);
      // A batch that arrives with a calendar event in hand is almost always
      // one meeting recorded in pieces — default to stitching those.
      setStitchMode(list.length > 1 && isDialogOpen && !!prefill);
      setPartComments(list.map(() => ''));
      setSelectedLanguage('');
      setReportPref('summary');
      setEventsError(null);
      // Coming from the 'pick' step, the pre-link banner's selection carries
      // straight into the link step. Page-wide drag-drop (dialog closed)
      // starts fresh. Batches keep the link too now — it only ATTACHES when
      // the batch is stitched into one meeting (or is a single file).
      const keepLink = isDialogOpen;
      if (!keepLink) {
        setPrefill(null);
        setSelectedEventId(null);
        setDayEvents([]);
      }
      // A calendar-row "Upload…" arrives with the event's day already known;
      // otherwise the file's own timestamp is a better first guess for the
      // calendar day than today.
      const activePrefill = keepLink ? prefill : null;
      if (activePrefill) {
        setLinkDate(activePrefill.date);
      } else {
        const stamp = list[0]?.lastModified;
        setLinkDate(localDateOf(stamp ? new Date(stamp) : new Date()));
      }
      // Drag-drop lands here with a file already in hand — a not-connected
      // user still gets the gate first (with the re-select caveat spelled out).
      setStep(googleOk === false && !connectSkipped ? 'connect' : 'files');
      setIsDialogOpen(true);
    },
    [googleOk, connectSkipped, isDialogOpen, prefill, flashOfflineNotice]
  );

  /** Load the day's calendar events for the link step and the 'pick' step's
   * pre-link banner (silent server-minted token — same as the Meet import
   * dialog). `preselect` lands the selection on that event when it exists on
   * the day; when it doesn't (or the calendar is unreachable), any active
   * pre-link is dropped so the banner never promises a link it can't make. */
  const loadDayEvents = useCallback(
    async (forDate: string, preselect?: string | null) => {
      if (blockedRef.current) {
        // No calendar reachable — the link step shows its own offline line.
        if (preselect) setPrefill(null);
        setDayEvents([]);
        setEventsBusy(false);
        setEventsError(null);
        return;
      }
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
        const items = (data.items ?? []).filter((e) => e.start?.dateTime);
        setDayEvents(items);
        if (preselect) {
          if (items.some((e) => e.id === preselect)) {
            setSelectedEventId(preselect);
          } else {
            setPrefill(null);
          }
        }
      } catch (err) {
        if (preselect) setPrefill(null);
        if (err instanceof GoogleNotConnectedError) {
          setGoogleOk(false);
        } else if (isNetworkFailure(err)) {
          setEventsError(OFFLINE_TITLE);
        } else {
          setEventsError(err instanceof Error ? err.message : 'Failed to load calendar');
        }
      } finally {
        setEventsBusy(false);
      }
    },
    []
  );

  // The calendar rows' "Upload…" entries and the header's "Upload media"
  // button dispatch this. It opens the dialog at the 'pick' step (drop zone +
  // paste lane) — never the native picker directly, so the pre-link survives
  // in React state instead of dying across the native-chooser boundary.
  // Not-connected users see the Google gate first (connecting navigates away).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = ((e as CustomEvent).detail as MediaUploadPrefill | null) ?? null;
      setPrefill(detail);
      setPendingFiles([]);
      setStitchMode(false);
      setPartComments([]);
      setSelectedLanguage('');
      setReportPref('summary');
      setSelectedEventId(null);
      setDayEvents([]);
      setEventsError(null);
      setPasteOpen(false);
      setPasteText('');
      setPasteError(null);
      setPasteResult(null);
      setTextFiles([]);
      setTextError(null);
      setSkippedTextNames([]);
      const date = detail?.date ?? localDateOf(new Date());
      setLinkDate(date);
      if (googleOk === false && !connectSkipped) {
        setStep('connect');
      } else {
        setStep('pick');
        // Resolve the pre-link banner's title/time from the day's events.
        if (detail) void loadDayEvents(date, detail.eventId);
      }
      setIsDialogOpen(true);
    };
    window.addEventListener(AUDIO_UPLOAD_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(AUDIO_UPLOAD_OPEN_EVENT, onOpen);
  }, [googleOk, connectSkipped, loadDayEvents]);

  const changeLinkDate = (next: string) => {
    setLinkDate(next);
    setSelectedEventId(null);
    void loadDayEvents(next);
  };

  const goToLinkStep = () => {
    setStep('link');
    // Keep the pre-link (or an earlier manual pick) selected across the
    // reload — state-driven, so it survives however the files arrived.
    void loadDayEvents(linkDate, selectedEventId ?? prefill?.eventId ?? null);
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
    const stitching = stitchMode && pendingFiles.length > 1;
    // A linked event only attaches when it maps to ONE transcript — never to
    // each row of an independent batch.
    const linked = canLink ? buildLinkedEvent() : null;
    startUpload(
      pendingFiles,
      selectedLanguage,
      linked,
      reportPref,
      stitching ? { comments: partComments } : undefined
    );
    setPendingFiles([]);
    setStitchMode(false);
    setPartComments([]);
  };

  const handleCancelUpload = () => {
    setIsDialogOpen(false);
    setPendingFiles([]);
    setStitchMode(false);
    setPartComments([]);
    setSelectedLanguage('');
    setPrefill(null);
    setPasteOpen(false);
    setPasteText('');
    setPasteError(null);
    setPasteResult(null);
    setTextFiles([]);
    setTextError(null);
    setSkippedTextNames([]);
  };

  /** The 'pick' step's paste lane: route the text through the same import
   * API as the "Import a transcript" dialog, carrying the pre-linked event
   * along so the transcript lands with the meeting's title and invitees. */
  const importPastedText = async () => {
    if (pasteBusy) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      const linked = prefill ? buildLinkedEvent() : null;
      const res = await fetch('/api/transcripts/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: pasteText,
          ...(linked ? { linkedEvent: linked } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error || `Import failed (${res.status})`);
      }
      const payload = (await res.json()) as {
        queued?: boolean;
        transcript?: { assemblyai_id?: string };
      };
      setPasteResult({
        queued: res.status === 202 && !!payload.queued,
        id: payload.transcript?.assemblyai_id ?? null,
      });
      onTranscriptCreated?.();
    } catch (err) {
      setPasteError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Import failed');
    } finally {
      setPasteBusy(false);
    }
  };

  /** The 'pick' step's text-file lane: post the document bytes to the same
   * import API (it extracts text server-side — rtf/docx/pdf/…), carrying the
   * pre-linked event when there's exactly one file. Reuses the paste lane's
   * result panel. */
  const importTextFiles = async () => {
    if (textBusy || textFiles.length === 0) return;
    setTextBusy(true);
    setTextError(null);
    try {
      const linked = textFiles.length === 1 && prefill ? buildLinkedEvent() : null;
      let anyQueued = false;
      let lastId: string | null = null;
      for (const f of textFiles) {
        const res = await fetch('/api/transcripts/import-text', {
          method: 'POST',
          headers: {
            'Content-Type': f.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(f.name),
            ...(linked
              ? { 'x-linked-event': encodeURIComponent(JSON.stringify(linked)) }
              : {}),
          },
          body: f,
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}) as { error?: string });
          throw new Error(detail.error || `Import failed (${res.status})`);
        }
        const payload = (await res.json()) as {
          queued?: boolean;
          assemblyaiId?: string;
          transcript?: { assemblyai_id?: string };
        };
        if (res.status === 202 && payload.queued) anyQueued = true;
        lastId = payload.transcript?.assemblyai_id ?? payload.assemblyaiId ?? null;
      }
      setPasteResult({
        queued: anyQueued,
        id: textFiles.length === 1 ? lastId : null,
      });
      setTextFiles([]);
      onTranscriptCreated?.();
    } catch (err) {
      setTextError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Import failed');
    } finally {
      setTextBusy(false);
    }
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
      // Always swallow the drop — otherwise the browser navigates the tab
      // to the file. While blocked, say why instead of opening the stepper.
      e.preventDefault();
      if (blockedRef.current) {
        flashOfflineNotice();
        return;
      }
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
  }, [handleFilesSelected, flashOfflineNotice]);

  // Closing the tab kills the in-flight XHR and everything sent so far —
  // there is no resume. Once the POST returns (status 'transcribing') the
  // server owns the job and closing is harmless, so only 'uploading' warns.
  const hasActiveUpload = uploads.some((u) => u.status === 'uploading');
  useEffect(() => {
    if (!hasActiveUpload) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy engines need returnValue set for the prompt to show.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasActiveUpload]);

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
        return 'Uploaded · transcribing';
      case 'completed':
        return 'Transcript ready';
      case 'error':
        return upload.error || 'Error';
      default:
        return 'Processing...';
    }
  };

  // One calendar event ↔ one transcript: a single file, or a batch being
  // stitched into one meeting. Independent batches skip the link step.
  const canLink = pendingFiles.length === 1 || (pendingFiles.length > 1 && stitchMode);
  // A calendar-row "Upload…" arrives with its event already resolved and
  // selected — asking "link to a calendar meeting?" again is the one question
  // the flow already knows the answer to, so those skip the link step (the
  // process step's banner + Change button keep it editable).
  const preLinked =
    !!prefill &&
    !!selectedEventId &&
    dayEvents.some((e) => e.id === selectedEventId);
  const hasVideoFile = pendingFiles.some(
    (f) => f.type.startsWith('video/') || VIDEO_FILE_RE.test(f.name)
  );
  const selectedEvent = selectedEventId
    ? dayEvents.find((e) => e.id === selectedEventId)
    : undefined;

  // The unified generation shape — quick summary is always written, detailed
  // is an opt-in on top, "later" defers the whole thing. All states map onto
  // the legacy ReportPref wire values, so the server contract is unchanged.
  const prefLater = reportPref === 'later';
  const prefDetailed = reportPref === 'detailed-video' || reportPref === 'detailed-text';

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
              {blocked ? (
                <>
                  <p className="mt-3 text-sm font-medium">{OFFLINE_TITLE}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Uploads need a connection.</p>
                </>
              ) : (
                <>
                  <p className="mt-3 text-sm font-medium">
                    Drop a recording or transcript file
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    audio/video up to 4 GB · or .txt · .docx · .pdf · .rtf
                  </p>
                </>
              )}
            </div>
          </div>
        )}
        {offlineNotice && (
          <div
            role="status"
            className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border bg-card px-4 py-2 text-sm shadow-lg"
          >
            <AlertCircle className="mr-1.5 inline h-4 w-4 text-muted-foreground" />
            {OFFLINE_TITLE}
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
                {upload.status === 'uploading' && upload.note && (
                  <p className="mt-1 text-xs text-muted-foreground">{upload.note}</p>
                )}
                {upload.status === 'transcribing' && (
                  <p className="mt-1 text-xs text-status-ok">
                    Upload complete — safe to close this tab. You&apos;ll get a Slack DM when the
                    transcript is ready for speaker review.
                  </p>
                )}
                {upload.status === 'error' && upload.error && (
                  <p className="mt-1 text-xs text-destructive">{upload.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={(o) => !o && handleCancelUpload()}>
        <DialogContent className="rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {step === 'connect' && 'Connect Google Calendar first'}
              {step === 'pick' && 'Add a meeting recording'}
              {step === 'files' && 'Upload media'}
              {step === 'link' && 'Link to a calendar meeting?'}
              {step === 'process' && 'How should it be processed?'}
            </DialogTitle>
          </DialogHeader>

          {step === 'connect' && (
            <div className="min-w-0 space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                Uploads work best with your calendar connected: linking the
                meeting&apos;s invite fills in the title, time and attendees, so
                speaker name-guessing and the AI summary start with real context.
              </p>
              <p className="text-xs text-muted-foreground">
                It&apos;s a one-time connect — you&apos;ll hop to Google&apos;s
                consent screen and land right back here.
                {(pendingFiles.length > 0 || textFiles.length > 0) &&
                  ' The file you just dropped can’t survive that trip, so you’ll re-select it afterwards.'}
              </p>
            </div>
          )}

          {step === 'pick' && (
            <div className="min-w-0 space-y-3 py-2">
              {pasteResult ? (
                <div className="space-y-2 py-4 text-center">
                  {pasteResult.queued ? (
                    <Sparkles className="mx-auto h-10 w-10 text-primary" />
                  ) : (
                    <CheckCircle className="mx-auto h-10 w-10 text-status-ok" />
                  )}
                  <p className="text-sm font-medium">
                    {pasteResult.queued ? 'Import started' : 'Transcript imported'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {pasteResult.queued
                      ? 'AI is tidying the text into a proper transcript — usually under a minute. It already shows in your list and will flip to ready on its own.'
                      : 'It’s in your list now, with named speakers.'}
                  </p>
                  {pasteResult.id && (
                    <a href={`/transcript/${pasteResult.id}`} className="inline-block">
                      <Button size="sm" variant="outline">
                        Open transcript
                      </Button>
                    </a>
                  )}
                </div>
              ) : (
                <>
                  {prefill && (
                    <div className="flex items-start justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
                      <p className="min-w-0 text-xs text-muted-foreground">
                        <CalendarDays className="mr-1.5 inline h-3.5 w-3.5 text-primary" />
                        {selectedEvent ? (
                          <>
                            Linking to{' '}
                            <span className="font-medium text-foreground">
                              {selectedEvent.summary ?? '(no title)'}
                            </span>
                            {' — '}
                            {fmtEventDay(selectedEvent)}, {fmtEventTime(selectedEvent)}
                          </>
                        ) : (
                          'Finding this meeting on your calendar…'
                        )}
                      </p>
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Don’t link to this meeting"
                        onClick={() => {
                          setPrefill(null);
                          setSelectedEventId(null);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={blocked}
                    title={blocked ? OFFLINE_TITLE : undefined}
                    className="w-full rounded-xl border-2 border-dashed p-6 text-center transition-colors hover:border-primary hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border disabled:hover:bg-transparent"
                  >
                    <Upload className="mx-auto h-6 w-6 text-primary" />
                    <p className="mt-2 text-sm font-medium">
                      Drop a recording here, or click to choose a file
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      audio or video · up to 4 GB · mp4 · mp3 · m4a · wav — or a
                      transcript document (.txt · .docx · .pdf · .rtf)
                    </p>
                  </button>
                  {textFiles.length > 0 && (
                    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                      <div className="space-y-1">
                        {textFiles.map((f, i) => (
                          <p key={i} className="flex min-w-0 items-center gap-2 text-sm font-medium">
                            <FileText className="h-4 w-4 shrink-0 text-primary" />
                            <span className="min-w-0 truncate">{f.name}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                              {formatFileSize(f.size)}
                            </span>
                          </p>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {textFiles.length === 1
                          ? 'This is a text document, not a recording — it’ll import as a transcript (no playback or voice matching).'
                          : 'These are text documents, not recordings — they’ll import as transcripts (no playback or voice matching).'}
                      </p>
                      {textError && (
                        <p className="flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="h-4 w-4" />
                          {textError}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => void importTextFiles()}
                          // Wait for the pre-link banner to resolve, same as
                          // the paste lane — no importing without its event.
                          disabled={blocked || textBusy || (!!prefill && eventsBusy)}
                          title={blocked ? OFFLINE_TITLE : undefined}
                        >
                          {textBusy ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Sparkles className="h-4 w-4" />
                          )}
                          Import as transcript
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setTextFiles([]);
                            setTextError(null);
                          }}
                          disabled={textBusy}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  )}
                  {!pasteOpen ? (
                    <button
                      type="button"
                      onClick={() => setPasteOpen(true)}
                      className="w-full rounded-md border p-2.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
                    >
                      <FileText className="mr-2 inline h-4 w-4" />
                      …or paste a transcript instead
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <textarea
                        autoFocus
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        placeholder={'e.g.\n[10:02] Jane Tan: morning everyone…\nJohn: shall we start?'}
                        className="h-28 w-full resize-y rounded-md border bg-transparent p-2 font-mono text-sm"
                        disabled={pasteBusy}
                      />
                      {pasteError && (
                        <p className="flex items-center gap-1 text-xs text-destructive">
                          <AlertCircle className="h-4 w-4" />
                          {pasteError}
                        </p>
                      )}
                      <Button
                        size="sm"
                        onClick={() => void importPastedText()}
                        // Also wait for the pre-link banner to resolve, so a
                        // fast paste doesn't import without its event link.
                        disabled={
                          blocked ||
                          pasteBusy ||
                          pasteText.trim().length < 20 ||
                          (!!prefill && eventsBusy)
                        }
                        title={blocked ? OFFLINE_TITLE : undefined}
                      >
                        {pasteBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        Import text
                      </Button>
                    </div>
                  )}
                  <div className="space-y-1 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <p>
                      <Film className="mr-1.5 inline h-3.5 w-3.5" />
                      <span className="font-medium text-foreground">Video</span> is best —
                      detailed reports can read screen shares and include screenshots.
                    </p>
                    <p>
                      <FileAudio className="mr-1.5 inline h-3.5 w-3.5" />
                      <span className="font-medium text-foreground">Audio</span> gets full
                      transcription, speaker voice matching, and playback.
                    </p>
                    <p>
                      <FileText className="mr-1.5 inline h-3.5 w-3.5" />
                      <span className="font-medium text-foreground">Pasted text</span>{' '}
                      imports instantly — but with no recording there’s no voice matching
                      or playback.
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* min-w-0 on every step wrapper: DialogContent is a grid, and
              without it a long filename sizes the item to min-content and
              paints outside the card. */}
          {step === 'files' && (
            <div className="min-w-0 space-y-4 py-2">
              {skippedTextNames.length > 0 && (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <FileText className="mr-1.5 inline h-3.5 w-3.5" />
                  Set aside {skippedTextNames.join(', ')} — text documents import
                  separately (drop {skippedTextNames.length === 1 ? 'it' : 'them'}{' '}
                  again on {skippedTextNames.length === 1 ? 'its' : 'their'} own).
                </p>
              )}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} selected:
                </p>
                {pendingFiles.length > 1 && (
                  <label className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 has-[:checked]:border-primary">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={stitchMode}
                      onChange={(e) => setStitchMode(e.target.checked)}
                    />
                    <span className="text-sm">
                      <span className="font-medium">
                        These are recordings of the same meeting — stitch into one transcript
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        The files are joined in the order below into a single recording and
                        transcribed once. Add a note per file (which mic, rejoin after a drop,
                        …) — the AI uses it to make sense of the joins. Unticked: each file
                        becomes its own independent meeting.
                      </span>
                    </span>
                  </label>
                )}
                <ul className="text-sm space-y-1">
                  {pendingFiles.map((file, i) => (
                    <li key={`${file.name}-${i}`} className="space-y-1">
                      <div className="flex min-w-0 items-center gap-2">
                        {stitchMode && pendingFiles.length > 1 && (
                          <span className="flex shrink-0 items-center gap-0.5">
                            <span className="w-4 text-xs text-muted-foreground">{i + 1}.</span>
                            <button
                              type="button"
                              disabled={i === 0}
                              className="rounded border px-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                              title="Move earlier"
                              onClick={() => {
                                setPendingFiles((prev) => {
                                  const next = [...prev];
                                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                                  return next;
                                });
                                setPartComments((prev) => {
                                  const next = [...prev];
                                  [next[i - 1], next[i]] = [next[i] ?? '', next[i - 1] ?? ''];
                                  return next;
                                });
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              disabled={i === pendingFiles.length - 1}
                              className="rounded border px-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
                              title="Move later"
                              onClick={() => {
                                setPendingFiles((prev) => {
                                  const next = [...prev];
                                  [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
                                  return next;
                                });
                                setPartComments((prev) => {
                                  const next = [...prev];
                                  [next[i], next[i + 1]] = [next[i + 1] ?? '', next[i] ?? ''];
                                  return next;
                                });
                              }}
                            >
                              ↓
                            </button>
                          </span>
                        )}
                        <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{file.name}</span>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {formatFileSize(file.size)}
                        </Badge>
                      </div>
                      {stitchMode && pendingFiles.length > 1 && (
                        <Input
                          value={partComments[i] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPartComments((prev) => {
                              const next = [...prev];
                              next[i] = v;
                              return next;
                            });
                          }}
                          placeholder="Note for the AI — e.g. 'room mic, first half' or 'rejoined after the drop'"
                          maxLength={500}
                          className="ml-6 h-7 text-xs"
                        />
                      )}
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
                    disabled={blocked}
                    title={blocked ? OFFLINE_TITLE : undefined}
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
                      disabled={eventsBusy || blocked}
                      title={blocked ? OFFLINE_TITLE : undefined}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Input
                      type="date"
                      value={linkDate}
                      onChange={(e) => e.target.value && changeLinkDate(e.target.value)}
                      className="w-36"
                      disabled={eventsBusy || blocked}
                      title={blocked ? OFFLINE_TITLE : undefined}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => changeLinkDate(shiftDate(linkDate, 1))}
                      disabled={eventsBusy || blocked}
                      title={blocked ? OFFLINE_TITLE : undefined}
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
                    {blocked ? (
                      <p className="p-3 text-xs text-muted-foreground">
                        Calendar linking — {OFFLINE_TITLE}
                      </p>
                    ) : dayEvents.length === 0 && !eventsBusy ? (
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
                <p className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    <CalendarDays className="mr-1.5 inline h-3.5 w-3.5" />
                    Linked to{' '}
                    <span className="font-medium">{selectedEvent.summary}</span>
                    {' · '}
                    {fmtEventTime(selectedEvent)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 underline decoration-dotted underline-offset-2 hover:text-foreground"
                    onClick={goToLinkStep}
                  >
                    Change
                  </button>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                First the AI guesses who&apos;s speaking (voiceprints + context), you
                confirm the names, and only then does this run — so it&apos;s written
                with real names from the start.
              </p>
              <div className="space-y-1.5">
                <label
                  className={`flex items-start gap-2 rounded-md border p-3 ${prefLater ? 'opacity-50' : ''}`}
                >
                  <input type="checkbox" className="mt-0.5" checked={!prefLater} disabled readOnly />
                  <span className="text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <Sparkles className="h-4 w-4 text-primary" />
                      Quick summary
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Always written — fast and clean.
                    </span>
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[:checked]:border-primary ${prefLater ? 'pointer-events-none opacity-50' : ''}`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={prefDetailed}
                    disabled={prefLater}
                    onChange={(e) =>
                      setReportPref(
                        e.target.checked
                          ? hasVideoFile
                            ? 'detailed-video'
                            : 'detailed-text'
                          : 'summary'
                      )
                    }
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <FileText className="h-4 w-4 text-primary" />
                      Also write a detailed report
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Wiki-style deep dive with tables and click-to-jump citations. Slower and
                      pricier — worth it for dense meetings. The quick summary then distills
                      from it.
                    </span>
                    {prefDetailed && hasVideoFile && (
                      <span className="mt-2 block space-y-1">
                        <label className="flex cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="radio"
                            name="upload-report-mode"
                            checked={reportPref === 'detailed-video'}
                            onChange={() => setReportPref('detailed-video')}
                          />
                          <Film className="h-3.5 w-3.5 text-primary" />
                          With video frames — Claude reads the screen shares and embeds
                          screenshots
                        </label>
                        <label className="flex cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="radio"
                            name="upload-report-mode"
                            checked={reportPref === 'detailed-text'}
                            onChange={() => setReportPref('detailed-text')}
                          />
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                          Text only — cheaper, for meetings with no screen share worth seeing
                        </label>
                      </span>
                    )}
                  </span>
                </label>
                <label className="flex cursor-pointer items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={prefLater}
                    onChange={(e) => setReportPref(e.target.checked ? 'later' : 'summary')}
                  />
                  Don&apos;t generate anything yet — I&apos;ll decide on the meeting page
                </label>
              </div>
            </div>
          )}

          <DialogFooter>
            {!(step === 'pick' && pasteResult) && (
              <Button variant="ghost" onClick={handleCancelUpload}>
                Cancel
              </Button>
            )}
            {step === 'pick' && pasteResult && (
              <Button onClick={handleCancelUpload}>Done</Button>
            )}
            {step === 'connect' && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConnectSkipped(true);
                    // Drag-drop path arrives with the file in hand; the
                    // button/menu path continues to the drop-zone step.
                    setStep(pendingFiles.length > 0 ? 'files' : 'pick');
                    // A pre-link can't resolve without Google — this probe
                    // fails fast and drops the banner honestly.
                    if (pendingFiles.length === 0 && prefill) {
                      void loadDayEvents(prefill.date, prefill.eventId);
                    }
                  }}
                >
                  Skip for now
                </Button>
                <Button onClick={() => connectGoogle('/')} disabled={blocked} title={blocked ? OFFLINE_TITLE : undefined}>
                  <CalendarDays className="h-4 w-4" />
                  Connect Google Calendar
                </Button>
              </>
            )}
            {step === 'files' && (
              <>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setPendingFiles([]);
                    setStep('pick');
                  }}
                >
                  Back
                </Button>
                <Button
                  onClick={() => {
                    if (canLink && !preLinked) goToLinkStep();
                    else setStep('process');
                  }}
                  disabled={pendingFiles.length === 0}
                >
                  Next
                </Button>
              </>
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
                <Button onClick={handleConfirmUpload} disabled={blocked} title={blocked ? OFFLINE_TITLE : undefined}>
                  Start Transcription
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

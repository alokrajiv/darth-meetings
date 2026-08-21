'use client';

import { useState, useEffect, useCallback, useMemo, useRef, use } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveEvents } from '@/hooks/use-live-events';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SeriesBadge } from '@/components/series-badge';
import { SeriesDialog } from '@/components/series-dialog';
import {
  formatDuration,
  formatTime,
  type StoredTranscript,
  type TranscriptResponse,
  type SpeakerLabel,
  type SpeakerSuggestionMap,
  type TranscriptEditMap,
  type TranscriptAccess,
  type TranscriptShare,
} from '@/lib/format';
import { AudioPlayer, type AudioPlayerHandle } from '@/components/audio-player';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { NotesMarkdown } from '@/components/notes-markdown';
import { EditableUtterance, type UtteranceHighlight } from '@/components/editable-utterance';
import { FindReplacePanel } from '@/components/find-replace-panel';
import { SpeakerSummaryPanel } from '@/components/speaker-summary-panel';
import { SpeakerReviewDialog } from '@/components/speaker-review-dialog';
import { GenerateDialog } from '@/components/generate-dialog';
import { AttachmentPanel } from '@/components/attachment-panel';
import { ShareDialog } from '@/components/share-dialog';
import { LinkEventDialog } from '@/components/link-event-dialog';
import { AddPersonDialog } from '@/components/add-person-dialog';
import { ActivityBar } from '@/components/activity-bar';
import { TranscriptOutline } from '@/components/transcript-outline';
import { AppHeader } from '@/components/app-header';
import { RerunDiarizationButton } from '@/components/rerun-diarization-button';
import { TranscriptSourcesCard } from '@/components/transcript-sources-card';
import { MeetingInfoCard } from '@/components/meeting-info-card';
import type { PickerPerson } from '@/components/user-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { defaultSpeakerLabel } from '@/lib/speaker-display';
import { extractHeadings, makeSlugger } from '@/lib/markdown-headings';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  RefreshCw,
  Download,
  Copy,
  ChevronDown,
  ChevronUp,
  Search,
  Eye,
  Pencil,
  Users,
  ListTree,
  Loader2,
  Sparkles,
  MoreHorizontal,
  Video,
  FileAudio,
  FileText,
  Headphones,
  CalendarSearch,
  ExternalLink,
  Trash2,
} from 'lucide-react';

/**
 * Find the index of the utterance whose [start, end) interval contains the
 * given timestamp (milliseconds). Returns -1 if none. Linear scan — fine for
 * a few thousand utterances.
 */
function findUtteranceIndexAtMs(
  utterances: TranscriptResponse['utterances'],
  ms: number
): number {
  if (!utterances) return -1;
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i]!;
    if (ms >= u.start && ms < u.end) return i;
    if (ms < u.start) return -1;
  }
  return -1;
}

type ViewMode = 'raw' | 'edited';

const FLOATING_SHADOW =
  'shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]';

interface TranscriptDetailPageProps {
  params: Promise<{ id: string }>;
}

export default function TranscriptDetailPage({ params }: TranscriptDetailPageProps) {
  const router = useRouter();
  const { id: transcriptId } = use(params);

  const [row, setRow] = useState<StoredTranscript | null>(null);
  const [access, setAccess] = useState<TranscriptAccess>('owner');
  const [shareOpen, setShareOpen] = useState(false);
  const [linkEventOpen, setLinkEventOpen] = useState(false);
  // Meeting-date inline editor state.
  const [dateEditOpen, setDateEditOpen] = useState(false);
  const [dateDraft, setDateDraft] = useState('');
  const [dateSaving, setDateSaving] = useState(false);
  // Unshared internal people detected in this meeting (named speakers /
  // invitees) — drives the nudge dot on the Share buttons. Owner-only
  // server-side; refreshed whenever sharing changes.
  const [shareSuggestionCount, setShareSuggestionCount] = useState(0);
  const refreshShareSuggestions = useCallback(async () => {
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/share-suggestions`);
      if (!res.ok) return;
      const { suggestions } = (await res.json()) as { suggestions: unknown[] };
      setShareSuggestionCount(suggestions.length);
    } catch {
      // best-effort
    }
  }, [transcriptId]);
  useEffect(() => {
    void refreshShareSuggestions();
  }, [refreshShareSuggestions]);
  const [collaboratorEmails, setCollaboratorEmails] = useState<Set<string>>(
    () => new Set()
  );
  const [pendingShare, setPendingShare] = useState<PickerPerson | null>(null);
  const [sharingPending, setSharingPending] = useState(false);
  const [sharingError, setSharingError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<{
    originalSpeaker: string;
    name: string;
  } | null>(null);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [activityTick, setActivityTick] = useState(0);
  const bumpActivity = useCallback(() => setActivityTick((t) => t + 1), []);
  const [content, setContent] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canEdit = access === 'owner' || access === 'edit';

  const [speakerLabels, setSpeakerLabels] = useState<SpeakerLabel[]>([]);
  const [speakerSuggestions, setSpeakerSuggestions] = useState<SpeakerSuggestionMap>({});
  const [transcriptEdits, setTranscriptEdits] = useState<TranscriptEditMap>({});
  const [generatingNotes, setGeneratingNotes] = useState(false);
  const [notesPromptOpen, setNotesPromptOpen] = useState(false);
  // Pre-tick "detailed report" in the generate dialog when it's opened from a
  // report-tab context.
  const [genDefaultDetailed, setGenDefaultDetailed] = useState(false);
  const openGenerateDialog = (detailed: boolean) => {
    setGenDefaultDetailed(detailed);
    setNotesPromptOpen(true);
  };
  const [reviewOpen, setReviewOpen] = useState(false);
  const [summaryTab, setSummaryTab] = useState<'summary' | 'report'>('summary');
  const [generatingReport, setGeneratingReport] = useState(false);

  // Deep-linkable tab: ?tab=report|summary selects on load, and tab clicks
  // keep the URL in sync so the address bar is always shareable. When neither
  // the URL nor a click has spoken, the detailed report — the richer read —
  // is the default whenever one exists (see the effect below).
  const tabExplicit = useRef(false);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'report' || t === 'summary') {
      tabExplicit.current = true;
      setSummaryTab(t);
    }
  }, []);
  const selectSummaryTab = useCallback((tab: 'summary' | 'report') => {
    tabExplicit.current = true;
    setSummaryTab(tab);
    const url = new URL(window.location.href);
    // Both values are written explicitly — with report as the default view,
    // a bare URL must not silently flip a shared "summary" link back.
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url.toString());
  }, []);
  useEffect(() => {
    if (tabExplicit.current) return;
    if (row?.auto_report) setSummaryTab('report');
  }, [row?.auto_report]);
  // Data changes the AI hasn't seen yet (speaker renames, attachments,
  // calendar link) — keyed so each source registers once. Drives both the
  // in-tab stale banner and the glimmering nudge in the right panel.
  const [staleReasons, setStaleReasons] = useState<Record<string, string>>({});
  const markAiStale = useCallback((key: string, label: string) => {
    setStaleReasons((prev) => (prev[key] === label ? prev : { ...prev, [key]: label }));
  }, []);
  const staleLabels = Object.values(staleReasons);
  const notesStale =
    staleLabels.length > 0
      ? `Changed since the last AI run: ${staleLabels.join(', ')}. Rerun to fold them in.`
      : null;
  const [aiStats, setAiStats] = useState<{
    latest: {
      cost_usd: string | null;
      duration_ms: number | null;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_creation_tokens: string | null;
      model: string | null;
      triggered_by_email: string | null;
    } | null;
    latestReport: {
      cost_usd: string | null;
      duration_ms: number | null;
      model: string | null;
      triggered_by_email: string | null;
    } | null;
    totals: { runs: number; cost_usd: string | null };
  } | null>(null);
  // Raw run list for the cost-breakdown popup (regenerations add up).
  const [aiRuns, setAiRuns] = useState<Array<Record<string, unknown>>>([]);
  const [aiRunsOpen, setAiRunsOpen] = useState(false);

  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  // --- recurring-call series (the badge in the meta row) ---
  const [seriesMembership, setSeriesMembership] = useState<
    { series_id: number; title: string } | null | 'loading'
  >('loading');
  const [openSeriesId, setOpenSeriesId] = useState<number | null>(null);
  const loadSeriesInfo = useCallback(() => {
    fetch(`/api/transcripts/${transcriptId}/series`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSeriesMembership(d?.membership ?? null))
      .catch(() => setSeriesMembership(null));
  }, [transcriptId]);
  useEffect(() => {
    loadSeriesInfo();
  }, [loadSeriesInfo]);

  // --- audio player state ---
  const playerRef = useRef<AudioPlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0); // seconds, from <audio>
  const [audioAvailable, setAudioAvailable] = useState(true);

  // --- view mode + find/replace ---
  const [viewMode, setViewMode] = useState<ViewMode>('edited');
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [currentMatchPos, setCurrentMatchPos] = useState(0); // 0-based

  // --- derived helpers ---

  const currentUtteranceIndex = useMemo(
    () => findUtteranceIndexAtMs(content?.utterances, currentTime * 1000),
    [content?.utterances, currentTime]
  );

  /**
   * Map utterance index → AI segment starting at that utterance, so the
   * transcript body can render a section heading above it. Each segment
   * anchors to the first utterance at/after its start time.
   */
  const segmentByUtterance = useMemo(() => {
    const map = new Map<number, { title: string; start_ms: number }>();
    const segs = row?.auto_segments;
    const utterances = content?.utterances;
    if (!segs?.length || !utterances?.length) return map;
    let u = 0;
    for (const seg of segs) {
      while (u < utterances.length && utterances[u]!.start < seg.start_ms - 500) u++;
      if (u >= utterances.length) break;
      if (!map.has(u)) map.set(u, seg);
    }
    return map;
  }, [row?.auto_segments, content?.utterances]);

  /**
   * The AI segment the playhead is currently inside — shown as a "Now: …"
   * line on the sticky audio bar. Null before playback starts.
   */
  const nowSegment = useMemo(() => {
    const segs = row?.auto_segments;
    if (!segs?.length || currentTime <= 0) return null;
    let cur: { title: string; start_ms: number } | null = null;
    for (const seg of segs) {
      if (seg.start_ms <= currentTime * 1000) cur = seg;
      else break;
    }
    return cur;
  }, [row?.auto_segments, currentTime]);

  /**
   * Resolve a raw speaker key into the display name, applying speaker_mappings.
   * In raw view we deliberately bypass mappings to show the original AAI labels.
   */
  const speakerDisplayName = useCallback(
    (originalSpeaker: string): string => {
      if (viewMode === 'raw') return defaultSpeakerLabel(originalSpeaker);
      const mapping = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
      return mapping?.customName || defaultSpeakerLabel(originalSpeaker);
    },
    [speakerLabels, viewMode]
  );

  /**
   * Compose the display text for one utterance — raw text or with the user's
   * per-utterance text override applied. In raw mode, edits are ignored.
   */
  const displayTextFor = useCallback(
    (index: number): string => {
      const raw = content?.utterances?.[index]?.text ?? '';
      if (viewMode === 'raw') return raw;
      const edit = transcriptEdits[String(index)];
      return edit?.text ?? raw;
    },
    [content?.utterances, transcriptEdits, viewMode]
  );

  const isTextEdited = useCallback(
    (index: number): boolean => {
      const raw = content?.utterances?.[index]?.text ?? '';
      const edit = transcriptEdits[String(index)];
      return edit?.text !== undefined && edit.text !== raw;
    },
    [content?.utterances, transcriptEdits]
  );

  // --- network actions ---

  const loadAll = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setLoading(true);
      setError(null);

      const [rowRes, speakersRes, editsRes, sharesRes] = await Promise.all([
        fetch(`/api/transcripts/${transcriptId}`),
        fetch(`/api/transcripts/${transcriptId}/speakers`),
        fetch(`/api/transcripts/${transcriptId}/edits`),
        fetch(`/api/transcripts/${transcriptId}/shares`),
      ]);

      if (rowRes.status === 404) {
        setError('Transcript not found');
        return;
      }
      if (!rowRes.ok) {
        throw new Error(`Failed to load transcript (${rowRes.status})`);
      }
      const { transcript } = (await rowRes.json()) as {
        transcript: StoredTranscript & { access?: TranscriptAccess };
      };
      setRow(transcript);
      setAccess(transcript.access ?? 'owner');
      setTitle(transcript.title || '');
      setDescription(transcript.description || '');

      if (speakersRes.ok) {
        const { speakerLabels: labels, suggestions } = (await speakersRes.json()) as {
          speakerLabels: SpeakerLabel[];
          suggestions?: SpeakerSuggestionMap;
        };
        setSpeakerLabels(labels);
        setSpeakerSuggestions(suggestions ?? {});
      }

      if (editsRes.ok) {
        const { edits } = (await editsRes.json()) as { edits: TranscriptEditMap };
        setTranscriptEdits(edits ?? {});
      }

      if (sharesRes.ok) {
        const { shares } = (await sharesRes.json()) as { shares: TranscriptShare[] };
        setCollaboratorEmails(
          new Set(shares.map((s) => s.shared_with_email.toLowerCase()))
        );
      }

      if (transcript.status === 'completed') {
        const contentRes = await fetch(`/api/transcripts/${transcriptId}/content`);
        if (contentRes.ok) {
          const { content } = (await contentRes.json()) as { content: TranscriptResponse };
          setContent(content);
        }
      }
    } catch (err) {
      if (!opts?.silent) {
        setError(err instanceof Error ? err.message : 'Failed to load transcript');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [transcriptId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Live updates: a collaborator changed THIS transcript — silently re-pull
  // everything. Skipped while the user is mid-edit (focused form field) so a
  // reload never stomps typing; debounced so event bursts coalesce.
  const liveReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLiveEvents((e) => {
    if (e.assemblyaiId !== transcriptId) return;
    if (liveReloadTimer.current) clearTimeout(liveReloadTimer.current);
    liveReloadTimer.current = setTimeout(() => {
      const el = document.activeElement as HTMLElement | null;
      const editing =
        !!el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (editing) return; // next event (or manual action) will catch up
      void loadAll({ silent: true });
      bumpActivity();
    }, 1000);
  });

  // Grab the current user's email once so the speaker-pick "add to access?"
  // prompt can suppress itself when the owner picks themselves from the
  // picker. Cheap fetch; fire-and-forget.
  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.email) setCurrentUserEmail(String(data.email).toLowerCase());
      })
      .catch(() => {});
  }, []);

  // While AI notes are generating server-side — or the speaker-ID pass is
  // running (its suggestions feed the review dialog) — poll the row and
  // refresh speaker suggestions.
  useEffect(() => {
    if (row?.auto_notes_status !== 'running' && row?.speaker_id_status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}`);
        if (!res.ok) return;
        const { transcript } = (await res.json()) as { transcript: StoredTranscript };
        setRow((prev) =>
          prev
            ? {
                ...prev,
                title: transcript.title,
                auto_notes: transcript.auto_notes,
                auto_notes_status: transcript.auto_notes_status,
                auto_notes_error: transcript.auto_notes_error,
                auto_notes_at: transcript.auto_notes_at,
                auto_segments: transcript.auto_segments,
                speaker_id_status: transcript.speaker_id_status,
                speaker_id_error: transcript.speaker_id_error,
                speaker_id_at: transcript.speaker_id_at,
              }
            : prev
        );
        // Pick up a server-generated title, but never while the user is
        // typing in the title field.
        if (transcript.title && !editingTitle) {
          setTitle((cur) => (cur.trim() ? cur : transcript.title!));
        }
        const spRes = await fetch(`/api/transcripts/${transcriptId}/speakers`);
        if (spRes.ok) {
          const { suggestions } = (await spRes.json()) as {
            suggestions?: SpeakerSuggestionMap;
          };
          setSpeakerSuggestions(suggestions ?? {});
        }
      } catch {
        // transient — keep polling
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [row?.auto_notes_status, row?.speaker_id_status, transcriptId, editingTitle]);

  // AI usage stats for the summary footer ("$0.31 · 52s"). Refetched when a
  // generation completes (auto_notes_at changes).
  useEffect(() => {
    if (!row?.auto_notes_at) return;
    let cancelled = false;
    fetch(`/api/transcripts/${transcriptId}/ai-runs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const completed = (data.runs as Array<Record<string, unknown>> | undefined)?.find(
          (r) => r.status === 'completed' && r.kind === 'auto_notes'
        );
        const completedReport = (data.runs as Array<Record<string, unknown>> | undefined)?.find(
          (r) => r.status === 'completed' && r.kind === 'auto_report'
        );
        setAiRuns((data.runs as Array<Record<string, unknown>> | undefined) ?? []);
        setAiStats({
          latestReport: completedReport
            ? {
                cost_usd: (completedReport.cost_usd as string | null) ?? null,
                duration_ms: (completedReport.duration_ms as number | null) ?? null,
                model: (completedReport.model as string | null) ?? null,
                triggered_by_email:
                  (completedReport.triggered_by_email as string | null) ?? null,
              }
            : null,
          latest: completed
            ? {
                cost_usd: (completed.cost_usd as string | null) ?? null,
                duration_ms: (completed.duration_ms as number | null) ?? null,
                input_tokens: (completed.input_tokens as string | null) ?? null,
                output_tokens: (completed.output_tokens as string | null) ?? null,
                cache_read_tokens: (completed.cache_read_tokens as string | null) ?? null,
                cache_creation_tokens:
                  (completed.cache_creation_tokens as string | null) ?? null,
                model: (completed.model as string | null) ?? null,
                triggered_by_email: (completed.triggered_by_email as string | null) ?? null,
              }
            : null,
          totals: data.totals ?? { runs: 0, cost_usd: null },
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transcriptId, row?.auto_notes_at, row?.auto_report_at]);

  // While AAI is still transcribing (fresh upload or a diarization re-run),
  // poll until the status settles, then do a full reload — no more manual
  // browser refreshes to see the finished transcript.
  useEffect(() => {
    const status = row?.status;
    if (status !== 'processing' && status !== 'queued') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}`);
        if (!res.ok) return;
        const { transcript } = (await res.json()) as { transcript: StoredTranscript };
        if (transcript.status !== status) {
          void loadAll();
        }
      } catch {
        // transient — keep polling
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [row?.status, transcriptId, loadAll]);

  const [guessingSpeakers, setGuessingSpeakers] = useState(false);
  const handleGuessSpeakers = useCallback(async () => {
    if (guessingSpeakers) return;
    setGuessingSpeakers(true);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/speakers/suggest`, {
        method: 'POST',
      });
      if (res.ok) {
        const { suggestions } = (await res.json()) as {
          suggestions: SpeakerSuggestionMap;
        };
        setSpeakerSuggestions(suggestions);
      }
    } finally {
      setGuessingSpeakers(false);
    }
  }, [transcriptId, guessingSpeakers]);

  const handleGenerateNotes = useCallback(async (instructions?: string) => {
    if (generatingNotes) return;
    setGeneratingNotes(true);
    try {
      const trimmed = instructions?.trim();
      const res = await fetch(`/api/transcripts/${transcriptId}/notes`, {
        method: 'POST',
        ...(trimmed
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instructions: trimmed }),
            }
          : {}),
      });
      if (res.ok) {
        setRow((prev) =>
          prev ? { ...prev, auto_notes_status: 'running', auto_notes_error: null } : prev
        );
        setStaleReasons({});
        bumpActivity();
      }
    } finally {
      setGeneratingNotes(false);
    }
  }, [transcriptId, generatingNotes, bumpActivity]);

  /** Rebuild the quick summary by resuming the detailed-report session —
   * the report run already verified frames/attachments, so the summary
   * inherits all of it for near-cache-read cost. */
  const handleTopUpSummary = useCallback(async () => {
    if (generatingNotes) return;
    setGeneratingNotes(true);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromReport: true }),
      });
      if (res.ok) {
        setRow((prev) =>
          prev ? { ...prev, auto_notes_status: 'running', auto_notes_error: null } : prev
        );
        setStaleReasons({});
        bumpActivity();
      }
    } finally {
      setGeneratingNotes(false);
    }
  }, [transcriptId, generatingNotes, bumpActivity]);

  // Unique speakers + line counts for the review dialog.
  const reviewSpeakers = useMemo(
    () =>
      content?.utterances
        ? Array.from(new Set(content.utterances.map((u) => u.speaker))).sort()
        : [],
    [content]
  );
  const reviewCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of content?.utterances ?? []) {
      counts[u.speaker] = (counts[u.speaker] ?? 0) + 1;
    }
    return counts;
  }, [content]);

  const handleGenerateReport = useCallback(async (instructions?: string, useVideo = true) => {
    if (generatingReport) return;
    setGeneratingReport(true);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
          useVideo,
        }),
      });
      if (res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { status?: string };
        if (payload.status === 'queued') {
          // Recording still being prepared — the server queued the run
          // (gmeet_context.pendingVideoReport); reload so the queued notice
          // shows.
          void loadAll({ silent: true });
        } else {
          setRow((prev) =>
            prev ? { ...prev, auto_report_status: 'running', auto_report_error: null } : prev
          );
          bumpActivity();
        }
        setStaleReasons({});
      }
    } finally {
      setGeneratingReport(false);
    }
  }, [transcriptId, generatingReport, bumpActivity, loadAll]);

  // --- Drive recording fetch (playback + frame-reading AI) ---
  // A Meet quick-import can know the recording's Drive file without having
  // the bytes. Pull them automatically once per visit — nobody should have
  // to click "fetch" for something we already know how to get.
  const recordingFileId =
    row?.gmeet_context?.videoFileId ??
    row?.gmeet_context?.actuals?.recordings?.[0]?.fileId ??
    null;
  // Teams rows fetch app-only from Graph — the stored recordingId is the
  // whole capability (route branches on provider).
  const teamsRecordingId =
    row?.gmeet_context?.provider === 'teams'
      ? (row.gmeet_context.teams?.recordingId ?? null)
      : null;
  const hasLocalVideo = /\.(mp4|webm|mov|mkv|m4v)$/i.test(row?.local_audio_path ?? '');
  const canFetchVideo =
    !!row && canEdit && !row.local_audio_path && (!!recordingFileId || !!teamsRecordingId);
  // The recording exists only as a promise — Google is still preparing the
  // file (no fileId to pull yet). A video report can be QUEUED in this state;
  // the recording poller fires it when the video lands.
  const videoPreparing =
    !!row &&
    canEdit &&
    !row.local_audio_path &&
    !recordingFileId &&
    !teamsRecordingId &&
    row.gmeet_context?.recordingPending?.status === 'waiting';
  const reportQueued = !!row?.gmeet_context?.pendingVideoReport;

  // --- Multi-video meetings (stop-restart recordings → several files) ---
  // The primary video ("Video 1") is local_audio_path; extra segments live in
  // gmeet_context.videoParts, playable via /audio?part=N. All transcript
  // times stay in MEETING time (AAI's t=0 = primary video start = anchorIso);
  // each part's wall-clock start gives its offset, so seeks and the playhead
  // highlight map across parts with plain arithmetic.
  const videoParts = useMemo(
    () => row?.gmeet_context?.videoParts ?? [],
    [row?.gmeet_context?.videoParts]
  );
  const partAnchorMs = useMemo(() => {
    const g = row?.gmeet_context;
    const iso =
      g?.actuals?.anchorIso ??
      g?.actuals?.recordings?.find((r) => r.fileId && r.fileId === g?.videoFileId)?.startTime ??
      g?.actuals?.recordings?.[0]?.startTime;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(ms) ? null : ms;
  }, [row?.gmeet_context]);
  const storedParts = useMemo(
    () =>
      videoParts
        .map((p, i) => {
          const startMs = p.startTime ? Date.parse(p.startTime) : NaN;
          const endMs = p.endTime ? Date.parse(p.endTime) : NaN;
          return {
            partNo: i + 2,
            filename: p.filename,
            offsetSec:
              partAnchorMs != null && !Number.isNaN(startMs)
                ? (startMs - partAnchorMs) / 1000
                : null,
            durationSec:
              !Number.isNaN(startMs) && !Number.isNaN(endMs) ? (endMs - startMs) / 1000 : null,
          };
        })
        .filter((p) => !!p.filename),
    [videoParts, partAnchorMs]
  );
  // Segments Google is still generating (recordingPending watches them) or
  // whose bytes we haven't pulled yet — surfaced so a second video is never
  // silently invisible.
  const partsGenerating =
    row?.gmeet_context?.recordingPending?.status === 'waiting'
      ? (row.gmeet_context.actuals?.recordings ?? []).filter((r) => !r.fileId).length
      : 0;
  const partsFetching = videoParts.filter((p) => !p.filename).length;
  const [activePart, setActivePart] = useState(1); // 1 = primary video
  const activePartInfo = activePart === 1 ? null : storedParts.find((p) => p.partNo === activePart);
  const activePartOffset = activePartInfo?.offsetSec ?? 0;
  const pendingPartSeekRef = useRef<{ t: number; play: boolean } | null>(null);
  /**
   * Seek to a MEETING-time position: picks the video segment containing it
   * (switching parts when needed — the seek applies after the new media's
   * metadata loads), then seeks the local position within that segment.
   */
  const seekMeetingTime = useCallback(
    (seconds: number, opts?: { play?: boolean }) => {
      let target = 1;
      let offset = 0;
      for (const p of storedParts) {
        if (p.offsetSec != null && seconds >= p.offsetSec && p.offsetSec > offset) {
          target = p.partNo;
          offset = p.offsetSec;
        }
      }
      const local = Math.max(0, seconds - offset);
      if (target !== activePart) {
        pendingPartSeekRef.current = { t: local, play: !!opts?.play };
        setActivePart(target);
        return;
      }
      if (opts?.play) playerRef.current?.seekToSeconds(local);
      else playerRef.current?.seekOnly(local);
    },
    [storedParts, activePart]
  );
  const [videoFetching, setVideoFetching] = useState(false);
  const [videoFetchError, setVideoFetchError] = useState<string | null>(null);
  const fetchVideo = useCallback(
    async (opts?: { auto?: boolean }) => {
      setVideoFetching(true);
      setVideoFetchError(null);
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/fetch-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          // Auto mode stays quiet when Google simply isn't connected — the
          // manual button remains for once it is.
          if (opts?.auto && res.status === 401) return;
          throw new Error(payload.error || `Failed (${res.status})`);
        }
        setAudioAvailable(true);
        void loadAll({ silent: true });
      } catch (err) {
        setVideoFetchError(err instanceof Error ? err.message : 'Video fetch failed');
      } finally {
        setVideoFetching(false);
      }
    },
    [transcriptId, loadAll]
  );
  const videoAutoFetchTried = useRef(false);
  useEffect(() => {
    if (!canFetchVideo || videoAutoFetchTried.current) return;
    videoAutoFetchTried.current = true;
    void fetchVideo({ auto: true });
  }, [canFetchVideo, fetchVideo]);

  // What runs after the speaker-review gate (Confirm OR Skip): honor what the
  // user picked at upload time (upload-media stepper) — a detailed report,
  // nothing ('later'), or the default quick summary.
  const runPostReviewGeneration = useCallback(async () => {
    const pref = row?.gmeet_context?.uploadPrefs?.report;
    if (pref === 'detailed-video' || pref === 'detailed-text') {
      selectSummaryTab('report');
      await handleGenerateReport(undefined, pref === 'detailed-video');
    } else if (pref !== 'later') {
      selectSummaryTab('summary');
      await handleGenerateNotes();
    }
  }, [row, selectSummaryTab, handleGenerateReport, handleGenerateNotes]);

  // Review-dialog confirm: batch-save the finalized names, then kick off the
  // first summary generation — the whole point of the interrupt is that the
  // summary is written with real names from the start.
  const handleReviewConfirm = useCallback(
    async (names: Record<string, string>) => {
      const next = [...speakerLabels];
      let changed = false;
      for (const [sp, raw] of Object.entries(names)) {
        const name = raw.trim();
        const i = next.findIndex((l) => l.originalSpeaker === sp);
        if ((i >= 0 ? next[i]!.customName.trim() : '') === name) continue;
        changed = true;
        if (i >= 0) next[i] = { ...next[i]!, customName: name };
        else next.push({ originalSpeaker: sp, customName: name, description: '' });
      }
      if (changed) {
        setSpeakerLabels(next);
        try {
          const res = await fetch(`/api/transcripts/${transcriptId}/speakers`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speakerLabels: next }),
          });
          if (!res.ok) throw new Error(`PUT speakers failed (${res.status})`);
          const { speakerLabels: saved } = (await res.json()) as {
            speakerLabels: SpeakerLabel[];
          };
          setSpeakerLabels(saved);
          bumpActivity();
        } catch (err) {
          console.error('Failed to save speakers:', err);
          alert('Failed to save speaker names. Reloading from server.');
          loadAll();
          return;
        }
      }
      setReviewOpen(false);
      await runPostReviewGeneration();
    },
    [speakerLabels, transcriptId, bumpActivity, loadAll, runPostReviewGeneration]
  );

  // Safety net for the report status: live events normally push the refresh,
  // but poll while running in case the SSE stream is down.
  useEffect(() => {
    if (row?.auto_report_status !== 'running') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}`);
        if (!res.ok) return;
        const { transcript } = (await res.json()) as { transcript: StoredTranscript };
        if (transcript.auto_report_status !== 'running') {
          void loadAll();
        }
      } catch {
        // transient — keep polling
      }
    }, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.auto_report_status, transcriptId]);

  // ⌘F / Ctrl+F → toggle find-and-replace panel
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        // Only intercept when no input is focused, so the browser's native
        // ⌘F still works in form fields.
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        setFindReplaceOpen((v) => !v);
      } else if (e.key === 'Escape' && findReplaceOpen) {
        setFindReplaceOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findReplaceOpen]);

  // --- click handlers ---

  const handleSeekToUtterance = useCallback(
    (idx: number) => {
      const u = content?.utterances?.[idx];
      if (!u) return;
      // Seek without touching play/pause: if audio was paused it stays
      // paused; if it was playing it keeps playing from the new position.
      seekMeetingTime(u.start / 1000);
    },
    [content?.utterances, seekMeetingTime]
  );

  /**
   * Jump from the outline rail: seek the audio player and scroll to the
   * utterance whose interval contains the target seconds. Falls back to
   * the transcript card header if the target is past the last utterance
   * or the content hasn't loaded yet. Offsets for the sticky audio strip.
   */
  const handleOutlineJump = useCallback(
    (seconds: number) => {
      // seekOnly so playback state isn't toggled — paused stays paused,
      // playing keeps playing from the new position.
      seekMeetingTime(seconds);

      const ms = seconds * 1000;
      const utterances = content?.utterances;
      let targetIdx = -1;
      if (utterances) {
        for (let i = 0; i < utterances.length; i++) {
          if (utterances[i]!.start > ms) break;
          targetIdx = i;
        }
      }

      const el =
        targetIdx >= 0
          ? document.querySelector<HTMLElement>(
              `[data-utterance-index="${targetIdx}"]`
            )
          : document.getElementById('transcript');
      if (!el) return;

      // Account for the sticky audio player so the target lands below it
      // rather than getting hidden underneath.
      const rect = el.getBoundingClientRect();
      const top = window.scrollY + rect.top - 132;
      window.scrollTo({ top, behavior: 'smooth' });
    },
    [content?.utterances, seekMeetingTime]
  );

  // Headings extracted from the description markdown — fed into the right-rail
  // outline so users can jump straight to a sub-section of their notes.
  const notesHeadings = useMemo(() => extractHeadings(description), [description]);

  // Scroll-spy: highlight the active section in the outline rail as the
  // user scrolls. Active = the last anchored element whose top has
  // crossed the viewport offset (accounts for the sticky audio player).
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  // Scroll-derived "looking at" time used by the outline's transcript chunk
  // markers. Updated as the user scrolls through the transcript itself
  // (independent of audio playback so the outline reflects where you're
  // *reading*, not where the playhead happens to be).
  const [scrollDerivedTimeSec, setScrollDerivedTimeSec] = useState<number | null>(null);
  useEffect(() => {
    const ids: string[] = [];
    if (description || canEdit) ids.push('notes');
    for (const h of notesHeadings) ids.push(h.slug);
    if (
      viewMode === 'edited' &&
      !!content?.utterances &&
      content.utterances.length > 0
    ) {
      ids.push('speakers');
    }
    ids.push('transcript');
    if (ids.length === 0) return;

    let raf = 0;
    const compute = () => {
      raf = 0;
      // 132px = approx height of the sticky audio player + breathing room.
      // The "active" anchor is the last one whose top has scrolled past
      // that line. Iterate in DOM order and capture the last match.
      const line = 132;
      let bestId: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top - line <= 0) bestId = id;
        else break;
      }
      setActiveAnchor(bestId);
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(compute);
    };

    // Run once after layout settles so the initial state is correct.
    raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [
    notesHeadings,
    description,
    canEdit,
    viewMode,
    content?.utterances?.length,
  ]);

  // Track the topmost utterance currently scrolled past the sticky-audio
  // line so the outline's time chunks reflect *reading* position, not just
  // playback. Re-runs whenever the transcript's utterance count changes.
  useEffect(() => {
    const utterances = content?.utterances;
    if (!utterances || utterances.length === 0) {
      setScrollDerivedTimeSec(null);
      return;
    }

    let raf = 0;
    const compute = () => {
      raf = 0;
      const line = 150;
      const els = document.querySelectorAll<HTMLElement>('[data-utterance-index]');
      let bestStart = -1;
      for (const el of els) {
        const top = el.getBoundingClientRect().top;
        if (top - line <= 0) {
          const idx = parseInt(el.dataset.utteranceIndex ?? '-1', 10);
          const u = utterances[idx];
          if (u) bestStart = u.start;
        } else {
          break;
        }
      }
      setScrollDerivedTimeSec(bestStart >= 0 ? bestStart / 1000 : null);
    };

    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(compute);
    };

    raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [content?.utterances?.length]);

  /**
   * Effective time for the outline's chunk highlighting. Prefer the
   * scroll-derived time (where the user is *reading*) and fall back to the
   * audio playhead only when the user has actually started playback —
   * otherwise the chunk marker would always pin to "0:00" while reading
   * Notes/Speakers above the transcript, which is misleading.
   */
  const outlineTimeSec: number | null =
    scrollDerivedTimeSec != null
      ? scrollDerivedTimeSec
      : currentTime > 0.5
        ? currentTime
        : null;


  // Collapsed state for the section cards. Persist per-transcript in
  // localStorage so a user's preferred layout sticks across refreshes.
  // Versioned so we can reset everyone's defaults when the rule changes
  // (currently: all three sections open by default).
  const collapsedKey = `mw:collapsed:v2:${transcriptId}`;
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(collapsedKey);
      if (raw) setCollapsedSections(JSON.parse(raw));
    } catch {
      // ignore — corrupt localStorage shouldn't break the page
    }
  }, [collapsedKey]);
  const toggleSection = useCallback(
    (key: 'notes' | 'speakers' | 'transcript' | 'aiSummary') => {
      setCollapsedSections((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        try {
          window.localStorage.setItem(collapsedKey, JSON.stringify(next));
        } catch {
          /* ignore quota errors */
        }
        return next;
      });
    },
    [collapsedKey]
  );

  // Mobile-only: floating outline drawer. Download popover state is shared
  // between the rail and the mobile drawer (only one is interactive at a
  // time — the ref re-attaches to whichever instance rendered last).
  const [outlineOpenMobile, setOutlineOpenMobile] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!downloadMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (!downloadMenuRef.current) return;
      if (!downloadMenuRef.current.contains(e.target as Node)) {
        setDownloadMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [downloadMenuOpen]);

  // Toolbar ⋯ overflow popover (Refresh / downloads / copy-ID).
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overflowMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (!overflowMenuRef.current) return;
      if (!overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [overflowMenuOpen]);
  const [idCopied, setIdCopied] = useState(false);

  const handleSaveText = useCallback(
    async (index: number, newText: string) => {
      const raw = content?.utterances?.[index]?.text ?? '';
      // Optimistic local update
      setTranscriptEdits((prev) => {
        const next = { ...prev };
        const key = String(index);
        if (newText === raw) {
          // Edit reverts to raw → drop the override entirely
          if (next[key]) {
            const { text: _omit, ...rest } = next[key]!;
            if (rest.speaker !== undefined) next[key] = rest;
            else delete next[key];
          }
        } else {
          next[key] = { ...(next[key] ?? {}), text: newText };
        }
        return next;
      });

      try {
        // If reverting to raw, we still send a PATCH so the server-side override
        // is cleared. PATCH supports text='' as a valid edit, so to express
        // "remove the override" we instead send the new text — even if it equals
        // raw — and rely on patchUtteranceForUser to keep them in sync. The map
        // we read back next time will reflect whatever the server has.
        const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utteranceIndex: index, text: newText }),
        });
        if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
        const { edits } = (await res.json()) as { edits: TranscriptEditMap };
        setTranscriptEdits(edits ?? {});
        bumpActivity();
      } catch (err) {
        console.error('Failed to save utterance edit:', err);
        alert('Failed to save edit. Reloading from server.');
        loadAll();
      }
    },
    [content?.utterances, transcriptId, loadAll, bumpActivity]
  );

  /**
   * Save a partial update for one speaker (name and/or description). Merges
   * with the existing entry, optimistically updates local state, and PUTs the
   * full label set.
   */
  const handleSaveSpeaker = useCallback(
    async (
      originalSpeaker: string,
      patch: { customName?: string; description?: string }
    ) => {
      const existing = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
      const merged: SpeakerLabel = {
        originalSpeaker,
        customName: patch.customName ?? existing?.customName ?? '',
        description: patch.description ?? existing?.description ?? '',
      };
      const without = speakerLabels.filter((m) => m.originalSpeaker !== originalSpeaker);
      const next = [...without, merged];

      // Optimistic local update
      setSpeakerLabels(next);

      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/speakers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerLabels: next }),
        });
        if (!res.ok) throw new Error(`PUT speakers failed (${res.status})`);
        const { speakerLabels: saved } = (await res.json()) as { speakerLabels: SpeakerLabel[] };
        setSpeakerLabels(saved);
        bumpActivity();
        // The AI output was written with the old speaker names — offer a
        // one-click rerun instead of silently going stale.
        if (row?.auto_notes || row?.auto_report) markAiStale('speakers', 'speaker names');
      } catch (err) {
        console.error('Failed to save speaker:', err);
        alert('Failed to save speaker. Reloading from server.');
        loadAll();
      }
    },
    [speakerLabels, transcriptId, loadAll, bumpActivity, row?.auto_notes, row?.auto_report, markAiStale]
  );

  // --- find & replace: matches list, derived live from query + content + edits ---

  interface FindMatch {
    utteranceIndex: number;
    start: number;
    end: number;
  }

  const findMatches = useMemo<FindMatch[]>(() => {
    if (!findQuery || !content?.utterances || viewMode === 'raw') return [];
    const out: FindMatch[] = [];
    const needleLen = findQuery.length;
    if (needleLen === 0) return out;
    const cmpQuery = findCaseSensitive ? findQuery : findQuery.toLowerCase();

    for (let i = 0; i < content.utterances.length; i++) {
      const raw = content.utterances[i]!.text;
      const text = transcriptEdits[String(i)]?.text ?? raw;
      const haystack = findCaseSensitive ? text : text.toLowerCase();
      let from = 0;
      while (from <= haystack.length - needleLen) {
        const idx = haystack.indexOf(cmpQuery, from);
        if (idx === -1) break;
        out.push({ utteranceIndex: i, start: idx, end: idx + needleLen });
        from = idx + needleLen;
      }
    }
    return out;
  }, [findQuery, findCaseSensitive, content?.utterances, transcriptEdits, viewMode]);

  // Whenever the matches list shrinks past the cursor, clamp.
  useEffect(() => {
    if (currentMatchPos >= findMatches.length) {
      setCurrentMatchPos(0);
    }
  }, [findMatches.length, currentMatchPos]);

  // Scroll the focused match into view when it changes.
  useEffect(() => {
    if (findMatches.length === 0) return;
    const m = findMatches[currentMatchPos];
    if (!m) return;
    const el = document.querySelector<HTMLElement>(
      `[data-utterance-index="${m.utteranceIndex}"]`
    );
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [findMatches, currentMatchPos]);

  /** Build per-utterance highlight ranges for the EditableUtterance components. */
  const highlightsByUtterance = useMemo<Map<number, UtteranceHighlight[]>>(() => {
    const map = new Map<number, UtteranceHighlight[]>();
    findMatches.forEach((m, idx) => {
      const arr = map.get(m.utteranceIndex) ?? [];
      arr.push({
        start: m.start,
        end: m.end,
        isCurrent: idx === currentMatchPos,
      });
      map.set(m.utteranceIndex, arr);
    });
    return map;
  }, [findMatches, currentMatchPos]);

  const handleFindNext = useCallback(() => {
    if (findMatches.length === 0) return;
    setCurrentMatchPos((p) => (p + 1) % findMatches.length);
  }, [findMatches.length]);

  const handleFindPrev = useCallback(() => {
    if (findMatches.length === 0) return;
    setCurrentMatchPos((p) => (p - 1 + findMatches.length) % findMatches.length);
  }, [findMatches.length]);

  /**
   * Replace the *current* focused match. After saving, the matches list
   * is recomputed and the cursor stays put — which usually puts you on the
   * next match because the current one is gone.
   */
  const handleReplaceCurrent = useCallback(async () => {
    if (findMatches.length === 0 || !content?.utterances) return;
    const m = findMatches[currentMatchPos];
    if (!m) return;
    const i = m.utteranceIndex;
    const raw = content.utterances[i]!.text;
    const currentText = transcriptEdits[String(i)]?.text ?? raw;
    const newText =
      currentText.substring(0, m.start) + replaceWith + currentText.substring(m.end);

    const nextEdits: TranscriptEditMap = { ...transcriptEdits };
    const key = String(i);
    if (newText === raw) {
      if (nextEdits[key]) {
        const { text: _omit, ...rest } = nextEdits[key]!;
        if (rest.speaker !== undefined) nextEdits[key] = rest;
        else delete nextEdits[key];
      }
    } else {
      nextEdits[key] = { ...(nextEdits[key] ?? {}), text: newText };
    }
    setTranscriptEdits(nextEdits);

    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ utteranceIndex: i, text: newText }),
      });
      if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
      const { edits } = (await res.json()) as { edits: TranscriptEditMap };
      setTranscriptEdits(edits ?? {});
      bumpActivity();
    } catch (err) {
      console.error('Failed to replace current:', err);
      alert('Failed to save replacement. Reloading from server.');
      loadAll();
    }
  }, [
    findMatches,
    currentMatchPos,
    content?.utterances,
    transcriptEdits,
    replaceWith,
    transcriptId,
    loadAll,
    bumpActivity,
  ]);

  /**
   * Replace every match in one shot. Computes the new edit map locally and
   * PUTs it in a single request. Builds replacements right-to-left within
   * each utterance so positions stay valid.
   */
  const handleReplaceAll = useCallback(async () => {
    if (findMatches.length === 0 || !content?.utterances) return;

    const nextEdits: TranscriptEditMap = { ...transcriptEdits };
    const groupedByUtterance = new Map<number, FindMatch[]>();
    for (const m of findMatches) {
      const arr = groupedByUtterance.get(m.utteranceIndex) ?? [];
      arr.push(m);
      groupedByUtterance.set(m.utteranceIndex, arr);
    }

    for (const [i, matches] of groupedByUtterance) {
      const raw = content.utterances[i]!.text;
      let text = transcriptEdits[String(i)]?.text ?? raw;
      // Right-to-left so each splice doesn't shift later positions.
      const sorted = [...matches].sort((a, b) => b.start - a.start);
      for (const m of sorted) {
        text = text.substring(0, m.start) + replaceWith + text.substring(m.end);
      }
      const key = String(i);
      if (text === raw) {
        if (nextEdits[key]) {
          const { text: _omit, ...rest } = nextEdits[key]!;
          if (rest.speaker !== undefined) nextEdits[key] = rest;
          else delete nextEdits[key];
        }
      } else {
        nextEdits[key] = { ...(nextEdits[key] ?? {}), text };
      }
    }

    setTranscriptEdits(nextEdits);

    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/edits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: nextEdits }),
      });
      if (!res.ok) throw new Error(`PUT failed (${res.status})`);
      const { edits } = (await res.json()) as { edits: TranscriptEditMap };
      setTranscriptEdits(edits ?? {});
      bumpActivity();
    } catch (err) {
      console.error('Failed to replace all:', err);
      alert('Failed to save replacements. Reloading from server.');
      loadAll();
    }
  }, [findMatches, content?.utterances, transcriptEdits, replaceWith, transcriptId, loadAll, bumpActivity]);

  // --- speaker-pick → add-to-access prompt (shared by summary panel + badge editor) ---

  const handlePickPerson = useCallback(
    (person: PickerPerson) => {
      if (!canEdit) return;
      if (!person.email) return;
      const picked = person.email.toLowerCase();
      // Don't prompt for yourself — you already have access.
      if (currentUserEmail && picked === currentUserEmail) return;
      // Don't prompt for people who are already collaborators.
      if (collaboratorEmails.has(picked)) return;
      // Only prompt for Trames-domain people; external speakers (customers,
      // partners) get tagged without the share nudge.
      const domain = picked.split('@')[1] ?? '';
      if (!TRAMES_DOMAINS.includes(domain)) return;
      setPendingShare(person);
      setSharingError(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, collaboratorEmails, currentUserEmail]
  );

  const handleRequestCreatePerson = useCallback(
    (originalSpeaker: string, name: string) => {
      setPendingCreate({ originalSpeaker, name });
    },
    []
  );

  // Only nudge to grant transcript access for people on Trames domains.
  // External speakers (customers, partners) get tagged without the prompt.
  const TRAMES_DOMAINS = ['trames.sg', 'trames-engineering.com'];

  const handlePersonCreated = useCallback(
    (person: PickerPerson) => {
      if (!pendingCreate) return;
      const original = pendingCreate.originalSpeaker;
      setPendingCreate(null);
      handleSaveSpeaker(original, { customName: person.name });
      handlePickPerson(person);
    },
    // handleSaveSpeaker and handlePickPerson are declared later — ref via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingCreate]
  );

  const handleUsePersonAsLabel = useCallback(
    (name: string) => {
      if (!pendingCreate) return;
      const original = pendingCreate.originalSpeaker;
      setPendingCreate(null);
      handleSaveSpeaker(original, { customName: name });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingCreate]
  );

  const handleConfirmPendingShare = async () => {
    if (!pendingShare || !pendingShare.email) return;
    try {
      setSharingPending(true);
      setSharingError(null);
      const res = await fetch(`/api/transcripts/${transcriptId}/shares`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: pendingShare.email,
          name: pendingShare.name,
          pplId: pendingShare.id,
          access: 'edit',
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Failed (${res.status})`);
      }
      setCollaboratorEmails((prev) => {
        const next = new Set(prev);
        next.add(pendingShare.email!.toLowerCase());
        return next;
      });
      setPendingShare(null);
      bumpActivity();
    } catch (err) {
      setSharingError(err instanceof Error ? err.message : 'Failed to share');
    } finally {
      setSharingPending(false);
    }
  };

  // --- meta save: separate persisters for title vs description so each can
  // be edited inline without touching the other.

  const persistMeta = useCallback(
    async (patch: { title?: string; description?: string }) => {
      try {
        setSavingMeta(true);
        const res = await fetch(`/api/transcripts/${transcriptId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error(`PATCH failed (${res.status})`);
        const { transcript } = (await res.json()) as { transcript: StoredTranscript };
        setRow(transcript);
        bumpActivity();
      } catch (err) {
        console.error('Error saving metadata:', err);
        alert('Failed to save. Please try again.');
      } finally {
        setSavingMeta(false);
      }
    },
    [transcriptId, bumpActivity]
  );

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = title.trim();
    if (trimmed === (row?.title ?? '')) return;
    void persistMeta({ title: trimmed });
  };

  const cancelTitle = () => {
    setTitle(row?.title || '');
    setEditingTitle(false);
  };

  const commitDescription = () => {
    setEditingDescription(false);
    const trimmed = description.trim();
    if (trimmed === (row?.description ?? '')) return;
    void persistMeta({ description: trimmed });
  };

  const cancelDescription = () => {
    setDescription(row?.description || '');
    setEditingDescription(false);
  };

  // Sync the browser tab title to the transcript title so multi-tab work
  // is navigable. Reset on unmount so other pages don't inherit the title.
  useEffect(() => {
    const computed =
      (row?.title?.trim()) || row?.original_filename || 'Untitled transcript';
    document.title = `${computed} · Darth Meetings`;
    return () => {
      document.title = 'Darth Meetings';
    };
  }, [row?.title, row?.original_filename]);

  // --- formatters / markdown ---

  const safeFormatDate = (value: string | null): string => {
    if (!value) return 'Unknown date';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown date';
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return 'Unknown date';
    }
  };

  const formatFullDate = (value: string | null): string => {
    if (!value) return 'Unknown date';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown date';
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown date';
    }
  };

  /** Header meta date: "Jul 30, 2026 · 9:41 AM". */
  const formatHeaderDate = (value: string | null): string => {
    if (!value) return 'Unknown date';
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown date';
      return `${date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })} · ${date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })}`;
    } catch {
      return 'Unknown date';
    }
  };

  /**
   * Generate markdown from the transcript. `mode` controls whether we use raw
   * AAI content as-is or the composed edited view (text edits + speaker
   * mappings).
   */
  const generateMarkdown = (mode: ViewMode): string => {
    if (!row) return '';
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0]?.substring(0, 5) || '00:00';

    let markdown = `# ${title || 'Meeting Transcript'}\n\n`;
    if (description) markdown += `${description}\n\n`;
    markdown += `*Transcript ID: ${row.assemblyai_id}*\n`;
    markdown += `*Duration: ${row.duration ? formatDuration(row.duration) : 'N/A'}*\n`;
    markdown += `*Created: ${formatFullDate(row.created_at)}*\n`;
    markdown += `*Downloaded: ${dateStr} at ${timeStr} (${mode})*\n\n`;

    if (content?.utterances && content.utterances.length > 0) {
      const resolveSpeaker = (raw: string): string => {
        if (mode === 'raw') return defaultSpeakerLabel(raw);
        const m = speakerLabels.find((s) => s.originalSpeaker === raw);
        return m?.customName || defaultSpeakerLabel(raw);
      };
      const resolveDescription = (raw: string): string => {
        if (mode === 'raw') return '';
        const m = speakerLabels.find((s) => s.originalSpeaker === raw);
        return m?.description || '';
      };
      const resolveText = (idx: number, raw: string): string => {
        if (mode === 'raw') return raw;
        return transcriptEdits[String(idx)]?.text ?? raw;
      };

      markdown += `## Speakers\n`;
      const speakers = Array.from(new Set(content.utterances.map((u) => u.speaker))).sort();
      speakers.forEach((speaker) => {
        const displayName = resolveSpeaker(speaker);
        const defaultName = defaultSpeakerLabel(speaker);
        const namePart = displayName !== defaultName ? `**${displayName}** (${defaultName})` : `**${defaultName}**`;
        const description = resolveDescription(speaker);
        const descPart = description ? ` — ${description}` : '';
        markdown += `- ${namePart}${descPart}\n`;
      });

      markdown += `\n## Transcript\n\n`;
      content.utterances.forEach((utterance, idx) => {
        const ts = formatTime(utterance.start);
        const speakerName = resolveSpeaker(utterance.speaker);
        const text = resolveText(idx, utterance.text);
        markdown += `[${ts}] **${speakerName}**: ${text}\n\n`;
      });
    } else if (content?.text) {
      markdown += `## Transcript\n\n${content.text}\n\n`;
    }

    return markdown;
  };

  const downloadMarkdown = (mode: ViewMode) => {
    if (!row) return;
    const markdown = generateMarkdown(mode);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${row.assemblyai_id}-${mode}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Copy the edited markdown to the clipboard. Falls back to a hidden
   * textarea + execCommand('copy') path if the Async Clipboard API is
   * unavailable (e.g. served over plain HTTP or in older browsers).
   */
  const copyMarkdown = async () => {
    if (!row) return;
    const markdown = generateMarkdown('edited');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      } else {
        const ta = document.createElement('textarea');
        ta.value = markdown;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-10000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 1500);
    } catch (err) {
      console.error('copy failed', err);
      alert('Could not copy to clipboard');
    }
  };

  // Deep links back to the Google-side sources of this row: the Meet room,
  // the calendar event, the Drive recording, and the Meet transcript Doc.
  // Must stay ABOVE the early returns: a hook below them runs on some renders
  // and not others, which is React error #310 (the blank-detail-page bug).
  const sourceLinks = useMemo(() => {
    const g = row?.gmeet_context;
    const links: Array<{ href: string; label: string; title: string; icon: React.ReactNode }> = [];
    if (!row) return links;
    if (g?.meetingCode) {
      links.push({
        href: `https://meet.google.com/${g.meetingCode}`,
        label: `meet.google.com/${g.meetingCode}`,
        title: 'Open the Meet room',
        icon: <Video className="h-4 w-4 shrink-0 text-muted-foreground" />,
      });
    }
    if (g?.eventId && currentUserEmail) {
      // Google Calendar deep link: eid = base64url("<eventId> <email>").
      try {
        const eid = btoa(`${g.eventId} ${currentUserEmail}`).replace(/=+$/, '');
        links.push({
          href: `https://calendar.google.com/calendar/event?eid=${eid}`,
          label: g.eventTitle || 'Calendar event',
          title: 'Open the calendar event',
          icon: <CalendarSearch className="h-4 w-4 shrink-0 text-muted-foreground" />,
        });
      } catch {
        // non-ASCII event id — skip the link
      }
    }
    const videoId =
      row.drive_file_id ?? g?.videoFileId ?? g?.actuals?.recordings?.[0]?.fileId ?? null;
    if (videoId) {
      links.push({
        href: `https://drive.google.com/file/d/${videoId}/view`,
        label: 'Recording on Drive',
        title: 'Open the original recording in Google Drive',
        icon: <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />,
      });
    }
    const docId = g?.transcriptDocId ?? g?.actuals?.transcriptDocIds?.[0] ?? null;
    if (docId) {
      links.push({
        href: `https://docs.google.com/document/d/${docId}/edit`,
        label: 'Meet transcript Doc',
        title: 'Open the Google Meet transcript document',
        icon: <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />,
      });
    }
    return links;
  }, [row, currentUserEmail]);

  // --- early returns ---

  if (loading) {
    return (
      <div>
        <AppHeader />
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          <Card>
            <CardHeader>
              <CardTitle>Loading Transcript...</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <AppHeader />
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          <Card>
            <CardHeader>
              <CardTitle>Error Loading Transcript</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-destructive mb-4">{error}</p>
              <div className="flex gap-2">
                <Button onClick={() => void loadAll()} variant="outline">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry
                </Button>
                <Button onClick={() => router.push('/')} variant="outline">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to List
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!row) {
    return (
      <div>
        <AppHeader />
        <div className="mx-auto max-w-[1200px] px-6 py-6">
          <Card>
            <CardHeader>
              <CardTitle>Transcript Not Found</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground mb-4">
                The transcript you&apos;re looking for doesn&apos;t exist or couldn&apos;t be loaded.
              </p>
              <Button onClick={() => router.push('/')} variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to List
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const headerTitle = title.trim() || row.original_filename || 'Untitled transcript';
  const notesGenerating = generatingNotes || row.auto_notes_status === 'running';

  /** Soft delete: the row moves to the Trash tab (restorable) — nothing is
   * destroyed. Owner-only; navigates back to the (now row-less) list. */
  const handleMoveToTrash = async () => {
    try {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text().catch(() => `Delete failed (${res.status})`));
      router.push('/');
    } catch (err) {
      alert('Failed to move to trash: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleRestore = async () => {
    try {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/restore`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `Restore failed (${res.status})`));
      await loadAll({ silent: true });
    } catch (err) {
      alert('Failed to restore: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleTrashDelete = async () => {
    if (!confirm('Delete forever? This cannot be undone.')) return;
    try {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}?permanent=1`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text().catch(() => `Delete failed (${res.status})`));
      router.push('/');
    } catch (err) {
      alert('Failed to delete: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  /**
   * Quick-actions stack. Rendered in the desktop rail AND inside the mobile
   * outline drawer — always via this function so each spot gets fresh
   * elements (the download popover's outside-click ref re-attaches to the
   * instance rendered last).
   */
  // (dropdown now always opens below the button, so the dialog/sidebar
  // distinction no longer matters — param kept for call-site stability)
  const renderQuickActions = (_inDialog = false) => (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Quick actions
      </div>
      <div className="mt-2 space-y-0.5">
        {canEdit && staleLabels.length > 0 && (row.auto_notes || row.auto_report) && (
          <Button
            variant="ghost"
            size="sm"
            className="ai-glimmer h-8 w-full justify-start gap-2 text-[13px] font-medium text-primary hover:text-primary"
            disabled={notesGenerating || generatingReport}
            onClick={() => openGenerateDialog(false)}
            title={`Changed since the last AI run: ${staleLabels.join(', ')}. One click re-runs with the new context — the AI may well decide nothing needs updating.`}
          >
            <Sparkles className="h-4 w-4" />
            Tell the AI what changed
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-[13px]"
            disabled={notesGenerating || row.status !== 'completed'}
            onClick={() => openGenerateDialog(false)}
          >
            {notesGenerating ? (
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Sparkles className="h-4 w-4 text-primary" />
            )}
            Summary / report…
          </Button>
        )}
        {canEdit && (content?.utterances?.length ?? 0) > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-[13px]"
            disabled={guessingSpeakers}
            onClick={handleGuessSpeakers}
            title="Match each voice against known people (local voiceprints — no AI call)"
          >
            {guessingSpeakers ? (
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Users className="h-4 w-4 text-muted-foreground" />
            )}
            {guessingSpeakers ? 'Listening…' : 'Guess speaker names'}
          </Button>
        )}
        <RerunDiarizationButton
          assemblyaiId={row.assemblyai_id}
          gmeetContext={row.gmeet_context}
          hasLocalAudio={!!row.local_audio_path}
          size="sm"
          variant="ghost"
          className="h-8 w-full justify-start gap-2 text-[13px]"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 text-[13px]"
          disabled={!content}
          onClick={copyMarkdown}
          title="Copy edited markdown to clipboard"
        >
          <Copy className="h-4 w-4 text-muted-foreground" />
          {copyStatus === 'copied' ? 'Copied' : 'Copy markdown'}
        </Button>
        <div
          className="relative"
          ref={(el) => {
            downloadMenuRef.current = el;
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-[13px]"
            disabled={!content}
            onClick={() => setDownloadMenuOpen((v) => !v)}
            title="Download as markdown"
          >
            <Download className="h-4 w-4 text-muted-foreground" />
            Download
            <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" />
          </Button>
          {downloadMenuOpen && (
            <div
              className="absolute right-0 top-full z-50 mt-1 min-w-[150px] rounded-md border bg-popover p-1 shadow-md"
            >
              <button
                type="button"
                onClick={() => {
                  downloadMarkdown('edited');
                  setDownloadMenuOpen(false);
                }}
                className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                Edited markdown
              </button>
              <button
                type="button"
                onClick={() => {
                  downloadMarkdown('raw');
                  setDownloadMenuOpen(false);
                }}
                className="block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                Raw markdown
              </button>
            </div>
          )}
        </div>
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-[13px]"
            disabled={!content}
            onClick={() => setFindReplaceOpen((v) => !v)}
            title="Find and replace (⌘F)"
          >
            <Search className="h-4 w-4 text-muted-foreground" />
            Find &amp; replace
            <kbd className="ml-auto rounded border bg-muted px-1 py-0.5 font-mono text-[10px] font-normal text-muted-foreground">
              ⌘F
            </kbd>
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 text-[13px]"
            onClick={() => setLinkEventOpen(true)}
            title="Attach the calendar invite this meeting came from — fills the date, title, and attendees"
          >
            <CalendarSearch className="h-4 w-4 text-muted-foreground" />
            {row.gmeet_context?.eventId ? 'Re-link calendar event' : 'Link calendar event'}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-full justify-start gap-2 text-[13px]"
          onClick={() => setShareOpen(true)}
          title="Share access with other people"
        >
          <Users className="h-4 w-4 text-muted-foreground" />
          Share
          {shareSuggestionCount > 0 && (
            <span
              className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground"
              title={`${shareSuggestionCount} people from this meeting aren't shared yet`}
            >
              {shareSuggestionCount}
            </span>
          )}
        </Button>
        {sourceLinks.length > 0 && (
          <>
            <div className="my-1.5 border-t" />
            <p className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Source links
            </p>
            {sourceLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                className="flex h-8 w-full items-center gap-2 rounded-md px-3 text-[13px] hover:bg-muted"
                title={l.title}
              >
                {l.icon}
                <span className="min-w-0 flex-1 truncate">{l.label}</span>
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
              </a>
            ))}
          </>
        )}
        {access === 'owner' && !row.deleted_at && (
          <>
            <div className="my-1.5 border-t" />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start gap-2 text-[13px] text-muted-foreground hover:text-destructive"
              onClick={() => void handleMoveToTrash()}
              title="Move to trash — restorable from the Trash tab on the listing page"
            >
              <Trash2 className="h-4 w-4" />
              Move to trash
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <AppHeader breadcrumb={{ title: headerTitle }}>
        {access !== 'owner' && (
          <Badge variant="outline" className="text-[10px]">
            <span className="md:hidden">Shared</span>
            <span className="hidden md:inline">
              Shared — {access === 'edit' ? 'Editor' : 'Read-only'}
            </span>
          </Badge>
        )}
        {/* Raw / Edited toggle */}
        <div className="inline-flex rounded-md bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setViewMode('raw')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              viewMode === 'raw'
                ? 'bg-card font-medium shadow-[0_1px_2px_0_rgb(0_0_0/0.06)]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Show original AAI output"
          >
            <Eye className="h-3 w-3" />
            <span className="hidden sm:inline">Raw</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('edited')}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              viewMode === 'edited'
                ? 'bg-card font-medium shadow-[0_1px_2px_0_rgb(0_0_0/0.06)]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Show edited view"
          >
            <Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">Edited</span>
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => setShareOpen(true)}
          title={
            shareSuggestionCount > 0
              ? `Share — ${shareSuggestionCount} people from this meeting aren't shared yet`
              : 'Share access with other people'
          }
          className="relative"
        >
          <Users className="h-4 w-4" />
          <span className="hidden md:inline">Share</span>
          {shareSuggestionCount > 0 && (
            <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-status-busy" />
          )}
        </Button>
        {/* ⋯ overflow: refresh, downloads, transcript ID */}
        <div className="relative" ref={overflowMenuRef}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOverflowMenuOpen((v) => !v)}
            title="More actions"
            aria-label="More actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
          {overflowMenuOpen && (
            <div
              className={`absolute right-0 top-full z-50 mt-1 min-w-[220px] rounded-md border bg-popover p-1 ${FLOATING_SHADOW}`}
            >
              <button
                type="button"
                onClick={() => {
                  loadAll();
                  setOverflowMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                Refresh
              </button>
              <button
                type="button"
                disabled={!content}
                onClick={() => {
                  downloadMarkdown('edited');
                  setOverflowMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5 text-muted-foreground" />
                Download edited markdown
              </button>
              <button
                type="button"
                disabled={!content}
                onClick={() => {
                  downloadMarkdown('raw');
                  setOverflowMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5 text-muted-foreground" />
                Download raw markdown
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(row.assemblyai_id);
                  } catch {
                    /* ignore */
                  }
                  setIdCopied(true);
                  setTimeout(() => setIdCopied(false), 1500);
                }}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left font-mono text-xs text-muted-foreground hover:bg-muted"
                title={`Click to copy ${row.assemblyai_id}`}
              >
                ID: {row.assemblyai_id.slice(0, 12)}…
                {idCopied && <span className="ml-auto font-sans">Copied</span>}
              </button>
            </div>
          )}
        </div>
      </AppHeader>

      <div className="mx-auto max-w-[1200px] px-6 py-6">
        {row.deleted_at && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-400/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <Trash2 className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <span>
              This transcript is in the trash (deleted{' '}
              {new Date(row.deleted_at).toLocaleString()}) — hidden from every list and
              search until restored.
            </span>
            {access === 'owner' && (
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void handleRestore()}>
                  Restore
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void handleTrashDelete()}>
                  Delete forever
                </Button>
              </span>
            )}
          </div>
        )}
        {/* Page header: title (inline editable) + meta row */}
        <div className="mb-6">
          {editingTitle && canEdit ? (
            <Input
              autoFocus
              value={title}
              placeholder={row.original_filename || 'Untitled transcript'}
              disabled={savingMeta}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelTitle();
                }
              }}
              className="!text-2xl !font-semibold !tracking-tight !h-auto !py-1 !px-1 -mx-1 border-dashed"
            />
          ) : (
            <h1
              onClick={() => canEdit && setEditingTitle(true)}
              title={canEdit ? 'Click to edit title' : ''}
              className={`text-2xl font-semibold tracking-tight leading-tight rounded -mx-1 px-1 py-0.5 ${
                canEdit ? 'cursor-text hover:bg-muted/40' : ''
              } ${title.trim() ? '' : 'text-muted-foreground italic'}`}
            >
              {title.trim() || row.original_filename || 'Untitled transcript'}
            </h1>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {row.status !== 'completed' &&
              (row.status === 'error' ? (
                <Badge variant="destructive">Failed</Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-busy" />
                  Processing
                </Badge>
              ))}
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px]">
              {row.gmeet_context?.provider === 'teams' ? (
                <>
                  <TeamsLogo className="h-3 w-3" />
                  Microsoft Teams
                </>
              ) : row.assemblyai_id.startsWith('gmeet-') ? (
                <>
                  <MeetLogo className="h-3 w-3" />
                  Google Meet
                </>
              ) : row.source === 'uploaded' ? (
                <>
                  <FileAudio className="h-3 w-3" />
                  Upload
                </>
              ) : (
                <>
                  <FileText className="h-3 w-3" />
                  Import
                </>
              )}
            </span>
            {seriesMembership !== 'loading' && (
              <SeriesBadge
                assemblyaiId={transcriptId}
                membership={seriesMembership}
                defaultTitle={title.trim() || row.original_filename}
                onOpenSeries={setOpenSeriesId}
                onChanged={loadSeriesInfo}
                variant="full"
              />
            )}
            {dateEditOpen && canEdit ? (
              <span
                className="inline-flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="datetime-local"
                  value={dateDraft}
                  onChange={(e) => setDateDraft(e.target.value)}
                  className="h-7 rounded-md border bg-background px-1.5 text-xs"
                  disabled={dateSaving}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={dateSaving || !dateDraft}
                  onClick={async () => {
                    setDateSaving(true);
                    try {
                      const res = await fetch(`/api/transcripts/${transcriptId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          recordedAt: new Date(dateDraft).toISOString(),
                        }),
                      });
                      if (res.ok) {
                        setDateEditOpen(false);
                        await loadAll();
                      }
                    } finally {
                      setDateSaving(false);
                    }
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={dateSaving}
                  onClick={() => setDateEditOpen(false)}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className={`${canEdit ? 'hover:text-foreground hover:underline decoration-dotted underline-offset-2' : 'cursor-default'}`}
                title={
                  canEdit
                    ? `Meeting date — click to edit (${safeFormatDate(row.recorded_at ?? row.created_at)})`
                    : safeFormatDate(row.recorded_at ?? row.created_at)
                }
                onClick={() => {
                  if (!canEdit) return;
                  const base = new Date(row.recorded_at ?? row.created_at);
                  const pad = (n: number) => String(n).padStart(2, '0');
                  setDateDraft(
                    `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`
                  );
                  setDateEditOpen(true);
                }}
              >
                {formatHeaderDate(row.recorded_at ?? row.created_at)}
              </button>
            )}
            {row.duration != null && (
              <span className="font-mono text-[11px] tabular-nums">
                {formatDuration(row.duration)}
              </span>
            )}
            {row.speaker_count != null && (
              <span>
                {row.speaker_count} speaker{row.speaker_count === 1 ? '' : 's'}
              </span>
            )}
            {row.language_code && <span className="uppercase">{row.language_code}</span>}
            <div className="ml-auto">
              <ActivityBar transcriptId={transcriptId} refreshSignal={activityTick} />
            </div>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-8">
          <div className="min-w-0 space-y-5">
            {/* Audio player — sticky so it stays visible while scrolling the transcript */}
            {row.status === 'completed' && audioAvailable && (
              <div
                className={`sticky top-[60px] z-30 -mx-1 rounded-lg border bg-card/95 px-3 py-2 backdrop-blur ${FLOATING_SHADOW}`}
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {nowSegment ? `Now: ${nowSegment.title}` : ''}
                  </span>
                  {(storedParts.length > 0 || partsGenerating > 0 || partsFetching > 0) && (
                    <span className="flex shrink-0 items-center gap-1">
                      {[{ partNo: 1, durationSec: null as number | null }, ...storedParts].map(
                        (p) => (
                          <button
                            key={p.partNo}
                            type="button"
                            onClick={() => {
                              if (p.partNo === activePart) return;
                              pendingPartSeekRef.current = { t: 0, play: false };
                              setActivePart(p.partNo);
                            }}
                            title={
                              p.partNo === 1
                                ? 'The transcribed video'
                                : 'Extra recording segment — the recording was stopped and restarted'
                            }
                            className={`rounded-md border px-1.5 py-0.5 font-medium ${
                              p.partNo === activePart
                                ? 'border-primary/50 bg-primary/10 text-primary'
                                : 'hover:bg-muted'
                            }`}
                          >
                            Video {p.partNo}
                            {p.durationSec ? ` · ${Math.round(p.durationSec / 60)}m` : ''}
                          </button>
                        )
                      )}
                      {partsFetching > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/50 px-1.5 py-0.5 text-amber-600 dark:text-amber-500">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {partsFetching} more fetching
                        </span>
                      )}
                      {partsGenerating > 0 && (
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-amber-400/50 px-1.5 py-0.5 text-amber-600 dark:text-amber-500"
                          title="Meet recorded another video — Google is still preparing the file. We check every minute and attach it automatically."
                        >
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {partsGenerating} more preparing
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <AudioPlayer
                  key={activePart}
                  ref={playerRef}
                  className="h-10 w-full"
                  src={
                    activePart === 1
                      ? `/api/transcripts/${row.assemblyai_id}/audio`
                      : `/api/transcripts/${row.assemblyai_id}/audio?part=${activePart}`
                  }
                  hasVideo={
                    activePart === 1
                      ? hasLocalVideo
                      : /\.(mp4|webm|mov|mkv|m4v)$/i.test(activePartInfo?.filename ?? '')
                  }
                  onTimeUpdate={(t) => setCurrentTime(t + activePartOffset)}
                  onLoadedMetadata={() => {
                    const ps = pendingPartSeekRef.current;
                    if (!ps) return;
                    pendingPartSeekRef.current = null;
                    if (ps.play) playerRef.current?.seekToSeconds(ps.t);
                    else playerRef.current?.seekOnly(ps.t);
                  }}
                  onError={() => {
                    // A broken part falls back to the primary instead of
                    // hiding the whole player.
                    if (activePart !== 1) setActivePart(1);
                    else setAudioAvailable(false);
                  }}
                />
              </div>
            )}

            {/* Summary — meeting notes generated by headless Claude on the server. */}
            {row.status === 'completed' &&
              (row.auto_notes || row.auto_notes_status || canEdit) && (
              <Card id="ai-summary" className="scroll-mt-36">
                <CardHeader className="px-4 pt-3 pb-2">
                  <button
                    type="button"
                    onClick={() => toggleSection('aiSummary')}
                    className="flex w-full items-center gap-2 text-left"
                    aria-expanded={!collapsedSections.aiSummary}
                  >
                    <Sparkles className="h-4 w-4 shrink-0 text-primary" />
                    <span className="text-[13px] font-semibold">Summary</span>
                    {collapsedSections.aiSummary ? (
                      <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </CardHeader>
                {!collapsedSections.aiSummary && (
                  <CardContent className="px-4 pb-4">
                    <div className="mb-3 flex items-center gap-1 rounded-lg bg-muted/60 p-0.5 text-xs w-fit">
                      {/* The richer read leads once it exists: report tab first. */}
                      {[
                        {
                          key: 'report' as const,
                          label: 'Detailed report',
                          spinning: row.auto_report_status === 'running' || reportQueued,
                        },
                        { key: 'summary' as const, label: 'Summary', spinning: false },
                      ]
                        .sort((a, b) =>
                          row.auto_report ? (a.key === 'report' ? -1 : 1) : a.key === 'summary' ? -1 : 1
                        )
                        .map((t) => (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => selectSummaryTab(t.key)}
                            className={`flex items-center gap-1 rounded-md px-2.5 py-1 font-medium transition-colors ${summaryTab === t.key ? 'bg-card shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                          >
                            {t.label}
                            {t.spinning && (
                              <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
                            )}
                          </button>
                        ))}
                    </div>
                    {summaryTab === 'report' ? (
                    <>
                    {reportQueued && row.auto_report_status !== 'running' && (
                      <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-400/50 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-600 dark:text-amber-500" />
                        Video report queued — Google is still preparing the recording. It starts
                        on its own the moment the video lands (checked every minute).
                      </div>
                    )}
                    {row.auto_report_status === 'running' ? (
                        <div className="space-y-2 py-2">
                          {['95%', '100%', '85%', '90%', '70%'].map((w, i) => (
                            <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: w }} />
                          ))}
                          <p className="pt-1 text-xs text-muted-foreground">
                            Writing the detailed report — high effort, so give it a few minutes.
                            The quick summary refreshes right after, distilled from the same session.
                          </p>
                        </div>
                      ) : row.auto_report ? (
                        <>
                          <div className="markdown-body max-w-[75ch] text-sm">
                            <NotesMarkdown
                              markdown={row.auto_report}
                              transcriptId={row.assemblyai_id}
                              onSeek={(s) => seekMeetingTime(s, { play: true })}
                            />
                          </div>
                          <div className="mt-4 flex items-center gap-2 border-t pt-2.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => navigator.clipboard.writeText(row.auto_report ?? '')}
                            >
                              <Copy className="h-3 w-3" />
                              Copy
                            </Button>
                            {canEdit && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs"
                                disabled={generatingReport}
                                onClick={() => openGenerateDialog(true)}
                              >
                                <RefreshCw className="h-3 w-3" />
                                Regenerate
                              </Button>
                            )}
                            {row.auto_report_at && (
                              <button
                                type="button"
                                onClick={() => setAiRunsOpen(true)}
                                className="ml-auto cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                                title="All AI runs & costs for this meeting"
                              >
                                generated {formatDistanceToNow(new Date(row.auto_report_at), { addSuffix: true })}
                                {aiStats?.latestReport?.cost_usd != null &&
                                  ` · $${Number(aiStats.latestReport.cost_usd).toFixed(2)}`}
                                {aiStats?.latestReport?.duration_ms != null &&
                                  ` · ${Math.round(aiStats.latestReport.duration_ms / 1000)}s`}
                                {aiStats && aiStats.totals.runs > 1 &&
                                  ` · Σ $${Number(aiStats.totals.cost_usd ?? 0).toFixed(2)}`}
                              </button>
                            )}
                          </div>
                        </>
                      ) : row.auto_report_status === 'error' ? (
                        <div className="space-y-2 text-sm">
                          <p className="text-destructive">
                            Report generation failed: {row.auto_report_error || 'unknown error'}
                          </p>
                          {canEdit && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={generatingReport}
                              onClick={() => void handleGenerateReport()}
                            >
                              <RefreshCw className="h-3 w-3" />
                              Retry
                            </Button>
                          )}
                        </div>
                      ) : canEdit ? (
                        <div className="flex flex-col items-center py-6 text-center">
                          <p className="text-sm text-muted-foreground">No detailed report yet.</p>
                          <Button size="sm" className="mt-3" disabled={generatingReport} onClick={() => openGenerateDialog(true)}>
                            <Sparkles className="h-4 w-4" />
                            Generate detailed report
                          </Button>
                          <p className="mt-2 max-w-[46ch] text-xs text-muted-foreground">
                            A wiki-style deep dive: topic sections, tables,
                            {hasLocalVideo || canFetchVideo ? ' screenshots from the recording,' : ''}{' '}
                            and click-to-jump timestamp citations. Slower and pricier
                            than the summary — worth it for dense meetings.
                          </p>
                        </div>
                      ) : (
                        <p className="py-4 text-sm text-muted-foreground">No detailed report yet.</p>
                      )}
                    </>
                    ) : (
                    <>
                    {notesStale && row.auto_notes_status !== 'running' && canEdit && (
                      <div className="mb-3 flex items-center justify-between gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs">
                        <span className="text-muted-foreground">{notesStale}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 shrink-0 text-[11px] text-primary hover:text-primary"
                          disabled={generatingNotes}
                          onClick={() => void handleGenerateNotes()}
                        >
                          <RefreshCw className="h-3 w-3" />
                          Rerun
                        </Button>
                      </div>
                    )}
                    {/* A completed report holds more verified context (frames,
                        docs) than this summary saw — offer the one-click
                        distillation whenever the report is the newer artifact. */}
                    {!notesStale &&
                      canEdit &&
                      row.auto_notes &&
                      row.auto_notes_status !== 'running' &&
                      row.auto_report &&
                      row.auto_report_at &&
                      (!row.auto_notes_at ||
                        new Date(row.auto_report_at) > new Date(row.auto_notes_at)) && (
                        <div className="mb-3 flex items-center justify-between gap-2 rounded-md border bg-muted/60 px-3 py-2 text-xs">
                          <span className="text-muted-foreground">
                            A newer detailed report exists — this summary can be rebuilt from
                            everything the AI verified there
                            {hasLocalVideo ? ' (video frames included)' : ''}.
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 shrink-0 text-[11px] text-primary hover:text-primary"
                            disabled={generatingNotes}
                            onClick={() => void handleTopUpSummary()}
                          >
                            <Sparkles className="h-3 w-3" />
                            Top up summary
                          </Button>
                        </div>
                      )}
                    {row.auto_notes_status === 'running' ? (
                      <div className="space-y-2 py-2">
                        {['90%', '100%', '80%', '95%', '60%'].map((w, i) => (
                          <div
                            key={i}
                            className="h-3 animate-pulse rounded bg-muted"
                            style={{ width: w }}
                          />
                        ))}
                        <p className="pt-1 text-xs text-muted-foreground">
                          Generating with Claude — usually 1–2 minutes.
                        </p>
                      </div>
                    ) : row.auto_notes ? (
                      <>
                        <div className="markdown-body max-w-[75ch] text-sm">
                          <NotesMarkdown
                            markdown={row.auto_notes}
                            transcriptId={row.assemblyai_id}
                            onSeek={(s) => seekMeetingTime(s, { play: true })}
                          />
                        </div>
                        <div className="mt-4 flex items-center gap-2 border-t pt-2.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => navigator.clipboard.writeText(row.auto_notes ?? '')}
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </Button>
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={generatingNotes}
                              onClick={() => openGenerateDialog(false)}
                            >
                              <RefreshCw className="h-3 w-3" />
                              Regenerate
                            </Button>
                          )}
                          {canEdit && row.auto_report && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={generatingNotes}
                              title="Rebuild this summary from the detailed-report session — it reuses the video frames and documents the AI already verified there"
                              onClick={() => void handleTopUpSummary()}
                            >
                              <Sparkles className="h-3 w-3" />
                              Top up from report
                            </Button>
                          )}
                          {row.auto_notes_at && (
                            <button
                              type="button"
                              onClick={() => setAiRunsOpen(true)}
                              className="ml-auto cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                              title="All AI runs & costs for this meeting"
                            >
                              generated {formatDistanceToNow(new Date(row.auto_notes_at), { addSuffix: true })}
                              {aiStats?.latest?.cost_usd != null &&
                                ` · $${Number(aiStats.latest.cost_usd).toFixed(2)}`}
                              {aiStats?.latest?.duration_ms != null &&
                                ` · ${Math.round(aiStats.latest.duration_ms / 1000)}s`}
                              {aiStats && aiStats.totals.runs > 1 &&
                                ` · Σ $${Number(aiStats.totals.cost_usd ?? 0).toFixed(2)}`}
                            </button>
                          )}
                        </div>
                      </>
                    ) : row.auto_notes_status === 'error' ? (
                      <div className="space-y-2 text-sm">
                        <p className="text-destructive">
                          Notes generation failed: {row.auto_notes_error || 'unknown error'}
                        </p>
                        {canEdit && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={generatingNotes}
                            onClick={() => void handleGenerateNotes()}
                          >
                            <RefreshCw className="h-3 w-3" />
                            Retry
                          </Button>
                        )}
                      </div>
                    ) : canEdit ? (
                      <div className="flex flex-col items-center py-6 text-center">
                        {row.speaker_id_status === 'running' ? (
                          <>
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              Identifying speakers first…
                            </p>
                            <p className="mt-1 max-w-[46ch] text-xs text-muted-foreground">
                              The AI is working out who&apos;s who — transcript, voiceprints,
                              the people directory{hasLocalVideo ? ', video frames' : ''} — so
                              the summary can use real names from the start.
                            </p>
                            <Button
                              size="sm"
                              variant="outline"
                              className="mt-3"
                              disabled={generatingNotes || reviewSpeakers.length === 0}
                              onClick={() => setReviewOpen(true)}
                            >
                              Review speakers now
                            </Button>
                          </>
                        ) : row.auto_report ? (
                          <>
                            <p className="text-sm text-muted-foreground">No summary yet.</p>
                            <Button
                              size="sm"
                              className="mt-3"
                              disabled={generatingNotes}
                              onClick={() => void handleTopUpSummary()}
                            >
                              <Sparkles className="h-4 w-4" />
                              Summarize from the detailed report
                            </Button>
                            <p className="mt-2 max-w-[46ch] text-xs text-muted-foreground">
                              The detailed report already verified this meeting&apos;s context
                              {hasLocalVideo ? ' — video frames included' : ''} — the quick
                              summary distills straight from that session, so it&apos;s fast
                              and cheap.
                            </p>
                          </>
                        ) : (
                          <>
                            <p className="text-sm text-muted-foreground">No summary yet.</p>
                            <Button
                              size="sm"
                              className="mt-3"
                              disabled={generatingNotes}
                              onClick={() =>
                                reviewSpeakers.length > 0 ? setReviewOpen(true) : openGenerateDialog(false)
                              }
                            >
                              <Sparkles className="h-4 w-4" />
                              Review speakers &amp; generate
                            </Button>
                            <p className="mt-2 max-w-[46ch] text-xs text-muted-foreground">
                              Confirm who&apos;s who first — the summary is written with those
                              names. Tip: attach an agenda or deck in the right panel too; it
                              sharpens the output.
                            </p>
                          </>
                        )}
                      </div>
                    ) : null}
                    </>
                    )}
                  </CardContent>
                )}
              </Card>
            )}

            {/* Description — click-to-edit, markdown rendered. */}
            {(description || canEdit) && (
              <Card id="notes" className="scroll-mt-36">
                <CardHeader className="px-4 pt-3 pb-2">
                  <button
                    type="button"
                    onClick={() => toggleSection('notes')}
                    className="flex w-full items-center gap-2 text-left"
                    aria-expanded={!collapsedSections.notes}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-[13px] font-semibold">Notes</span>
                    {collapsedSections.notes ? (
                      <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                </CardHeader>
                {!collapsedSections.notes && (
                <CardContent className="px-4 pb-4">
                  {editingDescription && canEdit ? (
                    <Textarea
                      autoFocus
                      value={description}
                      placeholder="Notes, attendees, action items… markdown supported."
                      disabled={savingMeta}
                      rows={Math.min(Math.max(description.split('\n').length + 1, 4), 20)}
                      onChange={(e) => setDescription(e.target.value)}
                      onBlur={commitDescription}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelDescription();
                        }
                      }}
                      className="font-mono text-sm"
                    />
                  ) : description ? (
                    <div
                      onClick={() => canEdit && setEditingDescription(true)}
                      title={canEdit ? 'Click to edit' : ''}
                      className={`markdown-body max-w-[75ch] text-sm rounded ${
                        canEdit ? 'cursor-text hover:bg-muted/30 px-1 -mx-1' : ''
                      }`}
                    >
                      {(() => {
                        // One slugger per render so duplicate-suffix counters match
                        // the values produced by extractHeadings(description).
                        const slug = makeSlugger();
                        const headingText = (node: React.ReactNode): string => {
                          if (typeof node === 'string' || typeof node === 'number') return String(node);
                          if (Array.isArray(node)) return node.map(headingText).join('');
                          if (node && typeof node === 'object' && 'props' in node) {
                            const props = (node as { props?: { children?: React.ReactNode } }).props;
                            return headingText(props?.children);
                          }
                          return '';
                        };
                        return (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          h1: ({ children }) => <h1 id={slug(headingText(children))} className="text-xl font-semibold mt-3 mb-2 scroll-mt-36">{children}</h1>,
                          h2: ({ children }) => <h2 id={slug(headingText(children))} className="text-lg font-semibold mt-3 mb-2 scroll-mt-36">{children}</h2>,
                          h3: ({ children }) => <h3 id={slug(headingText(children))} className="text-base font-semibold mt-3 mb-1.5 scroll-mt-36">{children}</h3>,
                          p: ({ children }) => <p className="leading-relaxed my-2">{children}</p>,
                          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
                          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer" className="text-primary underline hover:text-primary/80">
                              {children}
                            </a>
                          ),
                          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                          em: ({ children }) => <em className="italic">{children}</em>,
                          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
                          pre: ({ children }) => <pre className="rounded-md bg-muted p-3 overflow-x-auto my-2 text-xs font-mono">{children}</pre>,
                          blockquote: ({ children }) => (
                            <blockquote className="border-l-4 border-muted pl-3 italic text-muted-foreground my-2">{children}</blockquote>
                          ),
                          hr: () => <hr className="my-3 border-muted" />,
                          table: ({ children }) => (
                            <div className="overflow-x-auto my-2">
                              <table className="min-w-full border-collapse text-xs">{children}</table>
                            </div>
                          ),
                          th: ({ children }) => <th className="border px-2 py-1 bg-muted text-left">{children}</th>,
                          td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
                        }}
                      >
                        {description}
                      </ReactMarkdown>
                        );
                      })()}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditingDescription(true)}
                      className="w-full rounded-md border border-dashed px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                      + Add notes
                    </button>
                  )}
                </CardContent>
                )}
              </Card>
            )}

            {/* Speakers — friendly name + description per speaker */}
            {viewMode === 'edited' && content?.utterances && content.utterances.length > 0 && (
              <div id="speakers" className="scroll-mt-36">
                <SpeakerSummaryPanel
                  utterances={content.utterances}
                  speakerLabels={speakerLabels}
                  onSave={handleSaveSpeaker}
                  canEdit={canEdit}
                  onPickPerson={handlePickPerson}
                  onRequestCreatePerson={handleRequestCreatePerson}
                  audioSrc={
                    row.status === 'completed' && audioAvailable
                      ? `/api/transcripts/${row.assemblyai_id}/audio`
                      : null
                  }
                  hasVideo={hasLocalVideo}
                  collapsed={!!collapsedSections.speakers}
                  onToggleCollapse={() => toggleSection('speakers')}
                  suggestions={speakerSuggestions}
                  onGuessNames={handleGuessSpeakers}
                  guessingNames={guessingSpeakers}
                />
              </div>
            )}

            {/* Transcript Content */}
            <Card id="transcript" className="scroll-mt-36">
              <CardHeader className="px-4 pt-3 pb-2">
                <button
                  type="button"
                  onClick={() => toggleSection('transcript')}
                  className="flex w-full items-center gap-2 text-left"
                  aria-expanded={!collapsedSections.transcript}
                >
                  <Headphones className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-[13px] font-semibold">Transcript</span>
                  {viewMode === 'raw' && (
                    <Badge variant="outline" className="text-[10px]">
                      Raw — read-only
                    </Badge>
                  )}
                  {collapsedSections.transcript ? (
                    <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                </button>
              </CardHeader>
              {!collapsedSections.transcript && (
              <CardContent className="px-4 pb-4">
                {row.status === 'completed' && content ? (
                  <div>
                    {content.utterances && content.utterances.length > 0 ? (
                      content.utterances.map((utterance, index) => {
                        const showSpeaker =
                          index === 0 ||
                          content.utterances![index - 1]!.speaker !== utterance.speaker ||
                          segmentByUtterance.has(index);
                        return (
                          <div key={index}>
                            {viewMode === 'edited' && segmentByUtterance.has(index) && (
                              <div className="flex scroll-mt-36 items-center gap-2 pt-6 pb-1.5">
                                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                                  {formatTime(segmentByUtterance.get(index)!.start_ms)}
                                </span>
                                <h4 className="text-[13px] font-semibold">
                                  {segmentByUtterance.get(index)!.title}
                                </h4>
                                <div className="h-px flex-1 bg-border" />
                              </div>
                            )}
                            <EditableUtterance
                              index={index}
                              utterance={utterance}
                              displayText={displayTextFor(index)}
                              isTextEdited={viewMode === 'edited' && isTextEdited(index)}
                              isActive={index === currentUtteranceIndex}
                              speakerLabels={speakerLabels}
                              highlights={highlightsByUtterance.get(index)}
                              onSeek={handleSeekToUtterance}
                              canEdit={viewMode === 'edited' && canEdit}
                              showSpeaker={showSpeaker}
                              onPickPerson={handlePickPerson}
                              onRequestCreatePerson={handleRequestCreatePerson}
                              onSaveText={
                                viewMode === 'edited' && canEdit
                                  ? handleSaveText
                                  : () => {
                                      /* read-only */
                                    }
                              }
                              onSaveSpeaker={
                                viewMode === 'edited' && canEdit
                                  ? handleSaveSpeaker
                                  : () => {
                                      /* read-only */
                                    }
                              }
                            />
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-muted-foreground">
                        {content.text || 'No transcript content available'}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    Transcript is {row.status}. Content will be available when processing is complete.
                  </p>
                )}
              </CardContent>
              )}
            </Card>
          </div>

          <aside className="hidden lg:block">
            {/* Reader-first order: what/when/who first, navigation next,
                interactive analysis details after, actions LAST — most
                people read; only a few edit. */}
            <div className="sticky top-[72px] max-h-[calc(100vh-88px)] space-y-4 overflow-y-auto pr-1">
              <MeetingInfoCard
                row={row}
                speakerLabels={speakerLabels}
                canEdit={canEdit}
                audioAvailable={audioAvailable}
                videoFetching={videoFetching}
                videoFetchError={videoFetchError}
                onFetchVideo={() => void fetchVideo()}
                onLinkEvent={() => setLinkEventOpen(true)}
              />
              <TranscriptOutline
                durationSec={row.duration ?? null}
                hasNotes={!!description || canEdit}
                hasSpeakers={
                  viewMode === 'edited' &&
                  !!content?.utterances &&
                  content.utterances.length > 0
                }
                notesHeadings={notesHeadings}
                currentTimeSec={outlineTimeSec}
                onJumpToSeconds={handleOutlineJump}
                activeAnchor={activeAnchor}
                segments={row.auto_segments}
              />
              <TranscriptSourcesCard
                row={row}
                suggestions={speakerSuggestions}
                canEdit={canEdit}
              />
              <AttachmentPanel
                transcriptId={row.assemblyai_id}
                canEdit={canEdit}
                onChanged={() => {
                  bumpActivity();
                  if (row.auto_notes || row.auto_report)
                    markAiStale('attachments', 'attached context files');
                }}
              />
              {renderQuickActions()}
            </div>
          </aside>
        </div>

        {/* Mobile / tablet outline FAB — opens quick actions + outline in a dialog. */}
        <button
          type="button"
          onClick={() => setOutlineOpenMobile(true)}
          className={`lg:hidden fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full border bg-card px-4 py-2.5 text-xs font-medium text-foreground hover:bg-muted ${FLOATING_SHADOW}`}
          aria-label="Open outline"
        >
          <ListTree className="h-4 w-4" />
          Outline
        </button>

        <Dialog open={aiRunsOpen} onOpenChange={setAiRunsOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">AI usage — this meeting</DialogTitle>
              <DialogDescription className="text-xs">
                Every Claude run on this transcript. Regenerations add up; the totals are lifetime.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-baseline gap-4 rounded-md border bg-muted/40 px-3 py-2">
              <span className="text-lg font-semibold">
                ${Number(aiStats?.totals.cost_usd ?? 0).toFixed(2)}
              </span>
              <span className="text-xs text-muted-foreground">
                {aiStats?.totals.runs ?? 0} run{(aiStats?.totals.runs ?? 0) === 1 ? '' : 's'} total
              </span>
            </div>
            <div className="max-h-[45vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">What</th>
                    <th className="py-1 pr-2 font-medium">When</th>
                    <th className="py-1 pr-2 font-medium">By</th>
                    <th className="py-1 pr-2 text-right font-medium">Time</th>
                    <th className="py-1 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {aiRuns.map((r, i) => {
                    const kindLabel =
                      ({
                        auto_notes: 'Summary',
                        auto_report: 'Detailed report',
                        import_normalize: 'Import',
                        ask: 'Ask AI',
                      } as Record<string, string>)[String(r.kind)] ?? String(r.kind);
                    return (
                      <tr key={i} className="border-b border-dashed last:border-0">
                        <td className="py-1 pr-2">
                          {kindLabel}
                          {r.status === 'error' && (
                            <span className="ml-1 text-destructive">failed</span>
                          )}
                        </td>
                        <td className="py-1 pr-2 whitespace-nowrap text-muted-foreground">
                          {r.created_at
                            ? formatDistanceToNow(new Date(String(r.created_at)), { addSuffix: true })
                            : '—'}
                        </td>
                        <td className="max-w-[10rem] truncate py-1 pr-2 text-muted-foreground">
                          {String(r.triggered_by_email ?? '') || 'auto'}
                        </td>
                        <td className="py-1 pr-2 text-right text-muted-foreground">
                          {r.duration_ms != null ? `${Math.round(Number(r.duration_ms) / 1000)}s` : '—'}
                        </td>
                        <td className="py-1 text-right">
                          {r.cost_usd != null ? `$${Number(r.cost_usd).toFixed(2)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                  {aiRuns.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-center text-muted-foreground">
                        No AI runs yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </DialogContent>
        </Dialog>

        <SpeakerReviewDialog
          open={reviewOpen}
          onOpenChange={setReviewOpen}
          speakers={reviewSpeakers}
          utteranceCounts={reviewCounts}
          speakerLabels={speakerLabels}
          suggestions={speakerSuggestions}
          identifying={row.speaker_id_status === 'running'}
          onConfirm={handleReviewConfirm}
          onSkip={() => {
            setReviewOpen(false);
            void runPostReviewGeneration();
          }}
        />

        <GenerateDialog
          open={notesPromptOpen}
          onOpenChange={setNotesPromptOpen}
          staleLabels={staleLabels}
          hasLocalVideo={hasLocalVideo}
          canFetchVideo={canFetchVideo}
          videoPreparing={videoPreparing}
          videoFetching={videoFetching}
          generating={generatingNotes || generatingReport}
          defaultDetailed={genDefaultDetailed}
          onGenerate={({ detailed, video, instructions }) => {
            setNotesPromptOpen(false);
            if (detailed) {
              // Only the report fires — the quick summary auto-distills from
              // the report session when it completes.
              selectSummaryTab('report');
              void handleGenerateReport(instructions, video);
            } else {
              selectSummaryTab('summary');
              void handleGenerateNotes(instructions);
            }
          }}
        />

        <Dialog open={outlineOpenMobile} onOpenChange={setOutlineOpenMobile}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Outline</DialogTitle>
            </DialogHeader>
            {/* Same reader-first order as the desktop rail: info → outline →
                sources → attachments → actions last. */}
            <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
              <MeetingInfoCard
                row={row}
                speakerLabels={speakerLabels}
                canEdit={canEdit}
                audioAvailable={audioAvailable}
                videoFetching={videoFetching}
                videoFetchError={videoFetchError}
                onFetchVideo={() => void fetchVideo()}
                onLinkEvent={() => {
                  setOutlineOpenMobile(false);
                  setLinkEventOpen(true);
                }}
              />
              <div onClick={() => setOutlineOpenMobile(false)}>
                <TranscriptOutline
                  durationSec={row.duration ?? null}
                  hasNotes={!!description || canEdit}
                  hasSpeakers={
                    viewMode === 'edited' &&
                    !!content?.utterances &&
                    content.utterances.length > 0
                  }
                  notesHeadings={notesHeadings}
                  currentTimeSec={outlineTimeSec}
                  onJumpToSeconds={(s) => {
                    handleOutlineJump(s);
                    setOutlineOpenMobile(false);
                  }}
                  activeAnchor={activeAnchor}
                  segments={row.auto_segments}
                />
              </div>
              <TranscriptSourcesCard
                row={row}
                suggestions={speakerSuggestions}
                canEdit={canEdit}
              />
              <AttachmentPanel
                transcriptId={row.assemblyai_id}
                canEdit={canEdit}
                onChanged={() => {
                  bumpActivity();
                  if (row.auto_notes || row.auto_report)
                    markAiStale('attachments', 'attached context files');
                }}
              />
              {renderQuickActions(true)}
            </div>
          </DialogContent>
        </Dialog>

        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          transcriptId={transcriptId}
          callerAccess={access}
          onSharesChanged={(shares) => {
            setCollaboratorEmails(
              new Set(shares.map((s) => s.shared_with_email.toLowerCase()))
            );
            bumpActivity();
            void refreshShareSuggestions();
          }}
        />

        <LinkEventDialog
          open={linkEventOpen}
          onClose={() => setLinkEventOpen(false)}
          transcriptId={transcriptId}
          initialDateIso={row.recorded_at ?? row.created_at}
          onLinked={() => {
            void loadAll();
            void refreshShareSuggestions();
            bumpActivity();
            // Attendees / meeting metadata just changed — the existing
            // summary doesn't know about them. Offer a rerun, never auto-run.
            // (The AI can map calendar attendees to speaker names.)
            if (row?.auto_notes || row?.auto_report)
              markAiStale('calendar', 'the linked calendar event (attendees, title, time)');
          }}
        />

        <AddPersonDialog
          open={!!pendingCreate}
          initialName={pendingCreate?.name ?? ''}
          onCreated={handlePersonCreated}
          onUseAsLabel={handleUsePersonAsLabel}
          onCancel={() => setPendingCreate(null)}
        />

        <SeriesDialog
          seriesId={openSeriesId}
          onClose={() => setOpenSeriesId(null)}
          onChanged={loadSeriesInfo}
        />

        <Dialog open={!!pendingShare} onOpenChange={(v) => !v && setPendingShare(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add to access?</DialogTitle>
              <DialogDescription>
                {pendingShare && (
                  <>
                    You tagged <span className="font-medium">{pendingShare.name}</span>{' '}
                    as a speaker. Would you like to give them editor access to this
                    transcript so they can make corrections?
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            {pendingShare?.email && (
              <div className="rounded-md border p-3 text-sm">
                <div className="font-medium">{pendingShare.name}</div>
                <div className="text-xs text-muted-foreground">{pendingShare.email}</div>
              </div>
            )}
            {sharingError && <p className="text-xs text-destructive">{sharingError}</p>}
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setPendingShare(null)}
                disabled={sharingPending}
              >
                Skip
              </Button>
              <Button onClick={handleConfirmPendingShare} disabled={sharingPending}>
                {sharingPending ? 'Adding…' : 'Add as editor'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <FindReplacePanel
          open={findReplaceOpen}
          onClose={() => setFindReplaceOpen(false)}
          query={findQuery}
          onQueryChange={(q) => {
            setFindQuery(q);
            setCurrentMatchPos(0);
          }}
          replace={replaceWith}
          onReplaceChange={setReplaceWith}
          caseSensitive={findCaseSensitive}
          onCaseSensitiveChange={(cs) => {
            setFindCaseSensitive(cs);
            setCurrentMatchPos(0);
          }}
          matchCount={findMatches.length}
          currentIndex={findMatches.length > 0 ? currentMatchPos + 1 : 0}
          onNext={handleFindNext}
          onPrev={handleFindPrev}
          onReplaceCurrent={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
        />
      </div>
    </div>
  );
}

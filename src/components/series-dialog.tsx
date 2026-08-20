'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getGoogleAccessToken, GoogleNotConnectedError } from '@/lib/google-token';
import {
  Repeat,
  Loader2,
  RefreshCw,
  Video,
  FileText,
  Check,
  X,
  Trash2,
  Pencil,
  Download,
  ExternalLink,
  CalendarClock,
  CalendarDays,
  Merge,
  Zap,
  Info,
  ChevronRight,
  Bell,
  Users,
  Link2,
} from 'lucide-react';

/**
 * The series view: confirmed members, guessed members awaiting a yes/no, and
 * the live occurrence sweep (calendar + Graph) with per-occurrence and mass
 * import. Occurrences are computed server-side on every open — nothing about
 * them is persisted.
 */

interface AutoImportCfg {
  enabled: boolean;
  byUserId: string;
  byEmail: string;
  mode: 'transcript' | 'video' | 'both';
  report: 'summary' | 'detailed-video' | 'detailed-text' | 'later';
  since: string;
  lastSweepAt?: string;
  lastError?: string | null;
}

interface SeriesDetail {
  series: { id: number; title: string; notes: string | null; auto_import: AutoImportCfg | null };
  members: Array<{
    transcript_id: number;
    assemblyai_id: string;
    title: string | null;
    recorded_at: string | null;
    created_at: string;
    how: string;
    accessible: boolean;
  }>;
  suggestions: Array<{
    transcript_id: number;
    assemblyai_id: string;
    title: string | null;
    recorded_at: string | null;
    created_at: string;
    matched_kinds: string[];
    status: string;
    duration: number | null;
    source: 'uploaded' | 'imported';
    owned: boolean;
    provider: 'gmeet' | 'teams' | null;
    event_title: string | null;
    event_start: string | null;
    organizer_email: string | null;
    attendee_count: number;
  }>;
  /** Probable-duplicate sibling series (shared Meet code / recurring event /
   * Teams meeting / name) — the one-click merge prompt. */
  dupes: Array<{
    id: number;
    title: string;
    member_count: number;
    last_recorded_at: string | null;
    reason: string;
  }>;
}

interface Occurrence {
  key: string;
  startIso: string;
  endIso: string | null;
  title: string | null;
  /** 'imported' = a member no calendar/Teams occurrence matched (you aren't
   * on the event, it's outside the 12-month window, or it was uploaded). */
  source: 'calendar' | 'graph' | 'both' | 'imported';
  upcoming: boolean;
  meetingCode: string | null;
  eventId: string | null;
  recurringEventId: string | null;
  iCalUID: string | null;
  organizerEmail: string | null;
  attendees: Array<{ email: string; name?: string; responseStatus?: string }>;
  hasRecording: boolean;
  hasTranscript: boolean;
  videoFileId: string | null;
  transcriptDocId: string | null;
  teams: { joinWebUrl: string; callId: string | null } | null;
  calendarUrl: string | null;
  imported: Array<{ assemblyai_id: string; title: string | null; accessible: boolean }>;
}

interface OccurrencesResult {
  googleConnected: boolean;
  graphChecked: boolean;
  sweptAt: string;
  fromCache: boolean;
  occurrences: Occurrence[];
  counts: {
    total: number;
    imported: number;
    importable: number;
    bare: number;
    upcoming: number;
    external: number;
  };
}

interface SeriesDialogProps {
  seriesId: number | null;
  onClose: () => void;
  /** Membership/import changed — parents refresh their lists. */
  onChanged: () => void;
  /** This series was merged INTO targetSeriesId — hosts that can switch the
   * open dialog to the survivor pass this; otherwise the dialog just closes. */
  onMerged?: (targetSeriesId: number) => void;
}

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(new Date(iso).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const sweptAgo = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
};

const gapLabel = (ms: number) => {
  const days = ms / 86_400_000;
  if (days < 10) return `${Math.round(days)}d`;
  if (days < 60) return `${Math.round(days / 7)} wks`;
  return `${Math.round(days / 30)} mo`;
};

const durationLabel = (secs: number | null) => {
  if (!secs || secs <= 0) return null;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/** What each auto-import choice actually does — shown in the (i) popovers and
 * as the one-line "so this means…" under the selects. */
const MODE_INFO: Record<
  AutoImportCfg['mode'],
  { label: string; tag: string; detail: string }
> = {
  transcript: {
    label: 'Native transcript only',
    tag: 'fast, free, no audio',
    detail:
      'Takes the transcript Google Meet / Teams already wrote (real speaker names) and stores it as-is. Nothing is downloaded or re-transcribed — no AssemblyAI cost, but also no audio/video player, no voiceprint matching, and speakers are whatever Meet/Teams said.',
  },
  video: {
    label: 'Recording → re-transcribe',
    tag: 'download + AssemblyAI',
    detail:
      'Downloads the recording and runs our own pipeline: AssemblyAI transcription with acoustic speaker diarization + voiceprint matching, video playable in the app. Takes minutes and costs per audio-hour; the fix for pooled-room meetings where the native transcript lumps speakers.',
  },
  both: {
    label: 'Recording + native transcript',
    tag: 'download + AssemblyAI, keep native transcript',
    detail:
      'Same as "Recording → re-transcribe", plus the native Meet/Teams transcript is stored alongside as a cross-reference (helps name speakers). Wants both artifacts; if only one has appeared 12h after the meeting, it imports with just that one.',
  },
};

const REPORT_INFO: Record<AutoImportCfg['report'], { label: string; detail: string }> = {
  summary: {
    label: 'Quick summary',
    detail: 'Short notes — key points, decisions, action items. Cheapest and fastest.',
  },
  'detailed-text': {
    label: 'Detailed report',
    detail: 'Long wiki-style report with timestamped references, from the transcript text only.',
  },
  'detailed-video': {
    label: 'Detailed report + video frames',
    detail:
      'Detailed report that also pulls frames from the recording (slides, screen shares). Needs the video — with "Native transcript only" it falls back to the text-only report.',
  },
  later: {
    label: 'Nothing (decide later)',
    detail: 'Just import. You trigger notes yourself from the transcript page.',
  },
};

const MATCH_KIND_LABEL: Record<string, { label: string; strong: boolean }> = {
  'meeting-code': { label: 'same Meet link', strong: true },
  'recurring-base-id': { label: 'same calendar series', strong: true },
  'ical-uid-base': { label: 'same calendar series', strong: true },
  'teams-join-url': { label: 'same Teams meeting', strong: true },
  'graph-meeting-id': { label: 'same Teams meeting', strong: true },
  'normalized-title': { label: 'similar title only', strong: false },
};

/** Small (i) glyph that reveals a panel on hover/focus — the dialog has no
 * tooltip primitive and native `title` can't carry multi-line detail. */
function InfoHover({
  children,
  className = '',
  align = 'right',
  icon,
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  icon?: ReactNode;
}) {
  return (
    <span className={`group/info relative inline-flex ${className}`}>
      <button
        type="button"
        tabIndex={0}
        aria-label="Details"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {icon ?? <Info className="h-3.5 w-3.5" />}
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute top-full z-50 mt-1 w-72 rounded-md border bg-popover p-2.5 text-left text-[11px] leading-snug text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/info:visible group-hover/info:opacity-100 group-focus-within/info:visible group-focus-within/info:opacity-100 ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </span>
    </span>
  );
}

/** Label/value rows inside info panels and expanded occurrence rows. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

const fullWhen = (startIso: string, endIso: string | null) => {
  const start = new Date(startIso);
  const date = start.toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const t1 = timeLabel(startIso);
  const t2 = endIso ? timeLabel(endIso) : null;
  return t2 ? `${date}, ${t1}–${t2}` : `${date}, ${t1}`;
};

/**
 * Coverage dot-strip: one dot per occurrence, oldest → newest. Solid =
 * imported, ring = importable, hollow = no artifacts, dashed = upcoming; a
 * ⌇ marks a break in the series' own cadence (gap > 1.75× the median
 * inter-occurrence interval). Pure render over the sweep result — hidden
 * under 4 occurrences so 1-member stubs stay clean.
 */
function CoverageStrip({ occurrences }: { occurrences: Occurrence[] }) {
  if (occurrences.length < 4) return null;
  const chrono = [...occurrences].sort((a, b) => Date.parse(a.startIso) - Date.parse(b.startIso));
  const past = chrono.filter((o) => !o.upcoming);

  const gaps: number[] = [];
  for (let i = 1; i < past.length; i++) {
    gaps.push(Date.parse(past[i]!.startIso) - Date.parse(past[i - 1]!.startIso));
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)]! : 0;
  const isBreak = (gap: number) => median > 0 && gap > 1.75 * median;

  let longest = 0;
  let longestAt: string | null = null;
  for (let i = 1; i < past.length; i++) {
    const g = Date.parse(past[i]!.startIso) - Date.parse(past[i - 1]!.startIso);
    if (g > longest) {
      longest = g;
      longestAt = past[i - 1]!.startIso;
    }
  }

  const imported = past.filter((o) => o.imported.length > 0).length;
  const importable = past.filter(
    (o) => o.imported.length === 0 && (o.hasTranscript || o.hasRecording)
  ).length;

  const dotClass = (o: Occurrence) => {
    if (o.upcoming) return 'border border-dashed border-muted-foreground/50';
    if (o.imported.length > 0) return 'bg-status-ok';
    if (o.hasTranscript || o.hasRecording)
      return 'border-[1.5px] border-amber-500 dark:border-amber-400';
    return 'border border-muted-foreground/40';
  };
  const dotTitle = (o: Occurrence) => {
    const status = o.upcoming
      ? 'upcoming'
      : o.imported.length > 0
        ? 'imported'
        : o.hasTranscript || o.hasRecording
          ? 'importable'
          : 'no artifacts';
    return `${dateLabel(o.startIso)} · ${status}`;
  };
  const jumpTo = (key: string) =>
    document
      .getElementById(`series-occ-${key}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <div className="mb-1.5 rounded-lg border px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-y-1.5">
        {chrono.map((o, i) => {
          const gap = i > 0 ? Date.parse(o.startIso) - Date.parse(chrono[i - 1]!.startIso) : 0;
          return (
            <span key={o.key} className="flex items-center">
              {i > 0 && !o.upcoming && isBreak(gap) && (
                <span
                  className="mx-0.5 text-[10px] leading-none text-muted-foreground/60"
                  title={`${gapLabel(gap)} gap`}
                >
                  ⌇
                </span>
              )}
              <button
                type="button"
                className={`mx-[1.5px] h-2 w-2 shrink-0 rounded-full ${dotClass(o)}`}
                title={dotTitle(o)}
                onClick={() => jumpTo(o.key)}
              />
            </span>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {imported} of {past.length} imported
        {importable > 0 && <> · {importable} importable</>}
        {longestAt !== null && isBreak(longest) && (
          <>
            {' '}
            · longest gap {gapLabel(longest)} (
            {new Date(longestAt).toLocaleDateString([], { month: 'short' })})
          </>
        )}
      </p>
    </div>
  );
}

export function SeriesDialog({ seriesId, onClose, onChanged, onMerged }: SeriesDialogProps) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [occ, setOcc] = useState<OccurrencesResult | null>(null);
  const [occError, setOccError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(new Map());
  const [massProgress, setMassProgress] = useState<{ done: number; total: number } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargets, setMergeTargets] = useState<
    Array<{ id: number; title: string; member_count: number }> | null
  >(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const loadDetail = useCallback(async () => {
    if (!seriesId) return;
    const res = await fetch(`/api/series/${seriesId}`);
    if (res.ok) setDetail((await res.json()) as SeriesDetail);
  }, [seriesId]);

  const loadOccurrences = useCallback(
    async (forceRefresh = false) => {
      if (!seriesId) return;
      setOccError(false);
      try {
        const res = await fetch(
          `/api/series/${seriesId}/occurrences${forceRefresh ? '?refresh=1' : ''}`
        );
        if (!res.ok) throw new Error(String(res.status));
        setOcc((await res.json()) as OccurrencesResult);
      } catch {
        setOccError(true);
      }
    },
    [seriesId]
  );

  useEffect(() => {
    setDetail(null);
    setOcc(null);
    setImportErrors(new Map());
    setMassProgress(null);
    setMergeOpen(false);
    setMergeTargets(null);
    setMergeError(null);
    setExpanded(new Set());
    if (seriesId) {
      void loadDetail();
      void loadOccurrences();
    }
  }, [seriesId, loadDetail, loadOccurrences]);

  const refresh = useCallback(() => {
    void loadDetail();
    void loadOccurrences();
    onChanged();
  }, [loadDetail, loadOccurrences, onChanged]);

  // ---- membership actions -------------------------------------------------
  const confirmSuggestion = async (assemblyaiId: string) => {
    if (!seriesId) return;
    await fetch(`/api/series/${seriesId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptId: assemblyaiId, how: 'confirmed' }),
    });
    refresh();
  };
  const rejectSuggestion = async (assemblyaiId: string) => {
    if (!seriesId) return;
    await fetch(
      `/api/series/${seriesId}/members?transcriptId=${encodeURIComponent(assemblyaiId)}&remember=1`,
      { method: 'DELETE' }
    );
    refresh();
  };
  const removeMember = async (assemblyaiId: string) => {
    if (!seriesId) return;
    if (!confirm('Remove this meeting from the series? It won’t be suggested again.')) return;
    await fetch(
      `/api/series/${seriesId}/members?transcriptId=${encodeURIComponent(assemblyaiId)}&remember=1`,
      { method: 'DELETE' }
    );
    refresh();
  };
  const rename = async () => {
    if (!seriesId || !detail) return;
    const title = prompt('Series name', detail.series.title)?.trim();
    if (!title || title === detail.series.title) return;
    await fetch(`/api/series/${seriesId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    refresh();
  };
  // ---- auto-import config -------------------------------------------------
  // Optimistic + latest-wins: the UI flips instantly, one PATCH is in flight
  // at a time, and changes made while saving are coalesced into the next
  // PATCH instead of being dropped. The server's echo replaces local state
  // only when nothing newer is pending.
  const [autoSave, setAutoSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autoPendingRef = useRef<{
    enabled: boolean;
    mode: AutoImportCfg['mode'];
    report: AutoImportCfg['report'];
  } | null>(null);
  const autoInflightRef = useRef(false);
  const autoSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveAutoImport = async (patch: {
    enabled: boolean;
    mode?: AutoImportCfg['mode'];
    report?: AutoImportCfg['report'];
  }) => {
    if (!seriesId) return;
    const prev = detail?.series.auto_import ?? null;
    const next = {
      enabled: patch.enabled,
      mode: patch.mode ?? prev?.mode ?? 'both',
      report: patch.report ?? prev?.report ?? 'summary',
    };
    setDetail((d) =>
      d
        ? {
            ...d,
            series: {
              ...d.series,
              auto_import: {
                byUserId: '',
                byEmail: '',
                since: new Date().toISOString(),
                ...(d.series.auto_import ?? {}),
                ...next,
                lastError: null,
              },
            },
          }
        : d
    );
    autoPendingRef.current = next;
    if (autoInflightRef.current) return;
    autoInflightRef.current = true;
    if (autoSavedTimerRef.current) clearTimeout(autoSavedTimerRef.current);
    setAutoSave('saving');
    try {
      while (autoPendingRef.current) {
        const body = autoPendingRef.current;
        autoPendingRef.current = null;
        const res = await fetch(`/api/series/${seriesId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoImport: body }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { autoImport?: AutoImportCfg };
        if (j.autoImport && !autoPendingRef.current) {
          const cfg = j.autoImport;
          setDetail((d) => (d ? { ...d, series: { ...d.series, auto_import: cfg } } : d));
        }
      }
      setAutoSave('saved');
      autoSavedTimerRef.current = setTimeout(() => setAutoSave('idle'), 1800);
    } catch {
      setAutoSave('error');
      await loadDetail();
    } finally {
      autoInflightRef.current = false;
    }
  };

  const deleteSeries = async () => {
    if (!seriesId) return;
    if (!confirm('Delete this series? Transcripts are kept — only the grouping goes away.'))
      return;
    await fetch(`/api/series/${seriesId}`, { method: 'DELETE' });
    onChanged();
    onClose();
  };

  // ---- merging ------------------------------------------------------------
  const openMergePicker = async () => {
    setMergeOpen(true);
    setMergeError(null);
    if (mergeTargets === null) {
      const res = await fetch('/api/series');
      if (res.ok) {
        const j = (await res.json()) as {
          series: Array<{ id: number; title: string; member_count: number }>;
        };
        setMergeTargets(j.series.filter((s) => s.id !== seriesId));
      } else {
        setMergeTargets([]);
      }
    }
  };

  const mergeInto = async (target: { id: number; title: string; member_count: number }) => {
    if (!seriesId || !detail) return;
    const ok = confirm(
      `Merge "${detail.series.title}" (${detail.members.length} meeting${
        detail.members.length === 1 ? '' : 's'
      }) into "${target.title}" (${target.member_count})?\n\n` +
        `All meetings and matching rules move to "${target.title}", and ` +
        `"${detail.series.title}" is deleted. This cannot be undone.`
    );
    if (!ok) return;
    setMergeBusy(true);
    setMergeError(null);
    try {
      const res = await fetch(`/api/series/${target.id}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSeriesId: seriesId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Merge failed (${res.status})`);
      }
      onChanged();
      if (onMerged) onMerged(target.id);
      else onClose();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setMergeBusy(false);
    }
  };

  // ---- importing ----------------------------------------------------------
  const importOne = useCallback(
    async (o: Occurrence): Promise<string | null> => {
      const event = {
        id: o.eventId ?? undefined,
        title: o.title ?? undefined,
        startTime: o.startIso,
        endTime: o.endIso ?? new Date(Date.parse(o.startIso) + 2 * 3600_000).toISOString(),
        meetingCode: o.meetingCode ?? undefined,
        recurringEventId: o.recurringEventId ?? undefined,
        iCalUID: o.iCalUID ?? undefined,
        organizerEmail: o.organizerEmail ?? undefined,
        attendees: o.attendees,
      };
      try {
        let res: Response;
        if (o.teams) {
          res = await fetch('/api/teams/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: o.teams.joinWebUrl,
              mode: o.hasTranscript ? 'transcript' : 'video',
              // Still-processing artifacts queue; ready videos pull in the
              // background — either way this request returns in seconds.
              defer: true,
              background: true,
              event,
            }),
          });
        } else {
          const accessToken = await getGoogleAccessToken();
          res = await fetch('/api/gmeet/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessToken,
              mode: o.transcriptDocId ? 'transcript' : 'video',
              transcriptDocId: o.transcriptDocId ?? undefined,
              videoFileId: o.transcriptDocId ? undefined : (o.videoFileId ?? undefined),
              // Still-processing artifacts queue; ready videos pull in the
              // background — either way this request returns in seconds.
              defer: true,
              background: true,
              event,
            }),
          });
        }
        if (res.ok || res.status === 409) return null; // 409 = already imported
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        return j?.error ?? `Import failed (${res.status})`;
      } catch (err) {
        if (err instanceof GoogleNotConnectedError) {
          return 'Connect Google first (Import meeting → Connect), then retry.';
        }
        return err instanceof Error ? err.message : 'Import failed';
      }
    },
    []
  );

  const runImport = async (o: Occurrence) => {
    setBusyIds((prev) => new Set(prev).add(o.key));
    setImportErrors((prev) => {
      const next = new Map(prev);
      next.delete(o.key);
      return next;
    });
    const error = await importOne(o);
    if (error) {
      setImportErrors((prev) => new Map(prev).set(o.key, error));
    }
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(o.key);
      return next;
    });
    refresh();
  };

  const importable = useMemo(
    () =>
      (occ?.occurrences ?? []).filter(
        (o) => !o.upcoming && o.imported.length === 0 && (o.hasTranscript || o.hasRecording)
      ),
    [occ]
  );

  const runMassImport = async () => {
    const targets = importable;
    if (targets.length === 0) return;
    const videoOnly = targets.filter((t) => !t.hasTranscript && t.hasRecording).length;
    const msg =
      `Import ${targets.length} occurrence${targets.length === 1 ? '' : 's'}?\n\n` +
      `${targets.length - videoOnly} transcript import${targets.length - videoOnly === 1 ? '' : 's'} (fast, free)` +
      (videoOnly > 0
        ? `\n${videoOnly} video import${videoOnly === 1 ? '' : 's'} (slow — full download + transcription cost)`
        : '');
    if (!confirm(msg)) return;
    setMassProgress({ done: 0, total: targets.length });
    // Sequential on purpose: video imports are heavy, and the server dedupes
    // per occurrence — parallel calls would race the dedupe checks.
    for (let i = 0; i < targets.length; i++) {
      const error = await importOne(targets[i]!);
      if (error) setImportErrors((prev) => new Map(prev).set(targets[i]!.key, error));
      setMassProgress({ done: i + 1, total: targets.length });
    }
    setMassProgress(null);
    refresh();
  };

  // The sweep folds every member into the occurrence list (server side), so
  // this is only the fallback when the sweep itself failed: members must
  // still be visible + removable.
  const unmatchedMembers = useMemo(() => {
    if (!detail || !occError) return [];
    return detail.members;
  }, [detail, occError]);

  const open = seriesId !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Repeat className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 truncate">{detail?.series.title ?? 'Series'}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
              onClick={() => void rename()}
              title="Rename series"
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        {!detail ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* ---- guessed members ------------------------------------- */}
            {detail.suggestions.length > 0 && (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-2.5">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-primary/80">
                  Probably part of this series — confirm?
                </p>
                <p className="mb-1.5 text-[11px] text-muted-foreground">
                  Meetings you can see that look like this series but aren’t in any series yet.
                  ✓ adds it here, ✗ hides it for good.
                </p>
                <div className="space-y-1.5">
                  {detail.suggestions.map((s) => {
                    const when = s.recorded_at ?? s.event_start;
                    const kinds = [
                      ...new Map(
                        s.matched_kinds.map((k) => {
                          const m = MATCH_KIND_LABEL[k] ?? { label: k, strong: false };
                          return [m.label, m] as const;
                        })
                      ).values(),
                    ];
                    const weakOnly = kinds.every((k) => !k.strong);
                    const sourceLabel =
                      s.provider === 'teams'
                        ? 'Teams import'
                        : s.provider === 'gmeet'
                          ? s.assemblyai_id.startsWith('gmeet-')
                            ? 'Meet transcript import'
                            : 'Meet recording import'
                          : s.assemblyai_id.startsWith('ext-')
                            ? 'text import (no audio)'
                            : s.source === 'uploaded'
                              ? 'uploaded file'
                              : 'import';
                    return (
                      <div
                        key={s.transcript_id}
                        className="rounded-md border bg-background px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <a
                            href={`/transcript/${s.assemblyai_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-sm hover:text-primary"
                            title="Open this meeting (new tab)"
                          >
                            <span className="truncate">{s.title || 'Untitled meeting'}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                          </a>
                          {kinds.map((k) => (
                            <span
                              key={k.label}
                              className={`shrink-0 rounded-full px-1.5 py-px text-[10px] ${
                                k.strong
                                  ? 'bg-status-ok/10 text-status-ok'
                                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                              }`}
                              title={
                                k.strong
                                  ? 'Strong match — same underlying meeting identity'
                                  : 'Weak match — only the title looks alike; check before confirming'
                              }
                            >
                              {k.label}
                            </span>
                          ))}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 shrink-0 p-0 text-status-ok"
                            title="Yes, it belongs here"
                            onClick={() => void confirmSuggestion(s.assemblyai_id)}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 shrink-0 p-0 text-muted-foreground"
                            title="No — don't suggest again"
                            onClick={() => void rejectSuggestion(s.assemblyai_id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                          <span>
                            {when
                              ? `${dateLabel(when)} ${timeLabel(when)}`
                              : `added ${dateLabel(s.created_at)} · meeting date unknown`}
                          </span>
                          <span>·</span>
                          <span>{sourceLabel}</span>
                          {durationLabel(s.duration) && (
                            <>
                              <span>·</span>
                              <span>{durationLabel(s.duration)}</span>
                            </>
                          )}
                          {s.attendee_count > 0 && (
                            <>
                              <span>·</span>
                              <span>{s.attendee_count} invitees</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{s.owned ? 'yours' : 'shared with you'}</span>
                          {weakOnly && (
                            <>
                              <span>·</span>
                              <span className="text-amber-700 dark:text-amber-400">
                                title match only — open it to check
                              </span>
                            </>
                          )}
                          <InfoHover className="ml-auto" align="right">
                            <div className="space-y-1">
                              <DetailRow label="Title">{s.title || '—'}</DetailRow>
                              {s.event_title && s.event_title !== s.title && (
                                <DetailRow label="Calendar event">{s.event_title}</DetailRow>
                              )}
                              <DetailRow label="When">
                                {when ? fullWhen(when, null) : 'unknown (no calendar link)'}
                              </DetailRow>
                              <DetailRow label="Added">{fullWhen(s.created_at, null)}</DetailRow>
                              <DetailRow label="Source">{sourceLabel}</DetailRow>
                              {s.organizer_email && (
                                <DetailRow label="Organizer">{s.organizer_email}</DetailRow>
                              )}
                              <DetailRow label="Status">{s.status}</DetailRow>
                              <DetailRow label="Matched by">
                                {s.matched_kinds.join(', ')}
                              </DetailRow>
                              <DetailRow label="Id">
                                <span className="font-mono">{s.assemblyai_id}</span>
                              </DetailRow>
                            </div>
                          </InfoHover>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ---- auto-import ----------------------------------------- */}
            {(() => {
              const ai = detail.series.auto_import;
              const on = ai?.enabled ?? false;
              const mode = ai?.mode ?? 'both';
              const report = ai?.report ?? 'summary';
              return (
                <div
                  className={`rounded-lg border p-2.5 ${on ? 'border-blue-500/30 bg-blue-500/[0.04]' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <Zap
                      className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-blue-500' : 'text-muted-foreground'}`}
                    />
                    <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      Auto-import
                    </p>
                    {on && ai!.byEmail && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        as {ai!.byEmail}
                        {ai!.lastSweepAt ? ` · checked ${sweptAgo(ai!.lastSweepAt)}` : ''}
                      </span>
                    )}
                    <span className="ml-auto" />
                    {autoSave === 'saving' && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> saving
                      </span>
                    )}
                    {autoSave === 'saved' && (
                      <span className="flex items-center gap-1 text-[11px] text-status-ok">
                        <Check className="h-3 w-3" /> saved
                      </span>
                    )}
                    {autoSave === 'error' && (
                      <span className="text-[11px] text-destructive">couldn’t save — reloaded</span>
                    )}
                    <a
                      href="/settings#notifications"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Which Slack DMs you get (auto-import landed, review needed, …) — opens Settings in a new tab"
                    >
                      <Bell className="h-3 w-3" /> Notifications
                    </a>
                    <Button
                      size="sm"
                      variant={on ? 'outline' : 'default'}
                      className="h-6 px-2 text-xs"
                      onClick={() =>
                        void saveAutoImport({
                          enabled: !on,
                          mode: ai?.mode,
                          report: ai?.report,
                        })
                      }
                    >
                      {on ? 'Turn off' : 'Turn on'}
                    </Button>
                  </div>
                  {on ? (
                    <div className="mt-2 space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        <label className="flex items-center gap-1">
                          <span className="text-muted-foreground">Import</span>
                          <select
                            className="rounded border bg-background px-1 py-0.5 text-xs"
                            value={mode}
                            onChange={(e) =>
                              void saveAutoImport({
                                enabled: true,
                                mode: e.target.value as AutoImportCfg['mode'],
                                report,
                              })
                            }
                          >
                            {(Object.keys(MODE_INFO) as AutoImportCfg['mode'][]).map((m) => (
                              <option key={m} value={m}>
                                {MODE_INFO[m].label} ({MODE_INFO[m].tag})
                              </option>
                            ))}
                          </select>
                          <InfoHover align="right">
                            <p className="mb-1.5 font-medium">What each import option does</p>
                            <div className="space-y-1.5">
                              {(Object.keys(MODE_INFO) as AutoImportCfg['mode'][]).map((m) => (
                                <div key={m}>
                                  <span className={m === mode ? 'font-medium text-primary' : 'font-medium'}>
                                    {MODE_INFO[m].label}
                                  </span>
                                  <span className="text-muted-foreground"> · {MODE_INFO[m].tag}</span>
                                  <p className="text-muted-foreground">{MODE_INFO[m].detail}</p>
                                </div>
                              ))}
                            </div>
                          </InfoHover>
                        </label>
                        <label className="flex items-center gap-1">
                          <span className="text-muted-foreground">then generate</span>
                          <select
                            className="rounded border bg-background px-1 py-0.5 text-xs"
                            value={report}
                            onChange={(e) =>
                              void saveAutoImport({
                                enabled: true,
                                mode,
                                report: e.target.value as AutoImportCfg['report'],
                              })
                            }
                          >
                            {(Object.keys(REPORT_INFO) as AutoImportCfg['report'][]).map((r) => (
                              <option key={r} value={r}>
                                {REPORT_INFO[r].label}
                              </option>
                            ))}
                          </select>
                          <InfoHover align="left">
                            <p className="mb-1.5 font-medium">What gets generated after import</p>
                            <div className="space-y-1.5">
                              {(Object.keys(REPORT_INFO) as AutoImportCfg['report'][]).map((r) => (
                                <div key={r}>
                                  <span className={r === report ? 'font-medium text-primary' : 'font-medium'}>
                                    {REPORT_INFO[r].label}
                                  </span>
                                  <p className="text-muted-foreground">{REPORT_INFO[r].detail}</p>
                                </div>
                              ))}
                            </div>
                            <p className="mt-1.5 border-t pt-1.5 text-muted-foreground">
                              Anything but “Nothing” is gated on speakers: when every speaker is
                              identified with high confidence it runs unattended; otherwise you get a
                              Slack DM to review speakers first and it runs after you confirm.
                            </p>
                          </InfoHover>
                        </label>
                      </div>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        <span className="font-medium text-foreground/80">So:</span> every ~30 min we look
                        for new occurrences (from {dateLabel(ai!.since)} on).{' '}
                        {mode === 'transcript'
                          ? 'Each one is imported from the Meet/Teams transcript as-is — no download, no re-transcription.'
                          : mode === 'video'
                            ? 'Each one has its recording downloaded and re-transcribed by AssemblyAI (speaker diarization + voiceprints).'
                            : 'Each one has its recording downloaded and re-transcribed by AssemblyAI, with the Meet/Teams transcript kept alongside.'}{' '}
                        {report === 'later'
                          ? 'No notes are generated — you decide on the transcript page.'
                          : `Then the ${REPORT_INFO[report].label.toLowerCase()} is generated${
                              mode === 'transcript' && report === 'detailed-video'
                                ? ' (text-only, since no video is imported)'
                                : ''
                            } once speakers are confirmed — unattended if confidence is high, else you get a DM to review first.`}
                      </p>
                      {ai!.lastError && (
                        <p className="text-[11px] text-destructive">Last sweep problem: {ai!.lastError}</p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Import every new occurrence of this series automatically, with your chosen
                      report kind — you’ll be DMed as things land.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* ---- probable duplicate → one-click merge ---------------- */}
            {detail.dupes.length > 0 && !mergeOpen && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  Probably a duplicate
                </p>
                <div className="mt-1 space-y-1">
                  {detail.dupes.map((d) => {
                    const thisBigger = detail.members.length > d.member_count;
                    const sameName =
                      d.title.trim().toLowerCase() === detail.series.title.trim().toLowerCase();
                    const mine = detail.members.length;
                    const otherLast = d.last_recorded_at ? dateLabel(d.last_recorded_at) : null;
                    return (
                      <div key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="min-w-0">
                          {sameName ? (
                            <>
                              <span className="font-medium">Another series with the same name</span>{' '}
                              <span className="text-muted-foreground">
                                (#{d.id}, {d.member_count} meeting{d.member_count === 1 ? '' : 's'}
                                {otherLast ? `, last ${otherLast}` : ''}) is the {d.reason} as this one
                                ({mine} meeting{mine === 1 ? '' : 's'}).
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="font-medium">“{d.title}”</span>{' '}
                              <span className="text-muted-foreground">
                                ({d.member_count} meeting{d.member_count === 1 ? '' : 's'}
                                {otherLast ? `, last ${otherLast}` : ''}) is the {d.reason} as this one
                                ({mine} meeting{mine === 1 ? '' : 's'}).
                              </span>
                            </>
                          )}
                        </span>
                        <a
                          href={`/series?series=${d.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          title="Open the other series in a new tab to compare before merging"
                        >
                          View it <ExternalLink className="h-3 w-3" />
                        </a>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 border-amber-500/50 px-2 text-xs"
                          disabled={mergeBusy}
                          title={
                            thisBigger
                              ? `This series has more meetings — open “${d.title}” and merge it into this one instead, or merge anyway.`
                              : `Move this series’ ${detail.members.length} meeting${detail.members.length === 1 ? '' : 's'} and matching rules into “${d.title}” and delete this one`
                          }
                          onClick={() => void mergeInto(d)}
                        >
                          <Merge className="h-3 w-3" />
                          Merge this one into it
                        </Button>
                        {thisBigger && (
                          <span className="text-[11px] text-muted-foreground">
                            (this one is bigger — usually merge the smaller into the larger)
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {mergeError && <p className="pt-1 text-xs text-destructive">{mergeError}</p>}
              </div>
            )}

            {/* ---- occurrence sweep ------------------------------------ */}
            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Occurrences
                </p>
                {occ && (
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {occ.counts.imported} imported · {occ.counts.importable} importable ·{' '}
                    {occ.counts.bare} without artifacts
                    {occ.googleConnected && occ.counts.external === 0 && (
                      <span
                        className="text-amber-600 dark:text-amber-500"
                        title="Your Google Calendar has no instances of this meeting in the last 12 months (you may not be invited) — only imported copies are listed"
                      >
                        {' '}
                        · not on your calendar
                      </span>
                    )}
                    <span
                      className="text-muted-foreground/60"
                      title="Calendar + Teams sweep time — cached up to 6h; the refresh button re-sweeps"
                    >
                      {' '}
                      · swept {sweptAgo(occ.sweptAt)}
                    </span>
                  </span>
                )}
                <span className="ml-auto" />
                {massProgress ? (
                  <span className="flex items-center gap-1.5 text-xs text-primary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Importing {massProgress.done}/{massProgress.total}…
                  </span>
                ) : (
                  importable.length > 0 && (
                    <Button size="sm" className="h-6 px-2 text-xs" onClick={() => void runMassImport()}>
                      <Download className="h-3 w-3" />
                      Import all {importable.length}
                    </Button>
                  )
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title="Re-sweep calendar + Teams now (bypasses the 6h cache)"
                  onClick={() => {
                    setOcc(null);
                    void loadOccurrences(true);
                  }}
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>

              {occ && <CoverageStrip occurrences={occ.occurrences} />}

              {!occ && !occError ? (
                <div className="flex items-center gap-2 rounded-lg border py-4 pl-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Sweeping your calendar{detail ? ' and Microsoft 365' : ''} for every occurrence…
                </div>
              ) : occError ? (
                <div className="rounded-lg border py-4 text-center text-xs text-muted-foreground">
                  Couldn’t sweep occurrences.{' '}
                  <button className="text-primary underline" onClick={() => void loadOccurrences()}>
                    Retry
                  </button>
                </div>
              ) : occ && occ.occurrences.length === 0 ? (
                <div className="rounded-lg border py-4 text-center text-xs text-muted-foreground">
                  {occ.googleConnected
                    ? 'Nothing yet — no meetings imported into this series, and your Google Calendar has no instances of it in the last 12 months (occurrences come from your own calendar, so you may simply not be invited).'
                    : 'Connect Google (Import meeting → Connect) to sweep your calendar.'}
                </div>
              ) : (
                occ && (
                  <div className="divide-y rounded-lg border">
                    {occ.occurrences.map((o) => {
                      const busy = busyIds.has(o.key);
                      const error = importErrors.get(o.key);
                      const isOpen = expanded.has(o.key);
                      const seriesTitle = detail.series.title.trim().toLowerCase();
                      const ownTitle =
                        o.title && o.title.trim().toLowerCase() !== seriesTitle ? o.title : null;
                      const sourceLabel =
                        o.source === 'both'
                          ? 'Google Calendar + Microsoft Teams'
                          : o.source === 'graph'
                            ? 'Microsoft Teams (Graph)'
                            : o.source === 'imported'
                              ? 'Imported meeting only — not on your calendar'
                              : 'Google Calendar';
                      const accepted = o.attendees.filter((a) => a.responseStatus === 'accepted').length;
                      const driveUrl = o.videoFileId
                        ? `https://drive.google.com/file/d/${o.videoFileId}/view`
                        : null;
                      const docUrl = o.transcriptDocId
                        ? `https://docs.google.com/document/d/${o.transcriptDocId}/edit`
                        : null;
                      const status = o.upcoming
                        ? 'Upcoming — nothing to import yet.'
                        : o.imported.length > 0
                          ? 'Imported into this app.'
                          : o.hasTranscript || o.hasRecording
                            ? 'Has artifacts — not imported yet.'
                            : 'Meeting happened but Meet/Teams produced no recording or transcript (or they aren’t visible to you).';
                      return (
                        <div key={o.key} id={`series-occ-${o.key}`} className={isOpen ? 'bg-muted/30' : ''}>
                          <div
                            role="button"
                            tabIndex={0}
                            aria-expanded={isOpen}
                            onClick={() => toggleExpanded(o.key)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleExpanded(o.key);
                              }
                            }}
                            className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-muted/40"
                          >
                            <ChevronRight
                              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform ${
                                isOpen ? 'rotate-90' : ''
                              }`}
                            />
                            <span className="w-[6.5rem] shrink-0 text-xs tabular-nums text-muted-foreground">
                              {dateLabel(o.startIso)}
                            </span>
                            <span className="w-11 shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                              {timeLabel(o.startIso)}
                            </span>
                            <span className="flex min-w-0 flex-1 items-center gap-1.5">
                              {o.upcoming ? (
                                <Badge variant="outline" className="gap-1 text-[10px] text-muted-foreground">
                                  <CalendarClock className="h-3 w-3" /> upcoming
                                </Badge>
                              ) : (
                                <>
                                  {o.hasRecording && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary"
                                      title={
                                        o.teams
                                          ? 'Teams recording available'
                                          : 'Recording available on Drive'
                                      }
                                    >
                                      <Video className="h-3 w-3" /> recording
                                    </span>
                                  )}
                                  {o.hasTranscript && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary"
                                      title={
                                        o.teams
                                          ? 'Teams transcript available'
                                          : 'Meet transcript Doc available'
                                      }
                                    >
                                      <FileText className="h-3 w-3" /> transcript
                                    </span>
                                  )}
                                  {!o.hasRecording && !o.hasTranscript && o.imported.length === 0 && (
                                    <span
                                      className="text-[11px] text-muted-foreground/60"
                                      title="Meet/Teams didn’t produce (or you can’t see) a recording or transcript for this occurrence"
                                    >
                                      no recording or transcript
                                    </span>
                                  )}
                                  {o.source === 'imported' && (
                                    <span
                                      className="text-[11px] text-muted-foreground/60"
                                      title="This meeting isn’t on your calendar — occurrences are swept from your own Google Calendar / Teams, so only the imported copy is known"
                                    >
                                      not on your calendar
                                    </span>
                                  )}
                                </>
                              )}
                              {ownTitle && (
                                <span
                                  className="hidden truncate text-[11px] text-muted-foreground sm:inline"
                                  title={ownTitle}
                                >
                                  “{ownTitle}”
                                </span>
                              )}
                              {error && (
                                <span className="truncate text-[11px] text-destructive" title={error}>
                                  {error}
                                </span>
                              )}
                            </span>
                            <span
                              className="flex max-w-[60%] flex-wrap items-center justify-end gap-1"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {o.calendarUrl && (
                                <a
                                  href={o.calendarUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                                  title="Open this occurrence in Google Calendar (new tab)"
                                >
                                  <CalendarDays className="h-3.5 w-3.5" />
                                </a>
                              )}
                              {o.teams && !o.calendarUrl && (
                                <a
                                  href={o.teams.joinWebUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                                  title="Open the Teams meeting link (new tab)"
                                >
                                  <Link2 className="h-3.5 w-3.5" />
                                </a>
                              )}
                              <InfoHover align="right">
                                <div className="space-y-1">
                                  <DetailRow label="Event">{o.title || detail.series.title}</DetailRow>
                                  <DetailRow label="When">{fullWhen(o.startIso, o.endIso)}</DetailRow>
                                  <DetailRow label="Seen via">{sourceLabel}</DetailRow>
                                  {o.organizerEmail && (
                                    <DetailRow label="Organizer">{o.organizerEmail}</DetailRow>
                                  )}
                                  {o.attendees.length > 0 && (
                                    <DetailRow label="Invitees">
                                      {o.attendees.length}
                                      {accepted > 0 ? ` (${accepted} accepted)` : ''}
                                    </DetailRow>
                                  )}
                                  {o.meetingCode && (
                                    <DetailRow label="Meet code">
                                      <span className="font-mono">{o.meetingCode}</span>
                                    </DetailRow>
                                  )}
                                  <DetailRow label="Status">{status}</DetailRow>
                                  <p className="pt-1 text-muted-foreground/70">
                                    Click the row for attendees and links.
                                  </p>
                                </div>
                              </InfoHover>
                              {o.imported.length > 0 ? (
                                o.imported.map((imp) =>
                                  imp.accessible ? (
                                    <span key={imp.assemblyai_id} className="group/imp inline-flex items-center gap-0.5">
                                      <a
                                        href={`/transcript/${imp.assemblyai_id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 rounded-full bg-status-ok/10 px-2 py-0.5 text-[11px] text-status-ok hover:bg-status-ok/20"
                                        title={`${imp.title ?? 'Open transcript'} (new tab)`}
                                      >
                                        <Check className="h-3 w-3" /> imported
                                        <ExternalLink className="h-2.5 w-2.5" />
                                      </a>
                                      {detail.members.some((m) => m.assemblyai_id === imp.assemblyai_id) && (
                                        <button
                                          type="button"
                                          className="rounded p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-destructive group-hover/imp:opacity-100"
                                          title="Remove from series"
                                          onClick={() => void removeMember(imp.assemblyai_id)}
                                        >
                                          <X className="h-3 w-3" />
                                        </button>
                                      )}
                                    </span>
                                  ) : (
                                    <span
                                      key={imp.assemblyai_id}
                                      className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                                      title="Imported by a colleague (not shared with you)"
                                    >
                                      imported (not shared)
                                    </span>
                                  )
                                )
                              ) : !o.upcoming && (o.hasTranscript || o.hasRecording) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 px-2 text-xs"
                                  disabled={busy || massProgress !== null}
                                  onClick={() => void runImport(o)}
                                  title={
                                    o.hasTranscript
                                      ? 'Quick import the transcript'
                                      : 'Import the recording (download + transcription)'
                                  }
                                >
                                  {busy ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <Download className="h-3 w-3" />
                                  )}
                                  Import
                                </Button>
                              ) : null}
                            </span>
                          </div>
                          {isOpen && (
                            <div className="space-y-1 border-t border-dashed px-3 py-2 pl-9 text-[11px]">
                              <DetailRow label="Event">{o.title || detail.series.title}</DetailRow>
                              <DetailRow label="When">{fullWhen(o.startIso, o.endIso)}</DetailRow>
                              <DetailRow label="Seen via">{sourceLabel}</DetailRow>
                              {o.organizerEmail && (
                                <DetailRow label="Organizer">{o.organizerEmail}</DetailRow>
                              )}
                              {o.attendees.length > 0 && (
                                <DetailRow label="Invitees">
                                  <span className="inline-flex items-start gap-1">
                                    <Users className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
                                    <span>
                                      {o.attendees
                                        .map((a) =>
                                          a.name?.trim()
                                            ? `${a.name.trim()}${a.responseStatus === 'declined' ? ' (declined)' : ''}`
                                            : `${a.email}${a.responseStatus === 'declined' ? ' (declined)' : ''}`
                                        )
                                        .join(', ')}
                                    </span>
                                  </span>
                                </DetailRow>
                              )}
                              {o.meetingCode && (
                                <DetailRow label="Meet code">
                                  <span className="font-mono">{o.meetingCode}</span>
                                </DetailRow>
                              )}
                              <DetailRow label="Status">
                                {status}
                                {o.imported.length > 0 && (
                                  <>
                                    {' '}
                                    {o.imported.map((imp) =>
                                      imp.accessible ? (
                                        <a
                                          key={imp.assemblyai_id}
                                          href={`/transcript/${imp.assemblyai_id}`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="text-primary underline-offset-2 hover:underline"
                                        >
                                          {imp.title || imp.assemblyai_id} ↗
                                        </a>
                                      ) : (
                                        <span key={imp.assemblyai_id} className="text-muted-foreground">
                                          (a colleague’s import, not shared with you)
                                        </span>
                                      )
                                    )}
                                  </>
                                )}
                              </DetailRow>
                              {(o.calendarUrl || driveUrl || docUrl || o.teams) && (
                                <DetailRow label="Links">
                                  <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                                    {o.calendarUrl && (
                                      <a
                                        href={o.calendarUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                      >
                                        <CalendarDays className="h-3 w-3" /> Calendar event
                                      </a>
                                    )}
                                    {driveUrl && (
                                      <a
                                        href={driveUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                      >
                                        <Video className="h-3 w-3" /> Recording on Drive
                                      </a>
                                    )}
                                    {docUrl && (
                                      <a
                                        href={docUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                      >
                                        <FileText className="h-3 w-3" /> Meet transcript Doc
                                      </a>
                                    )}
                                    {o.teams && (
                                      <a
                                        href={o.teams.joinWebUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                      >
                                        <Link2 className="h-3 w-3" /> Teams meeting
                                      </a>
                                    )}
                                  </span>
                                </DetailRow>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>

            {/* ---- members without an occurrence row ------------------- */}
            {unmatchedMembers.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Meetings in this series
                </p>
                <div className="divide-y rounded-lg border">
                  {unmatchedMembers.map((m) => (
                    <div key={m.transcript_id} className="flex items-center gap-2 px-2.5 py-1.5">
                      <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {dateLabel(m.recorded_at ?? m.created_at)}
                      </span>
                      {m.accessible ? (
                        <a
                          href={`/transcript/${m.assemblyai_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`${m.title || 'Untitled meeting'} (new tab)`}
                          className="min-w-0 flex-1 truncate text-left text-sm hover:text-primary"
                        >
                          {m.title || 'Untitled meeting'}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {m.title || 'Untitled meeting'}{' '}
                          <span className="text-[11px]">(not shared with you)</span>
                        </span>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                        title="Remove from series"
                        onClick={() => void removeMember(m.assemblyai_id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ---- merge picker ---------------------------------------- */}
            {mergeOpen && (
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-2.5">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-primary/80">
                  Merge “{detail.series.title}” into…
                </p>
                {mergeTargets === null ? (
                  <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading series…
                  </div>
                ) : mergeTargets.length === 0 ? (
                  <p className="py-1 text-xs text-muted-foreground">No other series to merge into.</p>
                ) : (
                  <div className="max-h-48 space-y-0.5 overflow-y-auto">
                    {mergeTargets.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        disabled={mergeBusy}
                        onClick={() => void mergeInto(t)}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                      >
                        <Repeat className="h-3 w-3 shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {t.member_count}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {mergeBusy && (
                  <div className="flex items-center gap-2 pt-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Merging…
                  </div>
                )}
                {mergeError && <p className="pt-1.5 text-xs text-destructive">{mergeError}</p>}
              </div>
            )}

            {/* ---- footer ---------------------------------------------- */}
            <div className="flex items-center justify-between border-t pt-3">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => void deleteSeries()}
                >
                  <Trash2 className="h-3 w-3" />
                  Delete series
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  title="Fold this series into another one (dupe repair)"
                  onClick={() => (mergeOpen ? setMergeOpen(false) : void openMergePicker())}
                >
                  <Merge className="h-3 w-3" />
                  Merge…
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">
                {detail.members.length} meeting{detail.members.length === 1 ? '' : 's'} in this
                series
              </span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

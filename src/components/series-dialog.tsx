'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Merge,
} from 'lucide-react';

/**
 * The series view: confirmed members, guessed members awaiting a yes/no, and
 * the live occurrence sweep (calendar + Graph) with per-occurrence and mass
 * import. Occurrences are computed server-side on every open — nothing about
 * them is persisted.
 */

interface SeriesDetail {
  series: { id: number; title: string; notes: string | null };
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
  }>;
}

interface Occurrence {
  key: string;
  startIso: string;
  endIso: string | null;
  title: string | null;
  source: 'calendar' | 'graph' | 'both';
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
  imported: Array<{ assemblyai_id: string; title: string | null; accessible: boolean }>;
}

interface OccurrencesResult {
  googleConnected: boolean;
  graphChecked: boolean;
  sweptAt: string;
  fromCache: boolean;
  occurrences: Occurrence[];
  counts: { total: number; imported: number; importable: number; bare: number; upcoming: number };
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

  // Members that no occurrence row links to (outside the sweep window, or
  // key-less manual adds) still need to be visible + removable.
  const unmatchedMembers = useMemo(() => {
    if (!detail) return [];
    const linked = new Set(
      (occ?.occurrences ?? []).flatMap((o) => o.imported.map((i) => i.assemblyai_id))
    );
    return detail.members.filter((m) => !linked.has(m.assemblyai_id));
  }, [detail, occ]);

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
                <div className="space-y-1">
                  {detail.suggestions.map((s) => (
                    <div key={s.transcript_id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {s.title || 'Untitled meeting'}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {dateLabel(s.recorded_at ?? s.created_at)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-status-ok"
                        title="Yes, it belongs here"
                        onClick={() => void confirmSuggestion(s.assemblyai_id)}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground"
                        title="No — don't suggest again"
                        onClick={() => void rejectSuggestion(s.assemblyai_id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
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
                    ? 'No occurrences found in the last 12 months.'
                    : 'Connect Google (Import meeting → Connect) to sweep your calendar.'}
                </div>
              ) : (
                occ && (
                  <div className="divide-y rounded-lg border">
                    {occ.occurrences.map((o) => {
                      const busy = busyIds.has(o.key);
                      const error = importErrors.get(o.key);
                      return (
                        <div
                          key={o.key}
                          id={`series-occ-${o.key}`}
                          className="flex items-center gap-2 px-2.5 py-1.5"
                        >
                          <span className="w-28 shrink-0 text-xs tabular-nums text-muted-foreground">
                            {dateLabel(o.startIso)}
                          </span>
                          <span className="w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
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
                                  <span title="Recording available">
                                    <Video className="h-3.5 w-3.5 text-primary/70" />
                                  </span>
                                )}
                                {o.hasTranscript && (
                                  <span title="Transcript available">
                                    <FileText className="h-3.5 w-3.5 text-primary/70" />
                                  </span>
                                )}
                                {!o.hasRecording && !o.hasTranscript && (
                                  <span className="text-[11px] text-muted-foreground/60">
                                    no recording or transcript
                                  </span>
                                )}
                              </>
                            )}
                            {error && (
                              <span className="truncate text-[11px] text-destructive" title={error}>
                                {error}
                              </span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1">
                            {o.imported.length > 0 ? (
                              o.imported.map((imp) =>
                                imp.accessible ? (
                                  <span key={imp.assemblyai_id} className="group/imp inline-flex items-center gap-0.5">
                                    <a
                                      href={`/transcript/${imp.assemblyai_id}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      onClick={(e) => e.stopPropagation()}
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
                  Also in this series
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

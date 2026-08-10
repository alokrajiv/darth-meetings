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

export function SeriesDialog({ seriesId, onClose, onChanged }: SeriesDialogProps) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [occ, setOcc] = useState<OccurrencesResult | null>(null);
  const [occError, setOccError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [importErrors, setImportErrors] = useState<Map<string, string>>(new Map());
  const [massProgress, setMassProgress] = useState<{ done: number; total: number } | null>(null);

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
                        <div key={o.key} className="flex items-center gap-2 px-2.5 py-1.5">
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

            {/* ---- footer ---------------------------------------------- */}
            <div className="flex items-center justify-between border-t pt-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => void deleteSeries()}
              >
                <Trash2 className="h-3 w-3" />
                Delete series
              </Button>
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

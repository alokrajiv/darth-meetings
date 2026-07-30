'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  formatDuration,
  formatSmartDate,
  type TranscriptListRow,
} from '@/lib/format';
import {
  Trash2,
  RefreshCw,
  FileAudio,
  FileText,
  Video,
  Search,
  ChevronRight,
  Inbox,
} from 'lucide-react';

interface TranscriptTableProps {
  refreshTrigger?: number;
}

type TabKey = 'all' | 'mine' | 'shared';

const RESTING_SHADOW = 'shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]';

export function TranscriptTable({ refreshTrigger }: TranscriptTableProps) {
  const router = useRouter();
  const [transcripts, setTranscripts] = useState<TranscriptListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const loadTranscripts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/transcripts', { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`Failed to load transcripts (${res.status})`);
      }
      const { transcripts } = (await res.json()) as { transcripts: TranscriptListRow[] };
      setTranscripts(transcripts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcripts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTranscripts();
  }, [loadTranscripts, refreshTrigger]);

  // Global `/` focuses the search input when no other field has focus.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const counts = useMemo(() => {
    return {
      all: transcripts.length,
      mine: transcripts.filter((t) => t.access === 'owner').length,
      shared: transcripts.filter((t) => t.access !== 'owner').length,
    };
  }, [transcripts]);

  const filtered = useMemo(() => {
    let rows = transcripts;
    if (tab === 'mine') rows = rows.filter((t) => t.access === 'owner');
    else if (tab === 'shared') rows = rows.filter((t) => t.access !== 'owner');
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((t) =>
        [t.title, t.original_filename, t.owner_name, t.owner_email].some((v) =>
          v?.toLowerCase().includes(q)
        )
      );
    }
    return rows;
  }, [transcripts, tab, query]);

  const handleDeleteTranscript = async (e: React.MouseEvent, assemblyaiId: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this transcript?')) return;

    try {
      const res = await fetch(`/api/transcripts/${assemblyaiId}`, { method: 'DELETE' });
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText);
        throw new Error(detail || `Delete failed (${res.status})`);
      }
      setTranscripts((prev) => prev.filter((t) => t.assemblyai_id !== assemblyaiId));
    } catch (err) {
      alert('Failed to delete transcript: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const statusDot = (status: string) => {
    const base = 'inline-flex h-2 w-2 shrink-0 rounded-full';
    switch (status) {
      case 'completed':
        return <span className={`${base} bg-status-ok`} aria-label="Completed" />;
      case 'processing':
        return <span className={`${base} bg-status-busy animate-pulse`} aria-label="Processing" />;
      case 'queued':
        return <span className={`${base} bg-muted-foreground/40`} aria-label="Queued" />;
      case 'error':
        return <span className={`${base} bg-status-err`} aria-label="Error" />;
      default:
        return <span className={`${base} bg-muted-foreground/40`} aria-label={status} />;
    }
  };

  const sourceIcon = (t: TranscriptListRow) => {
    if (t.assemblyai_id.startsWith('gmeet-')) {
      return (
        <span title="Google Meet" className="shrink-0">
          <Video className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      );
    }
    if (t.source === 'uploaded') {
      return (
        <span title="Uploaded audio" className="shrink-0">
          <FileAudio className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      );
    }
    return (
      <span title="Imported transcript" className="shrink-0">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    );
  };

  const ownerCell = (t: TranscriptListRow) => {
    if (t.access === 'owner') {
      return <span className="text-xs text-muted-foreground">You</span>;
    }
    const first = t.owner_name?.trim().split(/\s+/)[0] || t.owner_email || '—';
    return (
      <span className="flex items-center gap-1.5">
        <span className="truncate text-xs text-muted-foreground">{first}</span>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t.access === 'edit' ? 'Editor' : 'Read'}
        </Badge>
      </span>
    );
  };

  const titleOf = (
    t: TranscriptListRow
  ): { primary: string; secondary: string | null; untitled: boolean } => {
    if (t.title && t.title.trim().length > 0) {
      return { primary: t.title, secondary: t.original_filename || null, untitled: false };
    }
    if (t.original_filename) {
      return { primary: t.original_filename, secondary: null, untitled: false };
    }
    return { primary: 'Untitled meeting', secondary: null, untitled: true };
  };

  const tabButton = (key: TabKey, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`relative px-2.5 pb-2.5 pt-1 text-sm transition-colors ${
        tab === key
          ? 'font-medium text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
        {count}
      </span>
    </button>
  );

  const toolbar = (
    <div className="mb-3 flex items-center gap-3 border-b">
      <div className="flex items-center">
        {tabButton('all', 'All', counts.all)}
        {tabButton('mine', 'Mine', counts.mine)}
        {tabButton('shared', 'Shared', counts.shared)}
      </div>
      <div className="ml-auto flex items-center gap-1.5 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search meetings…"
            className="h-8 w-64 pl-8 pr-8"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
            /
          </kbd>
        </div>
        <Button
          onClick={loadTranscripts}
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
          <span className="sr-only">Refresh</span>
        </Button>
      </div>
    </div>
  );

  const emptyState = (
    icon: React.ReactNode,
    headline: string,
    sub: string | null
  ) => (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">{icon}</div>
      <p className="mt-3 text-sm font-medium">{headline}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );

  const container = (children: React.ReactNode) => (
    <div className={`overflow-hidden rounded-lg border bg-card ${RESTING_SHADOW}`}>
      {children}
    </div>
  );

  if (loading) {
    return (
      <div>
        {toolbar}
        {container(
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div>
        {toolbar}
        {container(
          <div className="flex flex-col items-center py-16 text-center">
            <p className="text-sm font-medium">Couldn&apos;t load transcripts</p>
            <p className="mt-1 text-xs text-destructive">{error}</p>
            <Button onClick={loadTranscripts} variant="outline" size="sm" className="mt-4">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }

  const searchEmpty = filtered.length === 0 && query.trim().length > 0;

  return (
    <div>
      {toolbar}
      {container(
        filtered.length === 0 ? (
          searchEmpty ? (
            emptyState(
              <Search className="h-5 w-5 text-muted-foreground" />,
              `No matches for "${query.trim()}"`,
              'Try a different title, filename, or owner.'
            )
          ) : tab === 'shared' ? (
            emptyState(
              <Inbox className="h-5 w-5 text-muted-foreground" />,
              'Nothing shared with you yet',
              'Transcripts colleagues share will show up here.'
            )
          ) : tab === 'mine' ? (
            emptyState(
              <FileAudio className="h-5 w-5 text-muted-foreground" />,
              'You haven’t uploaded or imported anything yet',
              'Drop an audio or video file above to get started.'
            )
          ) : (
            emptyState(
              <FileAudio className="h-5 w-5 text-muted-foreground" />,
              'No transcripts yet',
              'Drop an audio or video file above to get started.'
            )
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Title
                </TableHead>
                <TableHead className="hidden h-9 w-[16%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:table-cell">
                  Owner
                </TableHead>
                <TableHead className="hidden h-9 w-[14%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:table-cell">
                  Date
                </TableHead>
                <TableHead className="hidden h-9 w-[11%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:table-cell">
                  Duration
                </TableHead>
                <TableHead className="hidden h-9 w-[9%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground lg:table-cell">
                  Speakers
                </TableHead>
                <TableHead className="h-9 w-[72px] bg-muted/50">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const { primary, secondary, untitled } = titleOf(t);
                const disabled = t.status !== 'completed';
                const processing = t.status === 'processing';
                return (
                  <TableRow
                    key={t.id}
                    onClick={() => !disabled && router.push(`/transcript/${t.assemblyai_id}`)}
                    className={`group transition-colors hover:bg-accent/40 ${
                      disabled ? 'opacity-60' : 'cursor-pointer'
                    }`}
                  >
                    <TableCell className="py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        {statusDot(t.status)}
                        {sourceIcon(t)}
                        <div className="min-w-0 flex-1">
                          <div
                            className={`truncate text-sm font-medium ${
                              untitled ? 'italic text-muted-foreground' : ''
                            } ${processing ? 'text-shimmer' : ''}`}
                          >
                            {primary}
                          </div>
                          {processing ? (
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              transcribing…
                            </div>
                          ) : (
                            secondary && (
                              <div className="truncate text-xs text-muted-foreground">
                                {secondary}
                              </div>
                            )
                          )}
                        </div>
                        {t.status === 'error' && (
                          <Badge
                            variant="outline"
                            className="shrink-0 border-destructive/40 text-[10px] text-destructive"
                          >
                            Failed
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden py-2.5 lg:table-cell">
                      {ownerCell(t)}
                    </TableCell>
                    <TableCell className="hidden py-2.5 text-xs text-muted-foreground md:table-cell">
                      <span title={new Date(t.recorded_at ?? t.created_at).toLocaleString()}>
                        {formatSmartDate(t.recorded_at ?? t.created_at) || 'Unknown'}
                      </span>
                    </TableCell>
                    <TableCell className="hidden py-2.5 font-mono text-[11px] tabular-nums text-muted-foreground sm:table-cell">
                      {t.duration ? formatDuration(t.duration) : '—'}
                    </TableCell>
                    <TableCell className="hidden py-2.5 text-xs tabular-nums text-muted-foreground lg:table-cell">
                      {t.speaker_count ?? '—'}
                    </TableCell>
                    <TableCell className="py-2.5 pr-3">
                      <div className="flex items-center justify-end gap-0.5">
                        {t.access === 'owner' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                            onClick={(e) => handleDeleteTranscript(e, t.assemblyai_id)}
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {!disabled && (
                          <span className="grid h-7 w-7 place-items-center">
                            <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )
      )}
    </div>
  );
}

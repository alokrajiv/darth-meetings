'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  formatDuration,
  type TranscriptListRow,
} from '@/lib/format';
import { Trash2, RefreshCw, Users, Clock, FileAudio } from 'lucide-react';

interface TranscriptTableProps {
  refreshTrigger?: number;
}

type TabKey = 'all' | 'mine' | 'shared';

export function TranscriptTable({ refreshTrigger }: TranscriptTableProps) {
  const router = useRouter();
  const [transcripts, setTranscripts] = useState<TranscriptListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('all');

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

  const counts = useMemo(() => {
    return {
      all: transcripts.length,
      mine: transcripts.filter((t) => t.access === 'owner').length,
      shared: transcripts.filter((t) => t.access !== 'owner').length,
    };
  }, [transcripts]);

  const filtered = useMemo(() => {
    if (tab === 'mine') return transcripts.filter((t) => t.access === 'owner');
    if (tab === 'shared') return transcripts.filter((t) => t.access !== 'owner');
    return transcripts;
  }, [transcripts, tab]);

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

  const statusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return (
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-green-500" aria-label="Completed" />
        );
      case 'processing':
        return (
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-label="Processing" />
        );
      case 'queued':
        return (
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-slate-400" aria-label="Queued" />
        );
      case 'error':
        return (
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-red-500" aria-label="Error" />
        );
      default:
        return (
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-slate-300" aria-label={status} />
        );
    }
  };

  const accessBadge = (access: TranscriptListRow['access']) => {
    if (access === 'owner') return null;
    return (
      <Badge variant="outline" className="text-[10px]">
        <Users className="h-3 w-3 mr-1" />
        {access === 'edit' ? 'Shared · Editor' : 'Shared · Read'}
      </Badge>
    );
  };

  const tabButton = (key: TabKey, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`rounded-md px-3 py-1 text-xs transition-colors ${
        tab === key
          ? 'bg-muted font-medium'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
      <span className="ml-1 text-[10px] text-muted-foreground">{count}</span>
    </button>
  );

  const formatRelativeDate = (value: string) => {
    try {
      const date = new Date(value);
      if (isNaN(date.getTime())) return 'Unknown';
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return 'Unknown';
    }
  };

  const titleOf = (t: TranscriptListRow): { primary: string; secondary: string | null } => {
    if (t.title && t.title.trim().length > 0) {
      return { primary: t.title, secondary: t.original_filename || null };
    }
    if (t.original_filename) {
      return { primary: t.original_filename, secondary: null };
    }
    return { primary: 'Untitled transcript', secondary: null };
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Transcripts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Error loading transcripts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-500 mb-4 text-sm">{error}</p>
          <Button onClick={loadTranscripts} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Your Transcripts</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-md border bg-background p-0.5">
              {tabButton('all', 'All', counts.all)}
              {tabButton('mine', 'Mine', counts.mine)}
              {tabButton('shared', 'Shared', counts.shared)}
            </div>
            <Button onClick={loadTranscripts} variant="outline" size="sm" title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            {tab === 'shared'
              ? 'Nothing has been shared with you yet.'
              : tab === 'mine'
                ? 'You haven\u2019t uploaded or imported anything yet.'
                : 'No transcripts yet. Drop an audio or video file above to get started.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Title</TableHead>
                <TableHead className="hidden md:table-cell w-[20%]">Created</TableHead>
                <TableHead className="hidden sm:table-cell w-[15%]">Duration</TableHead>
                <TableHead className="hidden lg:table-cell w-[12%]">Speakers</TableHead>
                <TableHead className="w-[60px] text-right pr-4">&nbsp;</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t) => {
                const { primary, secondary } = titleOf(t);
                const disabled = t.status !== 'completed';
                return (
                  <TableRow
                    key={t.id}
                    onClick={() => !disabled && router.push(`/transcript/${t.assemblyai_id}`)}
                    className={`group ${disabled ? 'opacity-60' : 'cursor-pointer'}`}
                  >
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-2 min-w-0">
                        {statusBadge(t.status)}
                        <FileAudio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{primary}</div>
                          {secondary && (
                            <div className="truncate text-[11px] text-muted-foreground">{secondary}</div>
                          )}
                          {/* Inline meta visible only on small screens (where the
                              dedicated columns are hidden). */}
                          <div className="md:hidden mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                            <span>{formatRelativeDate(t.created_at)}</span>
                            {t.duration && (
                              <>
                                <span className="opacity-50">·</span>
                                <span className="inline-flex items-center gap-0.5">
                                  <Clock className="h-2.5 w-2.5" />
                                  {formatDuration(t.duration)}
                                </span>
                              </>
                            )}
                            {t.speaker_count != null && (
                              <>
                                <span className="opacity-50">·</span>
                                <span>{t.speaker_count} spkr</span>
                              </>
                            )}
                          </div>
                        </div>
                        {accessBadge(t.access)}
                        {t.status !== 'completed' && (
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {t.status}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell py-2.5 text-xs text-muted-foreground">
                      {formatRelativeDate(t.created_at)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell py-2.5 text-xs text-muted-foreground">
                      {t.duration ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(t.duration)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell py-2.5 text-xs text-muted-foreground">
                      {t.speaker_count ?? '—'}
                    </TableCell>
                    <TableCell className="py-2.5 text-right pr-4">
                      {t.access === 'owner' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-600"
                          onClick={(e) => handleDeleteTranscript(e, t.assemblyai_id)}
                          title="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

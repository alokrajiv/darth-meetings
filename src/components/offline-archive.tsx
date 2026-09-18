'use client';

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CloudOff, FileText, Headphones, Loader2, Search, Video, CircleAlert } from 'lucide-react';
import { useOffline } from '@/lib/offline/offline-context';
import { levelIncludes } from '@/lib/offline/offline-urls';
import type { PinRecord } from '@/lib/offline/offline-types';
import { formatDuration } from '@/lib/format';

/**
 * The meetings listing while offline mode is on: only what this device
 * holds, read from the pin ledger (IndexedDB), no network at all. Same
 * day-bucket shape as the main listing so the switch feels like a filter,
 * not a different app. Rows navigate to /transcript/<id>, which the service
 * worker serves from the pages cache.
 */

/** "Today" / "Yesterday" / weekday / "Tue, 4 Aug" / "4 Aug 2025" — mirrors
 * the main listing's day headings. */
function dayHeading(d: Date): { label: string; sub: string | null } {
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round((startOfDay(now).getTime() - startOfDay(d).getTime()) / 86_400_000);
  const shortDate = d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  if (dayDiff === 0) return { label: 'Today', sub: shortDate };
  if (dayDiff === 1) return { label: 'Yesterday', sub: shortDate };
  if (dayDiff > 1 && dayDiff < 7) return { label: d.toLocaleDateString([], { weekday: 'long' }), sub: shortDate };
  if (d.getFullYear() === now.getFullYear()) {
    return { label: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), sub: null };
  }
  return { label: d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }), sub: null };
}

interface DayGroup {
  key: string;
  heading: string;
  sub: string | null;
  rows: PinRecord[];
  totalSecs: number;
}

function groupByDay(rows: PinRecord[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const r of rows) {
    const d = new Date(r.recordedAt ?? r.pinnedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = groups.get(key);
    if (!g) {
      const h = dayHeading(d);
      g = { key, heading: h.label, sub: h.sub, rows: [], totalSecs: 0 };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.totalSecs += r.durationSec ?? 0;
  }
  return [...groups.values()];
}

function LevelChip({ on, icon, label }: { on: boolean; icon: ReactNode; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${
        on ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-transparent text-muted-foreground/50'
      }`}
      title={on ? `${label} saved on this device` : `${label} not saved`}
    >
      {icon}
      {label}
    </span>
  );
}

export function OfflineArchive({ className = '' }: { className?: string }) {
  const { pins } = useOffline();
  const [q, setQ] = useState('');

  // Tombstones (level 'none') are exclusions, not content. Ledger order is
  // already newest-first (listPins), which is what the day buckets need.
  const saved = useMemo(() => pins.filter((p) => p.level !== 'none'), [pins]);
  // The headline counts what is actually READABLE now; rows still
  // downloading (or that failed) are called out separately instead of
  // being folded into "N meetings saved".
  const tally = useMemo(() => {
    let ready = 0;
    let saving = 0;
    let failed = 0;
    for (const p of saved) {
      if (p.status === 'ready') ready += 1;
      else if (p.status === 'pending') saving += 1;
      else failed += 1;
    }
    return { ready, saving, failed };
  }, [saved]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return saved;
    return saved.filter((p) => (p.title ?? '').toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle));
  }, [saved, q]);
  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  return (
    <div className={className} data-offline-archive>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search saved meetings by title"
            className="h-8 pl-8"
            aria-label="Search saved meetings"
          />
        </div>
        <span className="text-xs text-muted-foreground" data-offline-archive-count>
          {tally.ready} meeting{tally.ready === 1 ? '' : 's'} saved on this device
          {tally.saving > 0 && (
            <span className="ml-1.5 inline-flex items-center gap-1" title="Still downloading — readable once the row shows no spinner">
              <Loader2 className="h-3 w-3 animate-spin" />+ {tally.saving} saving
            </span>
          )}
          {tally.failed > 0 && (
            <span className="ml-1.5 text-destructive" title="Download failed — retried on the next sync">
              · {tally.failed} failed
            </span>
          )}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        {saved.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <CloudOff className="h-5 w-5 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">Nothing saved on this device yet</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              When you’re online, open a meeting and choose “Save offline”, or set how many recent
              meetings to keep automatically under Settings › Offline.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Search className="h-5 w-5 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">No saved meetings match “{q.trim()}”</p>
            <p className="mt-1 text-xs text-muted-foreground">Only titles are searchable while offline.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 w-[96px] bg-muted/50 pl-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Time
                </TableHead>
                <TableHead className="h-9 bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Title
                </TableHead>
                <TableHead className="hidden h-9 w-[90px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:table-cell">
                  Length
                </TableHead>
                <TableHead className="h-9 w-[220px] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Saved
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="bg-muted/40 py-1.5 pl-4">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">{g.heading}</span>
                      {g.sub && <span className="ml-1.5 text-[11px] text-muted-foreground/70">{g.sub}</span>}
                      <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                        {g.rows.length} meeting{g.rows.length === 1 ? '' : 's'}
                        {g.totalSecs > 0 ? ` · ${formatDuration(g.totalSecs)}` : ''}
                      </span>
                    </TableCell>
                  </TableRow>
                  {g.rows.map((r) => {
                    const when = r.recordedAt ? new Date(r.recordedAt) : null;
                    const href = `/transcript/${encodeURIComponent(r.id)}`;
                    return (
                      <TableRow key={r.id} className="cursor-pointer">
                        <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground">
                          <Link href={href} prefetch={false} className="block">
                            {when ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                          </Link>
                        </TableCell>
                        <TableCell className="max-w-0">
                          <Link href={href} prefetch={false} className="block truncate text-sm font-medium hover:underline underline-offset-2">
                            {r.title || 'Untitled meeting'}
                          </Link>
                        </TableCell>
                        <TableCell className="hidden text-xs tabular-nums text-muted-foreground sm:table-cell">
                          {r.durationSec ? formatDuration(r.durationSec) : '—'}
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1">
                            <LevelChip on={levelIncludes(r.level, 'transcript')} icon={<FileText className="h-3 w-3" />} label="Transcript" />
                            <LevelChip on={levelIncludes(r.level, 'audio')} icon={<Headphones className="h-3 w-3" />} label="Audio" />
                            <LevelChip on={levelIncludes(r.level, 'video')} icon={<Video className="h-3 w-3" />} label="Video" />
                            {r.status === 'pending' && (
                              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="Still saving" />
                            )}
                            {r.status === 'error' && (
                              <CircleAlert className="h-3 w-3 text-destructive" aria-label={r.error ? `Save failed: ${r.error}` : 'Save failed'} />
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

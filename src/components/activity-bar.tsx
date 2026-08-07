'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  Eye,
  Pencil,
  Search,
  Type,
  Settings2,
  UserPlus,
  UserMinus,
  ShieldCheck,
  Crown,
} from 'lucide-react';

export type ActivityAction =
  | 'view'
  | 'edit_text'
  | 'find_replace'
  | 'edit_speakers'
  | 'edit_meta'
  | 'share_add'
  | 'share_update'
  | 'share_remove'
  | 'owner_transfer'
  | 'generate_notes'
  | 'set_notes'
  | 'set_report';

export interface ActivityRow {
  id: number;
  transcript_id: number;
  user_id: string;
  user_email: string;
  user_name: string | null;
  action: ActivityAction;
  details: Record<string, unknown> | null;
  at: string;
}

export interface ActivityViewer {
  user_id: string;
  user_email: string;
  user_name: string | null;
  last_viewed_at: string;
}

export interface ActivitySummary {
  events: ActivityRow[];
  lastEdit: ActivityRow | null;
  recentViewers: ActivityViewer[];
}

interface ActivityBarProps {
  transcriptId: string;
  /** Bumped by the parent after a save so the bar refetches. */
  refreshSignal: number;
}

const AVATAR_PALETTE = [
  'bg-rose-200 text-rose-900 dark:bg-rose-900 dark:text-rose-200',
  'bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-200',
  'bg-lime-200 text-lime-900 dark:bg-lime-900 dark:text-lime-200',
  'bg-emerald-200 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-200',
  'bg-cyan-200 text-cyan-900 dark:bg-cyan-900 dark:text-cyan-200',
  'bg-sky-200 text-sky-900 dark:bg-sky-900 dark:text-sky-200',
  'bg-indigo-200 text-indigo-900 dark:bg-indigo-900 dark:text-indigo-200',
  'bg-fuchsia-200 text-fuchsia-900 dark:bg-fuchsia-900 dark:text-fuchsia-200',
  'bg-pink-200 text-pink-900 dark:bg-pink-900 dark:text-pink-200',
];

function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx]!;
}

function displayName(opts: { name: string | null; email: string }): string {
  if (opts.name && opts.name.trim().length > 0) return opts.name;
  return opts.email.split('@')[0] ?? opts.email;
}

function initials(s: string): string {
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function actionVerb(row: ActivityRow): string {
  switch (row.action) {
    case 'view':
      return 'viewed';
    case 'edit_text': {
      const idx = (row.details as { utteranceIndex?: number } | null)?.utteranceIndex;
      return idx !== undefined ? `edited utterance #${idx}` : 'edited text';
    }
    case 'find_replace':
      return 'ran find & replace';
    case 'edit_speakers':
      return 'edited speakers';
    case 'edit_meta': {
      const d = row.details as { changedTitle?: boolean; changedDescription?: boolean } | null;
      const bits: string[] = [];
      if (d?.changedTitle) bits.push('title');
      if (d?.changedDescription) bits.push('description');
      return bits.length ? `updated ${bits.join(' & ')}` : 'updated metadata';
    }
    case 'share_add': {
      const d = row.details as { withEmail?: string; accessLevel?: string } | null;
      return d?.withEmail
        ? `shared with ${d.withEmail}${d.accessLevel ? ` as ${d.accessLevel}` : ''}`
        : 'shared transcript';
    }
    case 'share_update': {
      const d = row.details as { withEmail?: string; accessLevel?: string } | null;
      return d?.withEmail
        ? `changed ${d.withEmail} to ${d.accessLevel ?? '?'}`
        : 'changed share access';
    }
    case 'share_remove': {
      const d = row.details as { withEmail?: string } | null;
      return d?.withEmail ? `removed ${d.withEmail}` : 'removed a collaborator';
    }
    case 'owner_transfer': {
      const d = row.details as { toEmail?: string } | null;
      return d?.toEmail ? `transferred ownership to ${d.toEmail}` : 'transferred ownership';
    }
    case 'generate_notes':
      return 'generated AI notes';
    case 'set_notes': {
      const d = row.details as { via?: string } | null;
      return d?.via ? `updated notes via ${d.via}` : 'updated notes';
    }
    case 'set_report': {
      const d = row.details as { via?: string } | null;
      return d?.via ? `updated report via ${d.via}` : 'updated report';
    }
    default:
      return row.action;
  }
}

function actionIcon(action: ActivityAction) {
  switch (action) {
    case 'view':
      return <Eye className="h-3.5 w-3.5" />;
    case 'edit_text':
      return <Type className="h-3.5 w-3.5" />;
    case 'find_replace':
      return <Search className="h-3.5 w-3.5" />;
    case 'edit_speakers':
      return <Pencil className="h-3.5 w-3.5" />;
    case 'edit_meta':
      return <Settings2 className="h-3.5 w-3.5" />;
    case 'share_add':
      return <UserPlus className="h-3.5 w-3.5" />;
    case 'share_remove':
      return <UserMinus className="h-3.5 w-3.5" />;
    case 'share_update':
      return <ShieldCheck className="h-3.5 w-3.5" />;
    case 'owner_transfer':
      return <Crown className="h-3.5 w-3.5" />;
    default:
      return <Eye className="h-3.5 w-3.5" />;
  }
}

function relTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return formatDistanceToNow(d, { addSuffix: true });
  } catch {
    return '';
  }
}

/**
 * Notion-style activity strip: a small avatar stack of recent viewers plus
 * a "Edited by … · 2m ago" pill, all clickable to open the full timeline.
 */
export function ActivityBar({ transcriptId, refreshSignal }: ActivityBarProps) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/transcripts/${transcriptId}/activity?limit=80`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as ActivitySummary;
      setSummary(data);
    } finally {
      setLoading(false);
    }
  }, [transcriptId]);

  useEffect(() => {
    load();
  }, [load, refreshSignal]);

  if (!summary) {
    return (
      <div className="inline-flex h-6 items-center gap-2 text-[11px] text-muted-foreground">
        {loading ? 'Loading activity…' : ''}
      </div>
    );
  }

  // Build a single deduped list of everyone who's touched the transcript —
  // editors first (from events), then any pure viewers. Sorted by most
  // recent activity so the freshest folks bubble to the front.
  interface Person {
    user_id: string;
    user_email: string;
    user_name: string | null;
    lastAt: string;
    /** What that person did most recently — for the tooltip. */
    lastVerb: string;
  }
  const peopleMap = new Map<string, Person>();
  for (const ev of summary.events) {
    const existing = peopleMap.get(ev.user_id);
    if (!existing) {
      peopleMap.set(ev.user_id, {
        user_id: ev.user_id,
        user_email: ev.user_email,
        user_name: ev.user_name,
        lastAt: ev.at,
        lastVerb: actionVerb(ev),
      });
    }
  }
  for (const v of summary.recentViewers) {
    if (!peopleMap.has(v.user_id)) {
      peopleMap.set(v.user_id, {
        user_id: v.user_id,
        user_email: v.user_email,
        user_name: v.user_name,
        lastAt: v.last_viewed_at,
        lastVerb: 'viewed',
      });
    }
  }
  const people = Array.from(peopleMap.values()).sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
  );
  const STACK_LIMIT = 5;
  const stackedPeople = people.slice(0, STACK_LIMIT);
  const overflow = Math.max(people.length - stackedPeople.length, 0);

  const lastEdit = summary.lastEdit;
  const lastEditName = lastEdit
    ? displayName({ name: lastEdit.user_name, email: lastEdit.user_email })
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border bg-card px-2 py-1 text-[11px] text-muted-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] transition-colors hover:bg-accent hover:text-accent-foreground"
        title="Show activity timeline"
      >
        {stackedPeople.length > 0 && (
          <div className="flex -space-x-1.5">
            {stackedPeople.map((p) => {
              const n = displayName({ name: p.user_name, email: p.user_email });
              return (
                <div
                  key={p.user_id}
                  title={`${n} · ${p.lastVerb} ${relTime(p.lastAt)}`}
                  className={`flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-background text-[9px] font-semibold ${colorFor(
                    p.user_email
                  )}`}
                >
                  {initials(n)}
                </div>
              );
            })}
            {overflow > 0 && (
              <div
                title={`${overflow} more ${overflow === 1 ? 'person' : 'people'}`}
                className="flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-background bg-muted text-[9px] font-semibold text-muted-foreground"
              >
                +{overflow}
              </div>
            )}
          </div>
        )}
        {lastEdit && lastEditName ? (
          <span>
            Edited by <span className="font-medium text-foreground">{lastEditName}</span>{' '}
            · {relTime(lastEdit.at)}
          </span>
        ) : (
          <span>No activity yet</span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              Activity
              <Badge variant="outline" className="text-[10px]">
                {summary.events.length}
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Edits and views across everyone with access. Views are deduped to
              one per person every 10 minutes.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[420px] overflow-y-auto pr-1">
            {summary.events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing yet. Open the transcript or make an edit to see activity here.
              </p>
            ) : (
              <ol className="space-y-3">
                {summary.events.map((row) => {
                  const n = displayName({ name: row.user_name, email: row.user_email });
                  return (
                    <li key={row.id} className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        {actionIcon(row.action)}
                      </span>
                      <div
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${colorFor(
                          row.user_email
                        )}`}
                        title={n}
                      >
                        {initials(n)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm leading-tight">
                          <span className="font-medium">{n}</span>{' '}
                          <span className="text-muted-foreground">{actionVerb(row)}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                          {relTime(row.at)} · {row.user_email}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

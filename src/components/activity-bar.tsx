'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
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
  Sparkles,
  FileText,
  X,
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

function firstName(full: string): string {
  const f = full.trim().split(/\s+/)[0] ?? full;
  // "atira" / "alok.rajiv" style local-parts → "Atira" / "Alok"
  const head = f.split(/[._-]/)[0] ?? f;
  return head.charAt(0).toUpperCase() + head.slice(1);
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
  const cls = 'h-3.5 w-3.5';
  switch (action) {
    case 'view':
      return <Eye className={cls} />;
    case 'edit_text':
      return <Type className={cls} />;
    case 'find_replace':
      return <Search className={cls} />;
    case 'edit_speakers':
      return <Pencil className={cls} />;
    case 'edit_meta':
      return <Settings2 className={cls} />;
    case 'share_add':
      return <UserPlus className={cls} />;
    case 'share_remove':
      return <UserMinus className={cls} />;
    case 'share_update':
      return <ShieldCheck className={cls} />;
    case 'owner_transfer':
      return <Crown className={cls} />;
    case 'generate_notes':
      return <Sparkles className={cls} />;
    case 'set_notes':
    case 'set_report':
      return <FileText className={cls} />;
    default:
      return <Eye className={cls} />;
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

/** Compact relative age for the people strip: "now", "37m", "4h", "3d", "Aug 2". */
function shortAge(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return format(d, 'MMM d');
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : format(d, 'HH:mm');
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, 'EEE d MMM');
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : format(d, 'yyyy-MM-dd');
}

interface Person {
  user_id: string;
  user_email: string;
  user_name: string | null;
  name: string;
  lastAt: string;
  /** What that person did most recently — for tooltips / the chip pill. */
  lastVerb: string;
  views: number;
  edits: number;
  events: ActivityRow[];
}

/** Every distinct person who touched the transcript, freshest first. */
function buildPeople(summary: ActivitySummary): Person[] {
  const map = new Map<string, Person>();
  for (const ev of summary.events) {
    let p = map.get(ev.user_id);
    if (!p) {
      p = {
        user_id: ev.user_id,
        user_email: ev.user_email,
        user_name: ev.user_name,
        name: displayName({ name: ev.user_name, email: ev.user_email }),
        lastAt: ev.at,
        lastVerb: actionVerb(ev),
        views: 0,
        edits: 0,
        events: [],
      };
      map.set(ev.user_id, p);
    }
    if (ev.action === 'view') p.views += 1;
    else p.edits += 1;
    p.events.push(ev);
    if (new Date(ev.at).getTime() > new Date(p.lastAt).getTime()) {
      p.lastAt = ev.at;
      p.lastVerb = actionVerb(ev);
    }
  }
  // Viewers whose rows fell outside the events window (30-day distinct list).
  for (const v of summary.recentViewers) {
    const p = map.get(v.user_id);
    if (!p) {
      map.set(v.user_id, {
        user_id: v.user_id,
        user_email: v.user_email,
        user_name: v.user_name,
        name: displayName({ name: v.user_name, email: v.user_email }),
        lastAt: v.last_viewed_at,
        lastVerb: 'viewed',
        views: 1,
        edits: 0,
        events: [],
      });
    } else if (new Date(v.last_viewed_at).getTime() > new Date(p.lastAt).getTime()) {
      p.lastAt = v.last_viewed_at;
      p.lastVerb = 'viewed';
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
  );
}

/** One day of the timeline: edits as full rows, that day's views squashed into
 *  a single "X, Y and Z viewed" line so the list is about what changed. */
interface DayGroup {
  key: string;
  label: string;
  edits: ActivityRow[];
  viewers: { name: string; count: number; lastAt: string }[];
  viewsLatestAt: string | null;
}

function groupByDay(events: ActivityRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  const idx = new Map<string, DayGroup>();
  for (const ev of events) {
    const k = dayKey(ev.at);
    let g = idx.get(k);
    if (!g) {
      g = { key: k, label: dayLabel(ev.at), edits: [], viewers: [], viewsLatestAt: null };
      idx.set(k, g);
      groups.push(g);
    }
    if (ev.action === 'view') {
      const n = displayName({ name: ev.user_name, email: ev.user_email });
      const v = g.viewers.find((x) => x.name === n);
      if (v) v.count += 1;
      else g.viewers.push({ name: n, count: 1, lastAt: ev.at });
      if (!g.viewsLatestAt || new Date(ev.at) > new Date(g.viewsLatestAt)) g.viewsLatestAt = ev.at;
    } else {
      g.edits.push(ev);
    }
  }
  return groups;
}

/** Squash consecutive rows by the same person with the same verb ("edited
 *  speakers" ×7 in a row) into one row with a count; time = the latest. */
interface Run { row: ActivityRow; count: number }
function collapseRuns(rows: ActivityRow[]): Run[] {
  const out: Run[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.row.user_id === row.user_id && actionVerb(prev.row) === actionVerb(row)) prev.count += 1;
    else out.push({ row, count: 1 });
  }
  return out;
}

function viewersSentence(viewers: DayGroup['viewers']): string {
  const parts = viewers.map((v) => (v.count > 1 ? `${firstName(v.name)} ×${v.count}` : firstName(v.name)));
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  if (parts.length <= 4) return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} others`;
}

/**
 * Notion-style activity strip: a small avatar stack of recent viewers plus
 * a "Edited by … · 2m ago" pill, all clickable to open the activity dialog.
 *
 * The dialog leads with PEOPLE (who's been here, how long ago, did they
 * edit) — tap a person to see their own history; below that a day-grouped
 * timeline where views are squashed per day so edits stay readable.
 */
export function ActivityBar({ transcriptId, refreshSignal }: ActivityBarProps) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/transcripts/${transcriptId}/activity?limit=200`, {
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

  const people = useMemo(() => (summary ? buildPeople(summary) : []), [summary]);
  const days = useMemo(() => (summary ? groupByDay(summary.events) : []), [summary]);
  const selectedPerson = selected ? people.find((p) => p.user_id === selected) ?? null : null;

  if (!summary) {
    return (
      <div className="inline-flex h-6 items-center gap-2 text-[11px] text-muted-foreground">
        {loading ? 'Loading activity…' : ''}
      </div>
    );
  }

  const STACK_LIMIT = 5;
  const stackedPeople = people.slice(0, STACK_LIMIT);
  const overflow = Math.max(people.length - stackedPeople.length, 0);

  const lastEdit = summary.lastEdit;
  const lastEditName = lastEdit
    ? displayName({ name: lastEdit.user_name, email: lastEdit.user_email })
    : null;
  const editors = people.filter((p) => p.edits > 0).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border bg-card px-2 py-1 text-[11px] text-muted-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] transition-colors hover:bg-accent hover:text-accent-foreground"
        title="Show activity"
      >
        {stackedPeople.length > 0 && (
          <div className="flex -space-x-1.5">
            {stackedPeople.map((p) => (
              <div
                key={p.user_id}
                title={`${p.name} · ${p.lastVerb} ${relTime(p.lastAt)}`}
                className={`flex h-5 w-5 items-center justify-center rounded-full ring-2 ring-background text-[9px] font-semibold ${colorFor(
                  p.user_email
                )}`}
              >
                {initials(p.name)}
              </div>
            ))}
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

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setSelected(null);
        }}
      >
        <DialogContent className="max-w-lg gap-3 rounded-xl p-0 shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold">
              Activity
              <Badge variant="outline" className="text-[10px]">
                {people.length} {people.length === 1 ? 'person' : 'people'}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {summary.events.length} events
              </Badge>
            </DialogTitle>
            <DialogDescription>
              {editors > 0
                ? `${editors} ${editors === 1 ? 'person has' : 'people have'} edited, ${people.length - editors} only viewed.`
                : 'Nobody has edited yet — views only.'}{' '}
              Tap a person for their history.
            </DialogDescription>
          </DialogHeader>

          {people.length === 0 ? (
            <p className="px-5 pb-6 pt-2 text-center text-sm text-muted-foreground">
              Nothing yet. Open the transcript or make an edit to see activity here.
            </p>
          ) : (
            <>
              {/* ---- people strip ---- */}
              <div className="flex flex-wrap gap-1.5 px-5">
                {people.map((p) => {
                  const active = p.user_id === selected;
                  return (
                    <button
                      key={p.user_id}
                      type="button"
                      onClick={() => setSelected(active ? null : p.user_id)}
                      title={`${p.name} · ${p.user_email}\n${p.lastVerb} ${relTime(p.lastAt)}`}
                      aria-pressed={active}
                      className={`group flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-left transition-colors ${
                        active
                          ? 'border-foreground/40 bg-accent text-accent-foreground'
                          : 'bg-card hover:bg-accent hover:text-accent-foreground'
                      }`}
                    >
                      <span className="relative">
                        <span
                          className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${colorFor(
                            p.user_email
                          )}`}
                        >
                          {initials(p.name)}
                        </span>
                        {p.edits > 0 && (
                          <span
                            className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-foreground text-background ring-2 ring-card"
                            title={`${p.edits} ${p.edits === 1 ? 'edit' : 'edits'}`}
                          >
                            <Pencil className="h-2 w-2" />
                          </span>
                        )}
                      </span>
                      <span className="flex flex-col leading-none">
                        <span className="text-[12px] font-medium">{firstName(p.name)}</span>
                        <span className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                          {shortAge(p.lastAt)}
                          {p.edits > 0 ? ` · ${p.edits}✎` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* ---- body: person detail OR day-grouped timeline ---- */}
              <div className="max-h-[400px] overflow-y-auto border-t px-5 pb-5 pt-3">
                {selectedPerson ? (
                  <PersonDetail person={selectedPerson} onClear={() => setSelected(null)} />
                ) : (
                  <Timeline days={days} />
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PersonDetail({ person, onClear }: { person: Person; onClear: () => void }) {
  const first = person.events.length ? person.events[person.events.length - 1]!.at : null;
  return (
    <div>
      <div className="mb-3 flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${colorFor(
            person.user_email
          )}`}
        >
          {initials(person.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">{person.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{person.user_email}</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{person.views}</span>{' '}
              {person.views === 1 ? 'view' : 'views'}
            </span>
            <span>
              <span className="font-medium text-foreground">{person.edits}</span>{' '}
              {person.edits === 1 ? 'edit' : 'edits'}
            </span>
            <span>last {relTime(person.lastAt)}</span>
            {first && <span>first {relTime(first)}</span>}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title="Back to everyone"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {person.events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Viewed {relTime(person.lastAt)} — older than the loaded timeline, no further detail.
        </p>
      ) : (
        <ol className="space-y-1.5">
          {collapseRuns(person.events).map(({ row, count }) => (
            <li key={row.id} className="flex items-center gap-2 text-sm">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {actionIcon(row.action)}
              </span>
              <span className={`min-w-0 flex-1 truncate ${row.action === 'view' ? 'text-muted-foreground' : ''}`}>
                {actionVerb(row)}
                {count > 1 && <span className="text-muted-foreground"> ×{count}</span>}
              </span>
              <span
                className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                title={new Date(row.at).toLocaleString()}
              >
                {dayLabel(row.at)} {clockTime(row.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Timeline({ days }: { days: DayGroup[] }) {
  if (days.length === 0) {
    return <p className="py-4 text-center text-xs text-muted-foreground">No events in the loaded window.</p>;
  }
  return (
    <div className="space-y-4">
      {days.map((g) => (
        <section key={g.key}>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label}
          </h3>
          <ol className="space-y-1.5">
            {collapseRuns(g.edits).map(({ row, count }) => {
              const n = displayName({ name: row.user_name, email: row.user_email });
              return (
                <li key={row.id} className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    {actionIcon(row.action)}
                  </span>
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold ${colorFor(
                      row.user_email
                    )}`}
                    title={n}
                  >
                    {initials(n)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-medium">{firstName(n)}</span>{' '}
                    <span className="text-muted-foreground">
                      {actionVerb(row)}
                      {count > 1 ? ` ×${count}` : ''}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                    title={new Date(row.at).toLocaleString()}
                  >
                    {clockTime(row.at)}
                  </span>
                </li>
              );
            })}
            {g.viewers.length > 0 && (
              <li className="flex items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Eye className="h-3.5 w-3.5" />
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                  title={g.viewers.map((v) => `${v.name} ×${v.count}`).join(', ')}
                >
                  {viewersSentence(g.viewers)} viewed
                </span>
                {g.viewsLatestAt && (
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    {clockTime(g.viewsLatestAt)}
                  </span>
                )}
              </li>
            )}
          </ol>
        </section>
      ))}
    </div>
  );
}

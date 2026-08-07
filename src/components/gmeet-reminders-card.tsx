'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Video, X, BellOff, CircleAlert, FileText, Clapperboard } from 'lucide-react';

interface Reminder {
  id: number;
  kind: 'unimported' | 'autorec_off';
  meetingCode: string | null;
  title: string | null;
  eventStart: string | null;
  hasRecording: boolean;
  hasTranscript: boolean;
}

const SHOW_MAX = 5;

function fmtWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const time = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (days <= 0) return time;
  return `${time} (${days}d ago)`;
}

/**
 * Home-page surface for the background poller's findings: past meetings with
 * recordings nobody imported, and upcoming organized meetings that won't
 * auto-record. Renders nothing when there's nothing to say.
 */
export function GmeetRemindersCard({
  refreshTrigger,
  onOpenSync,
}: {
  refreshTrigger: number;
  onOpenSync: () => void;
}) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(() => {
    fetch('/api/gmeet/reminders')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setReminders(data?.reminders ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  const act = async (r: Reminder, action: 'dismiss' | 'mute') => {
    setReminders((prev) => prev.filter((x) => x.id !== r.id));
    await fetch('/api/gmeet/reminders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: r.id,
        action,
        meetingCode: r.meetingCode,
        title: r.title,
        eventStart: r.eventStart,
      }),
    }).catch(() => {});
  };

  if (reminders.length === 0) return null;
  const shown = expanded ? reminders : reminders.slice(0, SHOW_MAX);

  return (
    <div className="mb-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CircleAlert className="h-4 w-4 text-primary" />
          {reminders.length === 1
            ? '1 meeting needs attention'
            : `${reminders.length} meetings need attention`}
        </div>
        <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onOpenSync}>
          <Video className="h-3.5 w-3.5" />
          Open sync
        </Button>
      </div>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{r.title || r.meetingCode || 'Untitled meeting'}</span>
              <span className="ml-2 text-xs text-muted-foreground">{fmtWhen(r.eventStart)}</span>
            </span>
            {r.kind === 'unimported' ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                {r.hasRecording && <Clapperboard className="h-3.5 w-3.5" aria-label="Has recording" />}
                {r.hasTranscript && <FileText className="h-3.5 w-3.5" aria-label="Has transcript" />}
                not imported
              </span>
            ) : (
              <span className="shrink-0 text-[11px] text-amber-600">
                auto-record is off — enable it in Meet before it starts
              </span>
            )}
            <span className="flex shrink-0 items-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Never remind about this meeting"
                onClick={() => act(r, 'mute')}
              >
                <BellOff className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Dismiss"
                onClick={() => act(r, 'dismiss')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {reminders.length > SHOW_MAX && (
        <button
          type="button"
          className="mt-1.5 text-xs text-primary hover:underline"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? 'Show fewer' : `Show all ${reminders.length}`}
        </button>
      )}
    </div>
  );
}

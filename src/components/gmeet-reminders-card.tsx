'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Video, X, BellOff, CircleAlert, FileText, Clapperboard } from 'lucide-react';

export interface Reminder {
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
 * The background poller's findings: past meetings with recordings nobody
 * imported, and upcoming organized meetings that won't auto-record.
 *
 * Presentational — the home page owns the data (it also drives the header
 * badge) and renders this either as the top-of-page banner or inside the
 * header bell dropdown. Renders nothing when there's nothing to say.
 */
export function GmeetRemindersCard({
  reminders,
  variant = 'banner',
  onOpenSync,
  onOpenMeeting,
  onAct,
  onClose,
}: {
  reminders: Reminder[];
  /** 'banner' = top-of-page callout; 'popover' = header-icon dropdown. */
  variant?: 'banner' | 'popover';
  onOpenSync: () => void;
  /** Row click — open the import dialog focused on this meeting. */
  onOpenMeeting?: (r: Reminder) => void;
  /** Dismiss/mute a single reminder. */
  onAct: (r: Reminder, action: 'dismiss' | 'mute') => void;
  /** Banner: hide it for good. Popover: close the dropdown. */
  onClose?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (reminders.length === 0) return null;
  const shown = expanded ? reminders : reminders.slice(0, SHOW_MAX);

  return (
    <div
      className={
        variant === 'banner'
          ? 'mb-4 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3'
          : 'rounded-lg border bg-popover px-4 py-3 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.06)]'
      }
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CircleAlert className="h-4 w-4 text-primary" />
          {reminders.length === 1
            ? '1 meeting needs attention'
            : `${reminders.length} meetings need attention`}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" className="h-7 px-2.5 text-xs" onClick={onOpenSync}>
            <Video className="h-3.5 w-3.5" />
            Open sync
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title={
                variant === 'banner'
                  ? 'Hide this banner — the count stays on the header icon'
                  : 'Close'
              }
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <ul className="space-y-1">
        {shown.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => onOpenMeeting?.(r)}
              title="See this meeting — opens the import dialog on its day"
              className="min-w-0 flex-1 truncate text-left hover:underline underline-offset-2"
            >
              <span className="font-medium">{r.title || r.meetingCode || 'Untitled meeting'}</span>
              <span className="ml-2 text-xs text-muted-foreground">{fmtWhen(r.eventStart)}</span>
            </button>
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
                onClick={() => onAct(r, 'mute')}
              >
                <BellOff className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Dismiss"
                onClick={() => onAct(r, 'dismiss')}
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

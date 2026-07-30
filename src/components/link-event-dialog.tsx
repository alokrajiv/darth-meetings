'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getGoogleAccessToken, hasValidGoogleToken } from '@/lib/google-token';
import {
  AlertCircle,
  CalendarSearch,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Users,
} from 'lucide-react';

interface CalendarEventLite {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  conferenceData?: { conferenceId?: string };
}

interface LinkEventDialogProps {
  open: boolean;
  onClose: () => void;
  transcriptId: string;
  /** Day to open on, ISO — usually the transcript's current date guess. */
  initialDateIso?: string | null;
  /** Called with the updated transcript row after a successful link. */
  onLinked?: () => void;
}

function toLocalDateInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`;
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Retro-link a transcript to the calendar event it came from: browse the
 * user's calendar (their own Google token, read-only) around the meeting's
 * date, pick the invite, done — the server merges attendees/title/times into
 * the transcript, sets the meeting date, and share suggestions light up.
 */
export function LinkEventDialog({
  open,
  onClose,
  transcriptId,
  initialDateIso,
  onLinked,
}: LinkEventDialogProps) {
  const [date, setDate] = useState<string>(() => toLocalDateInput(initialDateIso));
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEventLite[]>([]);

  const loadEvents = useCallback(async (forDate: string) => {
    setBusy(true);
    setError(null);
    try {
      const token = await getGoogleAccessToken();
      setConnected(true);
      const params = new URLSearchParams({
        timeMin: new Date(`${forDate}T00:00:00`).toISOString(),
        timeMax: new Date(`${forDate}T23:59:59.999`).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        fields:
          'items(id,summary,start,end,attendees(email,displayName,responseStatus),conferenceData(conferenceId))',
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
      const data = (await res.json()) as { items?: CalendarEventLite[] };
      setEvents((data.items ?? []).filter((e) => e.start?.dateTime));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calendar');
    } finally {
      setBusy(false);
    }
  }, []);

  const changeDate = (next: string) => {
    setDate(next);
    void loadEvents(next);
  };

  const linkEvent = async (e: CalendarEventLite) => {
    setLinking(e.id);
    setError(null);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/link-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: {
            id: e.id,
            title: e.summary,
            startTime: e.start?.dateTime,
            endTime: e.end?.dateTime,
            meetingCode: e.conferenceData?.conferenceId,
            attendees: (e.attendees ?? [])
              .filter((a) => a.email)
              .map((a) => ({
                email: a.email!,
                name: a.displayName,
                responseStatus: a.responseStatus,
              })),
          },
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error || `Link failed (${res.status})`);
      }
      onLinked?.();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed');
    } finally {
      setLinking(null);
    }
  };

  const handleClose = () => {
    setError(null);
    setEvents([]);
    setConnected(false);
    onClose();
  };

  // First open with a live token → skip the connect step and load right away.
  useEffect(() => {
    if (open && !connected && hasValidGoogleToken()) {
      void loadEvents(date);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? handleClose() : null)}>
      <DialogContent className="sm:max-w-lg rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Link a calendar event</DialogTitle>
        </DialogHeader>

        {!connected ? (
          <div className="space-y-4 py-2 min-w-0">
            <p className="text-sm text-muted-foreground">
              Find the invite this meeting came from — its title, date, and attendees get
              attached to the transcript, and you&apos;ll get share suggestions for the
              people who were in it.
            </p>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => changeDate(shiftDate(date, -1))}
                disabled={busy}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Input
                type="date"
                value={date}
                onChange={(e) => e.target.value && changeDate(e.target.value)}
                className="h-9 w-40"
                disabled={busy}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => changeDate(shiftDate(date, 1))}
                disabled={busy}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            <div className="max-h-[45vh] overflow-y-auto rounded-md border">
              {events.length === 0 && !busy ? (
                <p className="p-4 text-sm text-muted-foreground">No meetings on this day.</p>
              ) : (
                <ul className="divide-y">
                  {events.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => void linkEvent(e)}
                        disabled={linking !== null}
                        className="flex w-full items-center gap-3 p-3 text-left hover:bg-accent/40 transition-colors min-w-0"
                      >
                        <span className="w-14 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {e.start?.dateTime
                            ? new Date(e.start.dateTime).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : ''}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {e.summary ?? '(no title)'}
                        </span>
                        {(e.attendees ?? []).length > 0 && (
                          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                            <Users className="h-3 w-3" />
                            {(e.attendees ?? []).length}
                          </span>
                        )}
                        {linking === e.id && (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={handleClose} disabled={busy || linking !== null}>
            Cancel
          </Button>
          {!connected && (
            <Button onClick={() => void loadEvents(date)} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <CalendarSearch className="h-4 w-4 mr-2" />
              )}
              Connect Google
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

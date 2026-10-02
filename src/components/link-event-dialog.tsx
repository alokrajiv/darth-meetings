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
import { connectGoogle, getGoogleAccessToken, GoogleNotConnectedError } from '@/lib/google-token';
import {
  JoinChoice,
  fetchLinkCandidates,
  joinedMeetingHref,
} from '@/components/occurrence-join-choice';
import type { LinkMode, OccurrenceMeetingCandidate } from '@/lib/occurrence-join';
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
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  conferenceData?: { conferenceId?: string; entryPoints?: Array<{ uri?: string }> };
}

/** Teams meetup-join link on the event, if any — the server stamps
 * provider:'teams' + join facts so fetch-recording-later works. */
function teamsUrlOf(e: CalendarEventLite): string | null {
  const hay = [
    e.location,
    e.description,
    ...(e.conferenceData?.entryPoints ?? []).map((p) => p.uri),
  ]
    .filter(Boolean)
    .join('\n');
  return (
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>\\]+/.exec(hay)?.[0] ?? null
  );
}

interface LinkEventDialogProps {
  open: boolean;
  onClose: () => void;
  transcriptId: string;
  /**
   * Design P7: link a STANDALONE recording instead of a meeting — the pick
   * goes to `POST /api/recordings/:id/link`, which creates the meeting and
   * shares it with the event's internal invitees (the recording itself stays
   * private). `transcriptId` is ignored when this is set.
   */
  recordingId?: string;
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
 * the transcript, sets the meeting date, and shares the meeting with the
 * invite's internal people (meeting policy, as a cloud import does).
 */
export function LinkEventDialog({
  open,
  onClose,
  transcriptId,
  recordingId,
  initialDateIso,
  onLinked,
}: LinkEventDialogProps) {
  const [date, setDate] = useState<string>(() => toLocalDateInput(initialDateIso));
  const [connected, setConnected] = useState(false);
  /** The server holds no Google link for this person — only then is
   * "Connect Google" a real action (it runs the one-time connect flow). */
  const [notConnected, setNotConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEventLite[]>([]);
  /** The picked event's occurrence already has a meeting this can join —
   * the person chooses: add to it (default) or keep separate. */
  const [choice, setChoice] = useState<{
    event: CalendarEventLite;
    candidate: OccurrenceMeetingCandidate;
  } | null>(null);
  const [choosing, setChoosing] = useState<LinkMode | null>(null);

  const loadEvents = useCallback(async (forDate: string) => {
    setBusy(true);
    setError(null);
    try {
      const token = await getGoogleAccessToken();
      setConnected(true);
      setNotConnected(false);
      const params = new URLSearchParams({
        timeMin: new Date(`${forDate}T00:00:00`).toISOString(),
        timeMax: new Date(`${forDate}T23:59:59.999`).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        fields:
          'items(id,summary,location,description,start,end,attendees(email,displayName,responseStatus),conferenceData(conferenceId,entryPoints(uri)))',
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
      const data = (await res.json()) as { items?: CalendarEventLite[] };
      setEvents((data.items ?? []).filter((e) => e.start?.dateTime));
    } catch (err) {
      if (err instanceof GoogleNotConnectedError) setNotConnected(true);
      else setError(err instanceof Error ? err.message : 'Failed to load calendar');
    } finally {
      setBusy(false);
    }
  }, []);

  const changeDate = (next: string) => {
    setDate(next);
    void loadEvents(next);
  };

  /**
   * A pick: first ask whether this occurrence already has a meeting the
   * recording could join (owner, 2026-10-02). If so the person chooses;
   * otherwise the link goes straight through, as it always did.
   */
  const pickEvent = async (e: CalendarEventLite) => {
    setLinking(e.id);
    setError(null);
    const answer = await fetchLinkCandidates(
      recordingId ? { recordingId } : { transcriptId },
      {
        eventId: e.id,
        startTime: e.start?.dateTime,
        meetingCode: e.conferenceData?.conferenceId,
      }
    );
    if (answer?.candidate) {
      setLinking(null);
      setChoice({ event: e, candidate: answer.candidate });
      return;
    }
    await linkEvent(e, null);
  };

  const linkEvent = async (e: CalendarEventLite, mode: LinkMode | null) => {
    setLinking(e.id);
    setError(null);
    try {
      // Pass the token so the server can enrich from the Meet API too
      // (participants, conference times, transcript sidecar).
      const token = await getGoogleAccessToken();
      const res = await fetch(
        recordingId
          ? `/api/recordings/${recordingId}/link`
          : `/api/transcripts/${transcriptId}/link-event`,
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: token,
          ...(mode ? { mode } : {}),
          event: {
            id: e.id,
            title: e.summary,
            startTime: e.start?.dateTime,
            endTime: e.end?.dateTime,
            meetingCode: e.conferenceData?.conferenceId,
            teamsUrl: teamsUrlOf(e) ?? undefined,
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
      const answer = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(answer.error || `Link failed (${res.status})`);
      }
      // Joined: the recording is now part of the occurrence's existing
      // meeting (and a folded-in meeting went to the trash) — go there.
      const joinedHref = joinedMeetingHref(answer);
      onLinked?.();
      handleClose();
      if (joinedHref) window.location.assign(joinedHref);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Link failed');
    } finally {
      setLinking(null);
      setChoosing(null);
    }
  };

  const choose = (mode: LinkMode) => {
    if (!choice) return;
    setChoosing(mode);
    void linkEvent(choice.event, mode);
  };

  const handleClose = () => {
    setError(null);
    setChoice(null);
    setChoosing(null);
    setEvents([]);
    setConnected(false);
    onClose();
  };

  // Load right away on open: the token is minted server-side from the
  // person's stored Google link, so a fresh tab needs no click. Only a
  // person with no link at all is shown "Connect Google".
  useEffect(() => {
    if (open && !connected) {
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

        {choice ? (
          <div className="space-y-3 py-1 min-w-0">
            <JoinChoice candidate={choice.candidate} busy={choosing} onPick={choose} />
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
              disabled={choosing !== null}
              onClick={() => setChoice(null)}
            >
              ← Pick another event
            </button>
            {error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
            )}
          </div>
        ) : !connected ? (
          <div className="space-y-4 py-2 min-w-0">
            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading your calendar…
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {notConnected
                  ? 'Connect your Google account once to pick the invite from your calendar.'
                  : 'Find the invite this came from — its title, date, and attendees get attached, and the meeting is shared with the Trames colleagues on it.'}
              </p>
            )}
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
                        onClick={() => void pickEvent(e)}
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
          <Button variant="ghost" onClick={handleClose} disabled={busy || linking !== null || choosing !== null}>
            Cancel
          </Button>
          {!choice && !connected && !busy && (
            <Button
              onClick={() =>
                notConnected
                  ? connectGoogle(window.location.pathname + window.location.search)
                  : void loadEvents(date)
              }
            >
              <CalendarSearch className="h-4 w-4 mr-2" />
              {notConnected ? 'Connect Google' : 'Try again'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

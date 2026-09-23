'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, CalendarSearch, Loader2, Scissors, Sparkles, Users } from 'lucide-react';
import {
  formatTimestamp,
  parseTimestampMs,
  validateSplitWindow,
  MIN_CLIP_MS,
  type ClipHole,
  type ClipProposal,
  type ClipWindow,
  type ProposeClipsResponse,
  type SplitResponse,
} from '@/lib/clips';
import {
  eventOverlapsWindow,
  rangeBoundaries,
  rangeSummary,
  snapMs,
  utterancesIn,
  voicesIn,
  type RangeUtterance,
} from '@/lib/clip-range';

interface PickableEvent {
  key: string;
  title: string | null;
  start: string;
  end: string | null;
  attendeeCount: number | null;
}

interface SplitClipDialogProps {
  open: boolean;
  onClose: () => void;
  transcriptId: string;
  /** This meeting's title — the placeholder for the new one. */
  meetingTitle: string | null;
  /** How long this meeting runs on its own timeline (ms). */
  spanMs: number;
  clips: ClipWindow[];
  holes: ClipHole[];
  utterances: RangeUtterance[];
  /** Wall-clock start of the RECORDING, for the calendar pre-filter. */
  recordingStartedAt: string | null;
  /** Where the player is now — the handles open around it. */
  playheadMs: number;
  /** Move the player to a position (meeting ms) so a handle can be heard. */
  onPreview?: (ms: number) => void;
  /** The new meeting's url. */
  onSplit: (url: string) => void;
}

/** Two handles over the meeting's timeline, as a percentage of the span. */
function pct(ms: number, spanMs: number): number {
  if (spanMs <= 0) return 0;
  return Math.min(100, Math.max(0, (ms / spanMs) * 100));
}

/**
 * "Split off a part…" — one recording, several meetings (Phase 3a,
 * docs/recordings-phase3-clips-spec.md §UI).
 *
 * Nothing is cut and nothing is re-transcribed: the range below picks a
 * WINDOW of the recording this meeting already reads, and the window becomes
 * a second meeting. The handles snap to what somebody actually said, the line
 * under them says the range in words, and the refusals are the server's own —
 * `validateSplitWindow` is the same pure function on both sides, so the
 * button greys out for exactly the reasons the route would refuse for.
 */
export function SplitClipDialog({
  open,
  onClose,
  transcriptId,
  meetingTitle,
  spanMs,
  clips,
  holes,
  utterances,
  recordingStartedAt,
  playheadMs,
  onPreview,
  onSplit,
}: SplitClipDialogProps) {
  const boundaries = useMemo(
    () => rangeBoundaries(utterances, spanMs, holes),
    [utterances, spanMs, holes]
  );

  const [fromMs, setFromMs] = useState(0);
  const [toMs, setToMs] = useState(0);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');
  const [title, setTitle] = useState('');
  const [keepInBoth, setKeepInBoth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [eventOpen, setEventOpen] = useState(false);
  const [events, setEvents] = useState<PickableEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventRef, setEventRef] = useState<PickableEvent | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);

  const [suggesting, setSuggesting] = useState(false);
  const [proposals, setProposals] = useState<ClipProposal[] | null>(null);
  const [instruction, setInstruction] = useState('');

  const setRange = useCallback((nextFrom: number, nextTo: number) => {
    setFromMs(nextFrom);
    setToMs(nextTo);
    setFromText(formatTimestamp(nextFrom));
    setToText(formatTimestamp(nextTo));
  }, []);

  // Open around the playhead: a five-minute range starting where they are,
  // which is almost always near the moment they meant.
  useEffect(() => {
    if (!open) return;
    const start = Math.max(0, Math.min(Math.round(playheadMs), Math.max(0, spanMs - MIN_CLIP_MS)));
    setRange(start, Math.min(spanMs, start + 300_000));
    setTitle('');
    setKeepInBoth(false);
    setError(null);
    setProposals(null);
    setInstruction('');
    setEventRef(null);
    setEventOpen(false);
    setShowAllEvents(false);
    // Only when the dialog opens — re-running on every playhead tick would
    // yank the handles out from under the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const refusal = useMemo(
    () => validateSplitWindow({ clips, fromMs, toMs, spanMs, keepInBoth }),
    [clips, fromMs, toMs, spanMs, keepInBoth]
  );
  const voices = useMemo(() => voicesIn(utterances, fromMs, toMs), [utterances, fromMs, toMs]);
  const moving = useMemo(() => utterancesIn(utterances, fromMs, toMs), [utterances, fromMs, toMs]);

  // --- dragging ----------------------------------------------------------
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<'from' | 'to' | null>(null);

  const msAtClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el || spanMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
      return Math.min(spanMs, Math.max(0, Math.round(ratio * spanMs)));
    },
    [spanMs]
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (ev: PointerEvent) => {
      const raw = msAtClientX(ev.clientX);
      if (dragging === 'from') setRange(Math.min(raw, toMs), toMs);
      else setRange(fromMs, Math.max(raw, fromMs));
    };
    const up = (ev: PointerEvent) => {
      const raw = msAtClientX(ev.clientX);
      const snapped = snapMs(raw, boundaries);
      if (dragging === 'from') setRange(Math.min(snapped, toMs), toMs);
      else setRange(fromMs, Math.max(snapped, fromMs));
      setDragging(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, msAtClientX, boundaries, fromMs, toMs, setRange]);

  /** Arrow keys walk boundary to boundary; Shift nudges by a second. */
  const handleKey = (which: 'from' | 'to') => (e: React.KeyboardEvent) => {
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowUp';
    if (!back && !forward) return;
    e.preventDefault();
    const at = which === 'from' ? fromMs : toMs;
    let next: number;
    if (e.shiftKey) {
      next = at + (forward ? 1000 : -1000);
    } else {
      next = forward
        ? (boundaries.find((b) => b > at) ?? spanMs)
        : ([...boundaries].reverse().find((b) => b < at) ?? 0);
    }
    next = Math.min(spanMs, Math.max(0, next));
    if (which === 'from') setRange(Math.min(next, toMs), toMs);
    else setRange(fromMs, Math.max(next, fromMs));
  };

  const commitTyped = (which: 'from' | 'to', text: string) => {
    const ms = parseTimestampMs(text.trim());
    if (ms === null) {
      // Unreadable — put the field back to what the handles say.
      setFromText(formatTimestamp(fromMs));
      setToText(formatTimestamp(toMs));
      return;
    }
    const clamped = Math.min(spanMs, Math.max(0, ms));
    if (which === 'from') setRange(Math.min(clamped, toMs), toMs);
    else setRange(fromMs, Math.max(clamped, fromMs));
  };

  // --- the calendar events worth offering --------------------------------
  const recordingStartMs = recordingStartedAt ? Date.parse(recordingStartedAt) : NaN;
  const haveWallClock = Number.isFinite(recordingStartMs);

  const loadEvents = useCallback(async () => {
    if (!haveWallClock) return;
    setEventsLoading(true);
    setEventsError(null);
    try {
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const params = new URLSearchParams({
        from: day(recordingStartMs - 86_400_000),
        to: day(recordingStartMs + spanMs + 86_400_000),
        sync: '0',
      });
      const res = await fetch(`/api/calendar/events?${params}`);
      if (!res.ok) throw new Error(`Calendar unavailable (${res.status})`);
      const data = (await res.json()) as { events?: PickableEvent[] };
      setEvents(data.events ?? []);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : 'Calendar unavailable');
      setEvents([]);
    } finally {
      setEventsLoading(false);
    }
  }, [haveWallClock, recordingStartMs, spanMs]);

  useEffect(() => {
    if (eventOpen && events === null) void loadEvents();
  }, [eventOpen, events, loadEvents]);

  const overlapping = useMemo(() => {
    if (!events || !haveWallClock) return events ?? [];
    return events.filter((e) =>
      eventOverlapsWindow(e, recordingStartMs + fromMs, recordingStartMs + toMs)
    );
  }, [events, haveWallClock, recordingStartMs, fromMs, toMs]);
  const shownEvents = showAllEvents ? (events ?? []) : overlapping;

  // --- suggest -----------------------------------------------------------
  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/clips/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      const data = (await res.json()) as ProposeClipsResponse;
      if (!('ok' in data)) throw new Error(data.error || 'Could not suggest anything');
      setProposals(data.proposals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not suggest anything');
    } finally {
      setSuggesting(false);
    }
  };

  const applyProposal = (p: ClipProposal) => {
    setRange(p.fromMs, p.toMs);
    if (!title.trim()) setTitle(p.title);
  };

  // --- submit ------------------------------------------------------------
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromMs,
          toMs,
          title: title.trim() || undefined,
          eventRef: eventRef?.key,
          keepInBoth: keepInBoth || undefined,
        }),
      });
      const data = (await res.json()) as SplitResponse;
      if (!res.ok || !('ok' in data)) {
        // The server's words, verbatim — it knows things the dialog cannot
        // (a shared transcription job, a re-run in flight).
        throw new Error(('error' in data && data.error) || `Split failed (${res.status})`);
      }
      onSplit(data.meeting.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Split failed');
    } finally {
      setBusy(false);
    }
  };

  const summary = rangeSummary({ fromMs, toMs, voices });

  return (
    <Dialog open={open} onOpenChange={(o) => (!o && !busy ? onClose() : null)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Split off a part</DialogTitle>
          <DialogDescription className="text-xs">
            A stretch of this recording becomes a meeting of its own. Nothing is cut and nothing is
            transcribed again — both meetings play the same recording.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          {/* The range */}
          <div>
            <div
              ref={trackRef}
              className="relative h-9 select-none rounded-md border bg-muted/40"
              data-clip-range
              onPointerDown={(e) => {
                // Clicking the track moves the nearer handle there.
                const raw = snapMs(msAtClientX(e.clientX), boundaries);
                const nearFrom = Math.abs(raw - fromMs) <= Math.abs(raw - toMs);
                if (nearFrom) setRange(Math.min(raw, toMs), toMs);
                else setRange(fromMs, Math.max(raw, fromMs));
              }}
            >
              {/* Holes: already somebody else's meeting. */}
              {holes.map((h) => (
                <div
                  key={`${h.fromMs}-${h.toMs}`}
                  className="absolute inset-y-0 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,var(--color-border)_4px,var(--color-border)_8px)]"
                  style={{ left: `${pct(h.fromMs, spanMs)}%`, width: `${pct(h.toMs - h.fromMs, spanMs)}%` }}
                  title={`${formatTimestamp(h.fromMs)} – ${formatTimestamp(h.toMs)} is already its own meeting`}
                />
              ))}
              <div
                className="absolute inset-y-1 rounded bg-primary/20 ring-1 ring-primary/40"
                style={{ left: `${pct(fromMs, spanMs)}%`, width: `${pct(toMs - fromMs, spanMs)}%` }}
              />
              {(['from', 'to'] as const).map((which) => {
                const at = which === 'from' ? fromMs : toMs;
                return (
                  <button
                    key={which}
                    type="button"
                    role="slider"
                    tabIndex={0}
                    aria-label={which === 'from' ? 'Start of the part' : 'End of the part'}
                    aria-valuemin={0}
                    aria-valuemax={Math.round(spanMs)}
                    aria-valuenow={at}
                    aria-valuetext={formatTimestamp(at)}
                    data-clip-handle={which}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setDragging(which);
                    }}
                    onKeyDown={handleKey(which)}
                    onDoubleClick={() => onPreview?.(at)}
                    title={`${formatTimestamp(at)} — drag, or use the arrow keys (Shift for one second)`}
                    className="absolute top-0 h-9 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm border border-primary bg-primary/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    style={{ left: `${pct(at, spanMs)}%` }}
                  />
                );
              })}
            </div>
            <div className="mt-0.5 flex justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
              <span>0:00</span>
              <span>{formatTimestamp(spanMs)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                value={fromText}
                onChange={(e) => setFromText(e.target.value)}
                onBlur={(e) => commitTyped('from', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTyped('from', fromText);
                }}
                aria-label="Start, as mm:ss"
                className="h-7 w-[5.5rem] font-mono text-xs tabular-nums"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                value={toText}
                onChange={(e) => setToText(e.target.value)}
                onBlur={(e) => commitTyped('to', e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitTyped('to', toText);
                }}
                aria-label="End, as mm:ss"
                className="h-7 w-[5.5rem] font-mono text-xs tabular-nums"
              />
              <span className="text-xs tabular-nums text-muted-foreground" data-clip-summary>
                {summary}
              </span>
            </div>
            {moving > 0 && !refusal && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {moving} {moving === 1 ? 'thing said' : 'things said'} move
                {keepInBoth ? ' — a copy stays here too' : ' to the new meeting'}.
              </p>
            )}
            {refusal && (
              <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-500">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                {refusal.message}
              </p>
            )}
          </div>

          {/* Suggest */}
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. split when Paola joined"
                aria-label="What to look for"
                className="h-7 min-w-0 flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 text-xs"
                disabled={suggesting}
                onClick={() => void suggest()}
              >
                {suggesting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                Suggest
              </Button>
            </div>
            {proposals !== null && proposals.length === 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                This looks like one meeting.
              </p>
            )}
            {proposals !== null && proposals.length > 0 && (
              <ul className="mt-2 space-y-1">
                {proposals.map((p) => (
                  <li key={`${p.fromMs}-${p.toMs}`}>
                    <button
                      type="button"
                      onClick={() => applyProposal(p)}
                      className="w-full rounded-md border bg-card px-2 py-1.5 text-left hover:bg-accent/40"
                    >
                      <span className="block text-xs font-medium">{p.title}</span>
                      <span className="block text-[11px] tabular-nums text-muted-foreground">
                        {formatTimestamp(p.fromMs)} – {formatTimestamp(p.toMs)} · {p.reason}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Title */}
          <div>
            <label className="text-[11px] font-medium text-muted-foreground" htmlFor="clip-title">
              What to call it
            </label>
            <Input
              id="clip-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={meetingTitle ? `Part of ${meetingTitle}` : 'A part of this recording'}
              className="mt-1 h-8 text-sm"
            />
          </div>

          {/* Calendar link */}
          <div>
            {eventRef ? (
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <CalendarSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate">
                  {eventRef.title ?? '(no title)'} ·{' '}
                  {new Date(eventRef.start).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => setEventRef(null)}
                >
                  Remove
                </button>
              </p>
            ) : (
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline"
                onClick={() => setEventOpen((v) => !v)}
              >
                {eventOpen ? 'Never mind the calendar' : 'Link to a calendar event…'}
              </button>
            )}
            {eventOpen && !eventRef && (
              <div className="mt-2 rounded-md border">
                {eventsLoading ? (
                  <p className="flex items-center gap-1 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Looking at your calendar…
                  </p>
                ) : eventsError ? (
                  <p className="p-3 text-xs text-muted-foreground">{eventsError}</p>
                ) : shownEvents.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {haveWallClock && !showAllEvents
                      ? 'Nothing on your calendar was running during this part.'
                      : 'No events on your calendar around this recording.'}
                  </p>
                ) : (
                  <ul className="max-h-40 divide-y overflow-y-auto">
                    {shownEvents.map((e) => (
                      <li key={e.key}>
                        <button
                          type="button"
                          onClick={() => {
                            setEventRef(e);
                            setEventOpen(false);
                            if (!title.trim() && e.title) setTitle(e.title);
                          }}
                          className="flex w-full items-center gap-3 p-2 text-left hover:bg-accent/40"
                        >
                          <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            {new Date(e.start).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                            })}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {e.title ?? '(no title)'}
                          </span>
                          {e.attendeeCount ? (
                            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                              <Users className="h-3 w-3" />
                              {e.attendeeCount}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {haveWallClock && (events?.length ?? 0) > overlapping.length && (
                  <button
                    type="button"
                    className="w-full border-t px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted"
                    onClick={() => setShowAllEvents((v) => !v)}
                  >
                    {showAllEvents
                      ? 'Only the ones running during this part'
                      : `Show every event around this recording (${events?.length ?? 0})`}
                  </button>
                )}
                <p className="border-t px-2 py-1 text-[11px] text-muted-foreground">
                  Linking doesn&apos;t share the new meeting with anyone — the people invited
                  show up as suggestions when you share it.
                </p>
              </div>
            )}
          </div>

          {/* Keep in both */}
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={keepInBoth}
              onChange={(e) => setKeepInBoth(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 accent-primary"
            />
            <span>
              Keep it in this meeting too
              <span className="block text-[11px] text-muted-foreground">
                This meeting stays exactly as it is; the part simply also exists on its own.
              </span>
            </span>
          </label>

          {error && (
            <p className="flex items-start gap-1 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !!refusal}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
            Split
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

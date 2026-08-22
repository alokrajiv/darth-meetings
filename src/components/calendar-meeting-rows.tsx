'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import { ExternalLink, EyeOff, FileText, Loader2, Repeat, Search, Settings2, Upload, Video, VideoOff } from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { requestMediaUpload } from '@/components/audio-upload';

// Server-declared shapes (type-only import — erased at build, no server
// code is pulled into the client bundle). Display-only data: importing
// always goes through the existing dialog flow with the caller's own
// Google token.
import type {
  CalendarMeetingRow,
  CalendarMeetingsResponse,
} from '@/app/api/calendar-meetings/route';

export type { CalendarMeetingRow, CalendarMeetingsResponse };

export type CalendarDayGroup = CalendarMeetingsResponse['days'][number];

/** Which calendar-meetings view a row came from — controls importability
 * rules and the "No Meet link" badge. */
export type CalendarLayer = 'unimported' | 'norec';

function statusGlyph(r: CalendarMeetingRow) {
  if (r.hasRecording) {
    return (
      <span title="Recording available" className="shrink-0">
        <Video className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    );
  }
  if (r.hasTranscript) {
    return (
      <span title="Transcript available" className="shrink-0">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    );
  }
  if (r.recordingPreparing || r.transcriptPreparing) {
    return (
      <span title="Google is still preparing the recording/transcript" className="shrink-0">
        <Video className="h-3.5 w-3.5 animate-pulse text-amber-500" />
      </span>
    );
  }
  return (
    <span title="No recording" className="shrink-0">
      <VideoOff className="h-3.5 w-3.5 text-muted-foreground/40" />
    </span>
  );
}

function providerGlyph(r: CalendarMeetingRow) {
  if (r.provider === 'teams') {
    return (
      <span title="Microsoft Teams meeting" className="shrink-0">
        <TeamsLogo className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (r.hasMeet || r.meetingCode) {
    return (
      <span title="Google Meet meeting" className="shrink-0">
        <MeetLogo className="h-3.5 w-3.5" />
      </span>
    );
  }
  return null;
}

/**
 * Artifact badge that deep-links to the underlying Google artifact — via a
 * small confirm popover (never a silent jump to another site), so e.g. an
 * unparseable transcript is one click from diagnosis in Google Docs.
 * Without a target id it renders as a plain static badge.
 */
function ArtifactBadge({
  label,
  href,
  destination,
  className,
}: {
  label: string;
  href: string | null;
  destination: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  if (!href) {
    return (
      <Badge variant="outline" className={className}>
        {label}
      </Badge>
    );
  }
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="shrink-0"
        title={`Open ${destination}`}
        onClick={(e) => {
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const width = 256;
          setPos({
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          });
          setOpen(true);
        }}
      >
        <Badge variant="outline" className={`${className} cursor-pointer hover:bg-muted`}>
          {label}
        </Badge>
      </button>
      {open && pos && (
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 256 }}
          className="z-50 rounded-lg border bg-popover p-2 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          <p className="px-1 pb-1.5 text-xs text-muted-foreground">
            This opens {destination} in a new tab. Google checks your access
            when it loads.
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              window.open(href, '_blank', 'noopener,noreferrer');
            }}
            className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            Open {destination}
          </button>
        </div>
      )}
    </>
  );
}

/** Local YYYY-MM-DD of an ISO instant — matches the upload stepper's day. */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Per-event settings gear. Opens a fixed-position popover (same idiom as
 * SeriesBadge — position:fixed escapes the listing table's overflow-hidden
 * container) with the event's key facts (time, organizer, attendees,
 * recurring info) and its actions: hide this occurrence, hide the whole
 * recurring series + future ones, and — for events with no artifacts —
 * upload a recording pre-linked to this event. Hides POST
 * /api/calendar-mutes and let the host silently refetch via onMuteChanged.
 */
function EventGearMenu({
  row: r,
  layer,
  onMuteChanged,
}: {
  row: CalendarMeetingRow;
  layer: CalendarLayer;
  onMuteChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        !btnRef.current?.contains(e.target as Node)
      ) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // Any scroll invalidates the fixed anchor — just close.
    const onScroll = () => close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const openPopover = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 264;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    });
    setError(null);
    setOpen(true);
  };

  const mute = async (kind: 'occurrence' | 'series', value: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/calendar-mutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kind, value, title: r.title ?? undefined }),
      });
      if (!res.ok) throw new Error(`Failed to hide (${res.status})`);
      close();
      onMuteChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to hide');
    } finally {
      setBusy(false);
    }
  };

  const canUpload = layer === 'norec' && !!r.eventId;
  const startTs = new Date(r.eventStart);
  const timeLine =
    startTs.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) +
    ' · ' +
    startTs.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
    (r.eventEnd
      ? '–' + new Date(r.eventEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '');

  return (
    <>
      <Button
        ref={btnRef}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        title="Event settings"
        onClick={openPopover}
      >
        <Settings2 className="h-3.5 w-3.5" />
        <span className="sr-only">Event settings</span>
      </Button>
      {open && pos && (
        <div
          ref={popRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288 }}
          className="z-50 rounded-lg border bg-popover p-2 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.12),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          <p className="truncate px-1 text-xs font-medium">
            {r.title?.trim() || '(untitled meeting)'}
          </p>
          <div className="space-y-0.5 px-1 pb-1.5 pt-0.5 text-[11px] text-muted-foreground">
            <p>{timeLine}</p>
            {r.organizerEmail && (
              <p className="truncate">
                {r.organizerSelf ? 'Organized by you' : r.organizerEmail}
                {r.attendeeCount ? ` · ${r.attendeeCount} attendees` : ''}
              </p>
            )}
            <p>
              {r.provider === 'teams'
                ? 'Microsoft Teams'
                : r.hasMeet || r.meetingCode
                  ? 'Google Meet'
                  : 'No conferencing link'}
              {r.hasRecording
                ? ` · recording ×${r.recordingCount}`
                : r.hasTranscript
                  ? ' · transcript only'
                  : r.recordingPreparing || r.transcriptPreparing
                    ? ' · preparing…'
                    : ' · no artifacts'}
            </p>
            {r.recurringEventId && (
              <p>
                Recurring series
                {r.seriesCount ? ` · ${r.seriesCount} occurrences seen` : ''}
              </p>
            )}
          </div>
          <div className="space-y-0.5 border-t pt-1.5">
            {canUpload && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  close();
                  requestMediaUpload({
                    date: localDayOf(r.eventStart),
                    eventId: r.eventId!,
                  });
                }}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                Upload a recording for this meeting…
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void mute('occurrence', r.key)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              Hide this occurrence
            </button>
            {r.recurringEventId && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void mute('series', r.recurringEventId!)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                Hide all{r.seriesCount ? ` ${r.seriesCount}` : ''} occurrence
                {r.seriesCount === 1 ? '' : 's'} + future ones
              </button>
            )}
          </div>
          {busy && (
            <div className="flex items-center gap-2 px-1 pt-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Hiding…
            </div>
          )}
          {error && <p className="px-1 pt-1 text-xs text-destructive">{error}</p>}
        </div>
      )}
    </>
  );
}

interface CalendarEventRowProps {
  row: CalendarMeetingRow;
  layer: CalendarLayer;
  /** The host table's visible middle columns, in order — calendar rows render
   * a cell per column so they line up with the archive rows' grid. */
  visibleCols: string[];
  /** Responsive-hiding class per column key (the host's COL_RESPONSIVE). */
  colClass: (key: string) => string;
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
  /** A mute was added from this row — host silently refetches the calendar
   * layers + its hidden-list state. */
  onMuteChanged?: () => void;
  /** The row's series chip was clicked — host opens its SeriesDialog. */
  onOpenSeries?: (seriesId: number) => void;
}

/**
 * One calendar-event row, rendered INSIDE the merged listing table. It emits
 * a cell per visible archive column so organizer/time/duration/attendees sit
 * in the same grid as the archive rows' Owner/Date/Duration/Speakers. A
 * subtle tinted background keeps imported vs not-imported readable at a
 * glance. Pure presentation — fetching, day grouping, and merging live in
 * TranscriptTable.
 */
export function CalendarEventRow({
  row: r,
  layer,
  visibleCols,
  colClass,
  onImportMeeting,
  onMuteChanged,
  onOpenSeries,
}: CalendarEventRowProps) {
  // Unimported rows (artifacts known) and Teams rows import straight away.
  // A Meet row in the "No recording" layer has NO known artifacts — the old
  // Import… button opened the dialog only for it to answer "never started"
  // (D10). Now the button is "Check…": one live probe through the discovery
  // service (which writes back to the cache); if Google does hold something
  // the import dialog opens on it, otherwise the row says so inline.
  const canImport =
    !!r.meetingCode &&
    !!onImportMeeting &&
    (layer === 'unimported' || (r.hasMeet && r.provider === 'teams'));
  const canCheck =
    !canImport &&
    layer === 'norec' &&
    r.hasMeet &&
    r.provider === 'gmeet' &&
    !!r.meetingCode &&
    !!onImportMeeting;
  const canUpload = !canImport && !canCheck && layer === 'norec' && !!r.eventId;
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const checkEvidence = async () => {
    if (!r.meetingCode) return;
    setChecking(true);
    setCheckNote(null);
    try {
      const res = await fetch('/api/meet/evidence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingCode: r.meetingCode,
          startTime: r.eventStart,
          event: { id: r.eventId, recurringEventId: r.recurringEventId },
        }),
      });
      if (res.status === 404) {
        setCheckNote('Connect Google first');
        return;
      }
      const j = (await res.json().catch(() => ({}))) as {
        verdict?: { importable?: boolean; pending?: boolean };
        checkFailed?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error || `Check failed (${res.status})`);
      if (j.verdict?.importable) {
        // The probe wrote the evidence back — the row migrates to "Not
        // imported" on refetch; open the dialog on it meanwhile.
        onMuteChanged?.();
        onImportMeeting?.({ meetingCode: r.meetingCode, eventStart: r.eventStart });
      } else if (j.checkFailed) {
        setCheckNote('Google didn’t answer — try again');
      } else {
        setCheckNote('Nothing at Google — never recorded');
      }
    } catch (err) {
      setCheckNote(err instanceof Error ? err.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const middleCell = (key: string) => {
    switch (key) {
      case 'owner':
        return r.organizerEmail ? (
          <span className="block max-w-[16ch] truncate text-xs text-muted-foreground">
            {r.organizerSelf ? 'You' : r.organizerEmail}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      case 'date':
        // Calendar rows only exist in the merged (day-grouped) view, where
        // the Date column shows time-of-day — same as archive rows there.
        return (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            title={new Date(r.eventStart).toLocaleString()}
          >
            {new Date(r.eventStart).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        );
      case 'duration':
        return (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {r.durationSecs ? formatDuration(r.durationSecs) : '—'}
          </span>
        );
      case 'speakers':
        return (
          <span className="text-xs tabular-nums text-muted-foreground">
            {r.attendeeCount ?? '—'}
          </span>
        );
      default:
        return <span className="text-xs text-muted-foreground">—</span>;
    }
  };

  return (
    <TableRow
      className={`group bg-muted/30 transition-colors hover:bg-accent/30 ${
        r.muted ? 'opacity-60' : ''
      }`}
    >
      <TableCell className="py-2 pl-4">
        {/* w-0 + min-w-full: the cell contributes zero min-content width, so
            long nowrap titles can't inflate the table's column layout — the
            content still renders at the cell's full width and truncates. */}
        <div className="w-0 min-w-full">
        <div className="flex min-w-0 items-center gap-2">
          {statusGlyph(r)}
          {providerGlyph(r)}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={`min-w-0 truncate text-sm ${
                  r.title?.trim()
                    ? 'font-medium text-foreground/80'
                    : 'italic text-muted-foreground'
                }`}
              >
                {r.title?.trim() || '(untitled meeting)'}
              </div>
              {r.hasRecording && (
                <ArtifactBadge
                  label={`Recording${r.recordingCount > 1 ? ` ×${r.recordingCount}` : ''}`}
                  href={r.videoFileId ? `https://drive.google.com/file/d/${r.videoFileId}/view` : null}
                  destination="the recording in Google Drive"
                  className="shrink-0 text-[10px]"
                />
              )}
              {r.hasTranscript && (
                <ArtifactBadge
                  label="Transcript"
                  href={r.transcriptDocId ? `https://docs.google.com/document/d/${r.transcriptDocId}/edit` : null}
                  destination="the transcript Doc in Google Docs"
                  className="shrink-0 text-[10px]"
                />
              )}
              {!r.hasRecording && r.recordingPreparing && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-500"
                >
                  recording preparing…
                </Badge>
              )}
              {!r.hasTranscript && r.transcriptPreparing && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-500"
                >
                  transcript preparing…
                </Badge>
              )}
              {r.hasTranscript && r.geminiNotes && (
                <Badge
                  variant="outline"
                  title="Transcript lives in the Gemini-notes Doc attached to the calendar event"
                  className="shrink-0 text-[10px] text-muted-foreground"
                >
                  Gemini notes
                </Badge>
              )}
              {r.transcriptParseable === false && (
                <ArtifactBadge
                  label="transcript unparseable"
                  href={r.transcriptDocId ? `https://docs.google.com/document/d/${r.transcriptDocId}/edit` : null}
                  destination="the transcript Doc in Google Docs"
                  className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-500"
                />
              )}
              {r.seriesId !== null && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSeries?.(r.seriesId!);
                  }}
                  title={`Recurring call: ${r.seriesTitle} — click to see the whole series`}
                  className="inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10"
                >
                  <Repeat className="h-3 w-3 shrink-0" />
                  <span className="truncate">{r.seriesTitle}</span>
                </button>
              )}
              {r.muted && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] text-muted-foreground"
                >
                  muted
                </Badge>
              )}
              {layer === 'norec' && !r.hasMeet && (
                <Badge
                  variant="outline"
                  className="shrink-0 text-[10px] text-muted-foreground/70"
                >
                  No Meet link
                </Badge>
              )}
            </div>
          </div>
        </div>
        </div>
      </TableCell>
      {visibleCols.map((key) => (
        <TableCell key={key} className={`py-1.5 ${colClass(key)}`}>
          {middleCell(key)}
        </TableCell>
      ))}
      <TableCell className="py-1.5 pr-3">
        <div className="flex items-center justify-end gap-0.5">
          <EventGearMenu row={r} layer={layer} onMuteChanged={onMuteChanged} />
          {canImport && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                onImportMeeting?.({
                  meetingCode: r.meetingCode!,
                  eventStart: r.eventStart,
                });
              }}
            >
              Import…
            </Button>
          )}
          {canCheck && (
            <>
              {checkNote && (
                <span className="max-w-[18ch] truncate text-[11px] text-muted-foreground" title={checkNote}>
                  {checkNote}
                </span>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2.5 text-xs"
                disabled={checking}
                title="Ask Google whether this meeting left a recording or transcript (the calendar hasn't shown any yet)"
                onClick={(e) => {
                  e.stopPropagation();
                  void checkEvidence();
                }}
              >
                {checking ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Search className="mr-1 h-3 w-3" />
                )}
                Check…
              </Button>
            </>
          )}
          {canUpload && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                requestMediaUpload({
                  date: localDayOf(r.eventStart),
                  eventId: r.eventId!,
                });
              }}
              title="Upload your own recording for this meeting"
            >
              Upload…
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

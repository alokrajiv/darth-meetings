'use client';

import { TableCell, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import { FileText, Video, VideoOff } from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';

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

interface CalendarEventRowProps {
  row: CalendarMeetingRow;
  layer: CalendarLayer;
  /** Total column count of the host table — the row spans all of them. */
  colSpan: number;
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
}

/**
 * One calendar-event row, rendered INSIDE the merged listing table (it spans
 * the full width — calendar rows keep their own simpler layout rather than
 * following the archive column chooser). A subtle tinted background keeps
 * imported vs not-imported readable at a glance. Pure presentation —
 * fetching, day grouping, and merging live in TranscriptTable.
 */
export function CalendarEventRow({
  row: r,
  layer,
  colSpan,
  onImportMeeting,
}: CalendarEventRowProps) {
  const canImport =
    !!r.meetingCode && (layer === 'unimported' || r.hasMeet) && !!onImportMeeting;
  return (
    <TableRow
      className={`bg-muted/30 transition-colors hover:bg-accent/30 ${
        r.muted ? 'opacity-60' : ''
      }`}
    >
      <TableCell colSpan={colSpan} className="py-2 pl-4 pr-3">
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
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  Recording{r.recordingCount > 1 ? ` ×${r.recordingCount}` : ''}
                </Badge>
              )}
              {r.hasTranscript && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  Transcript
                </Badge>
              )}
              {r.transcriptParseable === false && (
                <Badge
                  variant="outline"
                  className="shrink-0 border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-500"
                >
                  transcript unparseable
                </Badge>
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
            {r.organizerEmail && (
              <div className="truncate text-xs text-muted-foreground">
                {r.organizerSelf ? 'Organized by you' : r.organizerEmail}
                {r.attendeeCount ? ` · ${r.attendeeCount} attendees` : ''}
              </div>
            )}
          </div>
          <span
            className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:inline"
            title={new Date(r.eventStart).toLocaleString()}
          >
            {new Date(r.eventStart).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <span className="hidden w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:inline">
            {r.durationSecs ? formatDuration(r.durationSecs) : '—'}
          </span>
          <span className="flex w-[84px] shrink-0 items-center justify-end">
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
          </span>
        </div>
      </TableCell>
    </TableRow>
  );
}

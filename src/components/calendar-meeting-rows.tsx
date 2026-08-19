'use client';

import { Fragment } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

/** A day group with the pre-computed heading (Today/Yesterday/…). */
export interface CalendarHeadedGroup extends CalendarDayGroup {
  heading: string;
  sub: string | null;
}

interface CalendarMeetingsTableProps {
  view: 'unimported' | 'norec';
  groups: CalendarHeadedGroup[];
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
}

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

/**
 * Table of calendar meetings for the "Not imported" / "No recording" source
 * views. Pure presentation — fetching, day-heading computation, infinite
 * scroll, and empty states live in TranscriptTable.
 */
export function CalendarMeetingsTable({
  view,
  groups,
  onImportMeeting,
}: CalendarMeetingsTableProps) {
  const renderRow = (r: CalendarMeetingRow) => {
    const canImport =
      !!r.meetingCode && (view === 'unimported' || r.hasMeet) && !!onImportMeeting;
    return (
      <TableRow
        key={r.key}
        className={`transition-colors hover:bg-accent/40 ${r.muted ? 'opacity-60' : ''}`}
      >
        <TableCell className="py-2 pl-4">
          <div className="flex min-w-0 items-center gap-2">
            {statusGlyph(r)}
            {providerGlyph(r)}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <div
                  className={`min-w-0 truncate text-sm font-medium ${
                    r.title?.trim() ? '' : 'italic text-muted-foreground'
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
                  <Badge variant="outline" className="shrink-0 text-[10px] text-muted-foreground">
                    muted
                  </Badge>
                )}
                {view === 'norec' && !r.hasMeet && (
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
          </div>
        </TableCell>
        <TableCell className="hidden py-1.5 md:table-cell">
          <span
            className="text-xs tabular-nums text-muted-foreground"
            title={new Date(r.eventStart).toLocaleString()}
          >
            {new Date(r.eventStart).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </TableCell>
        <TableCell className="hidden py-1.5 sm:table-cell">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {r.durationSecs ? formatDuration(r.durationSecs) : '—'}
          </span>
        </TableCell>
        <TableCell className="py-1.5 pr-3">
          <div className="flex items-center justify-end">
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
          </div>
        </TableCell>
      </TableRow>
    );
  };

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-9 bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Meeting
          </TableHead>
          <TableHead className="hidden h-9 w-[14%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:table-cell">
            Time
          </TableHead>
          <TableHead className="hidden h-9 w-[11%] bg-muted/50 text-[11px] font-medium uppercase tracking-wider text-muted-foreground sm:table-cell">
            Duration
          </TableHead>
          <TableHead className="h-9 w-[96px] bg-muted/50">&nbsp;</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((g) => {
          const totalSecs = g.rows.reduce((n, r) => n + (r.durationSecs ?? 0), 0);
          return (
            <Fragment key={g.key}>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="bg-muted/40 py-1.5 pl-4">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">
                    {g.heading}
                  </span>
                  {g.sub && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground/70">{g.sub}</span>
                  )}
                  <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                    {g.rows.length} meeting{g.rows.length === 1 ? '' : 's'}
                    {totalSecs > 0 ? ` · ${formatDuration(totalSecs)}` : ''}
                  </span>
                </TableCell>
              </TableRow>
              {g.rows.map(renderRow)}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

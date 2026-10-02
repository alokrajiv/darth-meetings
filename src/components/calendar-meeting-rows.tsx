'use client';

import { useEffect, useRef, useState } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  asTeamsChatVerdict,
  formatDuration,
  teamsChatVerdictCopy,
  teamsChatVerdictFromRow,
  type TeamsChatRowFields,
  type TeamsChatVerdict,
} from '@/lib/format';
import { msConnectHref, msLinkMissing, useMsLinkStatus } from '@/components/connect-nudge-banner';
// Stream S2 owns companion-client.ts — imported here, never edited here.
import { useCompanion } from '@/lib/companion/companion-client';
import { stripForCalendarRow } from '@/lib/recording-strip';
import { EyeOff, ExternalLink, Laptop, Plus, Repeat, Search, Upload, Zap } from 'lucide-react';
import { requestMediaUpload } from '@/components/audio-upload';
import { PersonChip } from '@/components/person-chip';
import { RowMenu, type RowMenuItem, type RowMenuSection } from '@/components/row-menu';
import { RecorderRefStrip, RecordingStrip, SourceGlyph } from '@/components/recording-strip';
import { networkErrorMessage } from '@/lib/fetch-errors';
import { reportLabel } from '@/lib/report-pref';

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

/** ONE glyph per calendar row: the conferencing provider, or a muted
 * "no link" mark (docs/listing-ui-redesign.md §5). */
function providerGlyph(r: CalendarMeetingRow) {
  if (r.provider === 'teams') return <SourceGlyph source="teams" title="Microsoft Teams meeting" />;
  if (r.hasMeet || r.meetingCode) return <SourceGlyph source="meet" title="Google Meet meeting" />;
  return <SourceGlyph source="none" title="No conferencing link on the invite" />;
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

/**
 * Teams chat verdict for an occurrence with no importable evidence — "Held
 * 51 min · not recorded" / "Not held — nobody joined the call" / … — from the
 * caller's Darth Tasks Microsoft link (lib/format teamsChatVerdictCopy).
 * `external`: organized outside our tenant (true) / ours (false) / unknown.
 */
export function TeamsChatVerdictLine({
  verdict,
  external,
  className = '',
}: {
  verdict: TeamsChatVerdict;
  external: boolean | null;
  className?: string;
}) {
  const { text, tone, title } = teamsChatVerdictCopy(verdict, { external });
  const color =
    tone === 'warn'
      ? 'text-amber-600 dark:text-amber-500'
      : tone === 'info'
        ? 'text-foreground/70'
        : 'text-muted-foreground';
  return (
    <span
      data-teams-chat-verdict={
        verdict.reason ? verdict.reason : verdict.held ? (verdict.recorded ? 'held-recorded' : 'held') : 'not-held'
      }
      title={title}
      className={`inline-flex min-w-0 shrink items-center gap-1 truncate text-[11px] leading-5 ${color} ${className}`}
    >
      <span className="shrink-0 rounded border border-current/30 px-1 text-[9px] uppercase tracking-wide opacity-70">
        Teams chat
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

/** "Connect Microsoft to see whether it was held" — the not-linked twin of
 * the verdict line. Sends the user through the Darth Tasks connect flow and
 * back to this page. */
export function ConnectMicrosoftHint({ className = '' }: { className?: string }) {
  const ms = useMsLinkStatus(false);
  return (
    <button
      type="button"
      data-connect-microsoft-hint
      className={`min-w-0 max-w-[34ch] shrink truncate text-left text-[11px] leading-5 text-primary/80 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:no-underline ${className}`}
      title="Teams meeting chats record when a call started/ended and whether it was recorded. Connect your Microsoft account (via Darth Tasks) to read them."
      onClick={(e) => {
        e.stopPropagation();
        window.location.href = msConnectHref(ms);
      }}
    >
      Connect Microsoft to see whether it was held
    </button>
  );
}

/** Local YYYY-MM-DD of an ISO instant — matches the upload stepper's day. */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface CalendarEventRowProps {
  row: CalendarMeetingRow;
  layer: CalendarLayer;
  /** The host table's visible middle columns, in order — calendar rows render
   * a cell per column so they line up with the archive rows' grid. */
  visibleCols: string[];
  /** Columns rendered LEFT of the title (the host's time column). */
  leadCols?: string[];
  /** Responsive-hiding class per column key (the host's COL_RESPONSIVE). */
  colClass: (key: string) => string;
  onImportMeeting?: (m: { meetingCode: string; eventStart: string }) => void;
  /** A mute was added from this row — host silently refetches the calendar
   * layers + its hidden-list state. */
  onMuteChanged?: () => void;
  /** The row's series chip was clicked — host opens its SeriesDialog. */
  onOpenSeries?: (seriesId: number) => void;
  /** The owner linked (or dismissed) their own recording's suggestion from
   * this row — the occurrence becomes imported, so the host refetches BOTH
   * layers, not just the calendar ones. */
  onRowChanged?: () => void;
}

/**
 * One calendar-event row, rendered INSIDE the merged listing table. It emits
 * a cell per visible archive column so organizer/time/duration/attendees sit
 * in the same grid as the archive rows' Owner/Date/Duration/Speakers.
 *
 * Anatomy (docs/listing-ui-redesign.md §5): provider glyph · title · series
 * chip on the first line; the recording strip (cloud state, a matched Darth
 * Recorder recording, the Teams-chat verdict) on the second; ONE control in
 * the action cell — Import… (or the ⚡ auto-sync chip), the strip's own
 * button, or the hover "+" Add-recording menu — plus a hover ⋯ for Hide.
 * Pure presentation — fetching, day grouping, and merging live in
 * TranscriptTable.
 */
export function CalendarEventRow({
  row: r,
  layer,
  visibleCols,
  leadCols = [],
  colClass,
  onImportMeeting,
  onMuteChanged,
  onOpenSeries,
  onRowChanged,
}: CalendarEventRowProps) {
  const companion = useCompanion();
  // Unimported rows (artifacts known) import straight away. A row in the
  // "No recording" layer — Meet OR Teams — has NO known artifacts: "check"
  // runs one live probe through the discovery service (Meet:
  // /api/meet/evidence, Teams: /api/teams/evidence — both write back to the
  // cache); if the provider does hold something the import dialog opens on
  // it, otherwise the row says so inline.
  const isTeams = r.provider === 'teams';
  const providerName = isTeams ? 'Microsoft' : 'Google';
  const canImport = !!r.meetingCode && !!onImportMeeting && layer === 'unimported';
  const canCheck =
    !canImport && layer === 'norec' && r.hasMeet && !!r.meetingCode && !!onImportMeeting;
  const canUpload = !canImport && layer === 'norec' && !!r.eventId;
  const knownEmpty =
    canCheck && r.recordingState === 'none' && r.transcriptState === 'none';
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [muteBusy, setMuteBusy] = useState(false);
  // Teams chat evidence (was the call held / recorded) — the cache row's
  // verdict (norec view fields) or, after a check, the live one the
  // evidence route returns alongside the artifact probe.
  const [chatLive, setChatLive] = useState<TeamsChatVerdict | null>(null);
  const [externalLive, setExternalLive] = useState<boolean | null>(null);
  const chatFields = r as TeamsChatRowFields;
  const chat = chatLive ?? (isTeams ? teamsChatVerdictFromRow(chatFields) : null);
  // chatExternal is only stamped (raw.external = true) on rows CREATED for
  // external occurrences — own-tenant rows carry NULL, which reliably means
  // "our tenant" whenever a verdict exists.
  const chatExternal = externalLive ?? (chatFields.chatExternal === true);
  const wantsChatHint = isTeams && layer === 'norec' && !chat;
  const ms = useMsLinkStatus(wantsChatHint);
  const showConnectMsHint = wantsChatHint && msLinkMissing(ms);

  const checkEvidence = async () => {
    if (!r.meetingCode) return;
    setChecking(true);
    setNote(null);
    try {
      const res = isTeams
        ? await fetch('/api/teams/evidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              meetingCode: r.meetingCode,
              eventId: r.eventId,
              startTime: r.eventStart,
              endTime: r.eventEnd,
              event: { recurringEventId: r.recurringEventId, organizerEmail: r.organizerEmail },
            }),
          })
        : await fetch('/api/meet/evidence', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              meetingCode: r.meetingCode,
              startTime: r.eventStart,
              event: { id: r.eventId, recurringEventId: r.recurringEventId },
            }),
          });
      if (res.status === 404) {
        setNote('Connect Google first');
        return;
      }
      const j = (await res.json().catch(() => ({}))) as {
        verdict?: { importable?: boolean; pending?: boolean };
        checkFailed?: boolean;
        external?: boolean;
        resolved?: boolean;
        code?: string;
        error?: string;
        chat?: unknown;
      };
      if (!res.ok) throw new Error(j.error || `Check failed (${res.status})`);
      if (isTeams) {
        // The evidence route carries the chat verdict (own-tenant AND
        // external) — keep it on the row whatever the artifact outcome.
        const live = asTeamsChatVerdict(j.chat);
        if (live) setChatLive(live);
        if (typeof j.external === 'boolean') setExternalLive(j.external);
      }
      if (j.external) {
        // Organized outside our tenant — app-only Graph can't see it; the
        // dialog's guided manual-import panel is the right next step.
        onImportMeeting?.({ meetingCode: j.code ?? r.meetingCode, eventStart: r.eventStart });
        return;
      }
      if (j.verdict?.importable) {
        // The probe wrote the evidence back — the row migrates to "Not
        // imported" on refetch; open the dialog on it meanwhile.
        onMuteChanged?.();
        onImportMeeting?.({ meetingCode: j.code ?? r.meetingCode, eventStart: r.eventStart });
      } else if (j.checkFailed) {
        setNote(`${providerName} didn’t answer — try again`);
      } else if (isTeams && asTeamsChatVerdict(j.chat)) {
        setNote(null);
      } else if (isTeams && j.resolved === false) {
        setNote('Microsoft has no record of this meeting');
      } else {
        setNote(`Nothing at ${providerName} — never recorded`);
      }
    } catch (err) {
      setNote(networkErrorMessage(err, 'Check failed'));
    } finally {
      setChecking(false);
    }
  };

  const mute = async (kind: 'occurrence' | 'series', value: string) => {
    setMuteBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/calendar-mutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ kind, value, title: r.title ?? undefined }),
      });
      if (!res.ok) throw new Error(`Failed to hide (${res.status})`);
      onMuteChanged?.();
    } catch (err) {
      setNote(networkErrorMessage(err, 'Failed to hide'));
    } finally {
      setMuteBusy(false);
    }
  };

  const openUpload = () => {
    if (!r.eventId) return;
    requestMediaUpload({ date: localDayOf(r.eventStart), eventId: r.eventId });
  };

  // ---- Menus -------------------------------------------------------------
  const lastChecked = r.evidenceCheckedAt
    ? ` (${new Date(r.evidenceCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
    : '';
  const whereItems: RowMenuItem[] = [];
  if (canCheck) {
    whereItems.push({
      key: 'check',
      label: `At ${providerName} — check`,
      hint: knownEmpty
        ? `Nothing was there last time${lastChecked}; recap artifacts land minutes after the call`
        : `Ask ${providerName} whether the call left a recording or transcript`,
      icon: <Search />,
      busy: checking,
      onSelect: () => checkEvidence(),
    });
  }
  if (canUpload) {
    whereItems.push({
      key: 'file',
      label: 'In a file — upload…',
      hint: 'A phone clip, a Zoom export, anything with audio',
      icon: <Upload />,
      onSelect: openUpload,
    });
    if (companion.connected) {
      whereItems.push({
        key: 'mac',
        label: 'On this Mac — Darth Recorder…',
        hint: 'Pick it from the recordings on this Mac',
        icon: <Laptop />,
        onSelect: openUpload,
      });
    }
  }
  const hideItems: RowMenuItem[] = [
    {
      key: 'hide-occ',
      label: 'Hide this occurrence',
      icon: <EyeOff />,
      disabled: muteBusy,
      onSelect: () => mute('occurrence', r.key),
    },
  ];
  if (r.recurringEventId) {
    hideItems.push({
      key: 'hide-series',
      label: `Hide all${r.seriesCount ? ` ${r.seriesCount}` : ''} occurrence${r.seriesCount === 1 ? '' : 's'} + future ones`,
      icon: <EyeOff />,
      disabled: muteBusy,
      onSelect: () => mute('series', r.recurringEventId!),
    });
  }
  const startTs = new Date(r.eventStart);
  const timeLine =
    startTs.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) +
    ' · ' +
    startTs.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
    (r.eventEnd
      ? '–' + new Date(r.eventEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '');
  const facts = (
    <div className="space-y-0.5 text-[11px] text-muted-foreground">
      <p className="truncate text-xs font-medium text-foreground">{r.title?.trim() || '(untitled meeting)'}</p>
      <p>{timeLine}</p>
      {r.organizerEmail && (
        <p className="truncate">
          {r.organizerSelf ? 'Organized by you' : r.organizerEmail}
          {r.attendeeCount ? ` · ${r.attendeeCount} attendees` : ''}
        </p>
      )}
    </div>
  );
  // The "Add recording" (+) menu is THE action of a bare norec row; once a
  // Darth Recorder recording is matched, the strip's button takes over and
  // the same choices fold into the ⋯.
  const addRecordingIsPrimary = layer === 'norec' && !r.recorderRecording && whereItems.length > 0;
  const dotsSections: RowMenuSection[] = [];
  if (!addRecordingIsPrimary && whereItems.length > 0) {
    dotsSections.push({ key: 'where', heading: 'Where is the recording?', items: whereItems });
  }
  dotsSections.push({ key: 'hide', items: hideItems });

  // ---- Cells -------------------------------------------------------------
  const middleCell = (key: string) => {
    switch (key) {
      case 'owner':
        return r.organizerEmail ? (
          <PersonChip email={r.organizerEmail} self={!!r.organizerSelf} />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      case 'date':
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

  // "Going in" on a not-yet-imported meeting = the import dialog focused on
  // it (same mechanism as the reminder rows and the Import… button).
  const rowClickable = !!r.meetingCode && !!onImportMeeting && layer === 'unimported';
  const autoVia = r.autoSync
    ? r.autoSync.source === 'series'
      ? ` via ${r.autoSync.importerEmail ?? '?'}'s "${r.autoSync.seriesTitle ?? 'series'}" series auto-import`
      : r.autoSync.importerEmail
        ? ` via ${r.autoSync.importerEmail}'s connection (account auto-sync)`
        : ''
    : '';
  const autoReport = r.autoSync?.report ? ` Then: ${reportLabel(r.autoSync.report)}.` : '';
  const autoSyncTitle =
    r.autoSync &&
    (r.autoSync.state === 'pending'
      ? `This meeting imports by itself once the recording/transcript is ready${autoVia}, and is shared with everyone in it who has auto-sync on.${autoReport} No need to import it yourself — click the row if you can't wait.`
      : r.autoSync.state === 'queued'
        ? `Already queued${autoVia} — it lands on its own once the artifacts are ready.${autoReport}`
        : `Already imported${autoVia} — the listing catches up on the next refresh.`);

  // The cloud state line. The Import… control stays in the action cell, so
  // the strip never grows a second one.
  const cloud = stripForCalendarRow(
    {
      provider: r.provider,
      hasMeet: r.hasMeet || !!r.meetingCode,
      hasRecording: r.hasRecording,
      hasTranscript: r.hasTranscript,
      recordingCount: r.recordingCount,
      recordingPreparing: r.recordingPreparing,
      transcriptPreparing: r.transcriptPreparing,
      durationSecs: r.durationSecs,
      recordingState: r.recordingState,
      transcriptState: r.transcriptState,
      evidenceCheckedAt: r.evidenceCheckedAt,
      layer,
    },
    { fmtDuration: formatDuration, canImport: false }
  );
  const artifactBadges =
    r.hasRecording || r.hasTranscript ? (
      <span className="inline-flex min-w-0 items-center gap-1">
        {r.hasRecording && (
          <ArtifactBadge
            label={`Recording${r.recordingCount > 1 ? ` ×${r.recordingCount}` : ''} at ${providerName}`}
            href={r.videoFileId ? `https://drive.google.com/file/d/${r.videoFileId}/view` : null}
            destination="the recording in Google Drive"
            className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
          />
        )}
        {r.hasTranscript && (
          <ArtifactBadge
            label={r.geminiNotes ? 'Gemini notes' : 'Transcript'}
            href={r.transcriptDocId ? `https://docs.google.com/document/d/${r.transcriptDocId}/edit` : null}
            destination="the transcript Doc in Google Docs"
            className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
          />
        )}
        {r.transcriptParseable === false && (
          <ArtifactBadge
            label="transcript unparseable"
            href={r.transcriptDocId ? `https://docs.google.com/document/d/${r.transcriptDocId}/edit` : null}
            destination="the transcript Doc in Google Docs"
            className="shrink-0 border-amber-500/50 px-1.5 py-0 text-[10px] font-normal text-amber-600 dark:text-amber-500"
          />
        )}
        {r.durationSecs ? <span className="truncate">· {formatDuration(r.durationSecs)}</span> : null}
      </span>
    ) : null;

  return (
    <TableRow
      onClick={rowClickable ? () => onImportMeeting!({ meetingCode: r.meetingCode!, eventStart: r.eventStart }) : undefined}
      data-calendar-row={layer}
      className={`group bg-muted/30 transition-colors hover:bg-accent/30 ${
        r.muted ? 'opacity-60' : ''
      } ${rowClickable ? 'cursor-pointer' : ''}`}
    >
      {leadCols.map((key) => (
        <TableCell key={key} className={`py-1.5 pl-4 align-top ${colClass(key)}`}>
          {middleCell(key)}
        </TableCell>
      ))}
      <TableCell className="py-2 pl-4">
        {/* w-0 + min-w-full: the cell contributes zero min-content width, so
            long nowrap titles can't inflate the table's column layout — the
            content still renders at the cell's full width and truncates. */}
        <div className="w-0 min-w-full">
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-[3px] shrink-0">{providerGlyph(r)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <div
                title={r.title?.trim() || undefined}
                className={`min-w-0 truncate text-sm ${
                  r.title?.trim()
                    ? 'font-medium text-foreground/80'
                    : 'italic text-muted-foreground'
                }`}
              >
                {r.title?.trim() || '(untitled meeting)'}
              </div>
              {r.seriesId !== null && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSeries?.(r.seriesId!);
                  }}
                  title={`Recurring call: ${r.seriesTitle} — click to see the whole series`}
                  className="inline-flex max-w-44 shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Repeat className="h-3 w-3 shrink-0" />
                  <span className="truncate">{r.seriesTitle}</span>
                </button>
              )}
              {r.muted && (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
                  muted
                </Badge>
              )}
              {layer === 'norec' && !r.hasMeet && (
                <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground/70">
                  No Meet link
                </Badge>
              )}
            </div>
            {/* The recording strip — one line, one source of truth for the
                occurrence's recording state (docs/listing-ui-redesign.md §4). */}
            {r.recorderRecording ? (
              <RecorderRefStrip
                rec={r.recorderRecording}
                event={{
                  id: r.eventId,
                  title: r.title,
                  startTime: r.eventStart,
                  endTime: r.eventEnd,
                  meetingCode: r.meetingCode,
                }}
                originalNote={chat ? teamsChatVerdictCopy(chat, { external: chatExternal }).text : null}
                onChanged={() => onRowChanged?.()}
              />
            ) : cloud ? (
              <RecordingStrip model={cloud} noGlyph>
                {artifactBadges ?? undefined}
              </RecordingStrip>
            ) : null}
            {isTeams && layer === 'norec' && chat && !r.recorderRecording && (
              <div className="flex min-w-0">
                <TeamsChatVerdictLine verdict={chat} external={chatExternal} />
              </div>
            )}
            {showConnectMsHint && !r.recorderRecording && (
              <div className="flex min-w-0">
                <ConnectMicrosoftHint />
              </div>
            )}
            {note && (
              <div className="truncate text-[11px] leading-5 text-muted-foreground" data-calendar-note>
                {note}
              </div>
            )}
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
        <div className="flex items-center justify-end gap-1">
          {canImport && r.autoSync && (
            <Badge
              variant="outline"
              title={autoSyncTitle ?? undefined}
              className="shrink-0 gap-1 border-primary/30 bg-primary/5 text-[10px] font-normal text-primary"
            >
              <Zap className="h-3 w-3" />
              {r.autoSync.state === 'pending'
                ? r.autoSync.source === 'series'
                  ? 'Series auto-import'
                  : 'Auto-sync'
                : r.autoSync.state === 'queued'
                  ? 'Auto-sync queued'
                  : 'Auto-synced'}
            </Badge>
          )}
          {canImport && !r.autoSync && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs"
              data-import-button
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
          {addRecordingIsPrimary && (
            // A hover/focus icon, not a 180 px button (README "Darth desktop
            // shell" → Layout rules) — the action column stays narrow.
            <RowMenu
              trigger="icon"
              ariaLabel="Add recording"
              triggerIcon={<Plus />}
              header={
                <>
                  <p className="font-medium">Where is the recording?</p>
                  <p className="text-[11px] text-muted-foreground">{r.title?.trim() || '(untitled meeting)'} · {timeLine}</p>
                </>
              }
              sections={[{ key: 'where', items: whereItems }, { key: 'hide', items: hideItems }]}
              busy={checking}
              dataAttr="add-recording"
            />
          )}
          <RowMenu
            ariaLabel="Event actions"
            header={facts}
            sections={dotsSections}
            dataAttr="event"
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

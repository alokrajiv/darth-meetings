'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileAudio, FileText, Laptop, Loader2, VideoOff } from 'lucide-react';
import { MeetLogo, TeamsLogo } from '@/components/provider-icon';
import { formatDuration } from '@/lib/format';
import { getCompanion, useCompanion } from '@/lib/companion/companion-client';
import type { RecorderRecordingRef } from '@/lib/recorder';
import {
  stripForRecorderRef,
  type RecordingSource,
  type RecordingStripModel,
  type StripActionKind,
  type StripTone,
} from '@/lib/recording-strip';
import { SuggestedEventStrip } from '@/components/suggested-event-strip';

/**
 * The recording strip (docs/listing-ui-redesign.md §4): ONE line under a
 * meeting title — source glyph · state sentence · progress · the one action.
 * Pure presentation of a RecordingStripModel; the interactive variants
 * below wire the actions.
 */

const TONE: Record<StripTone, string> = {
  muted: 'text-muted-foreground',
  busy: 'text-foreground/75',
  ok: 'text-foreground/75',
  warn: 'text-amber-700 dark:text-amber-400',
  err: 'text-destructive/90',
};

export function SourceGlyph({
  source,
  className = 'h-3.5 w-3.5',
  title,
}: {
  source: RecordingSource;
  className?: string;
  title?: string;
}) {
  const wrap = (node: React.ReactNode, label: string) => (
    <span title={title ?? label} className="inline-flex shrink-0 items-center" aria-label={title ?? label}>
      {node}
    </span>
  );
  switch (source) {
    case 'meet':
      return wrap(<MeetLogo className={className} />, 'Google Meet');
    case 'teams':
      return wrap(<TeamsLogo className={className} />, 'Microsoft Teams');
    case 'mac':
      return wrap(<Laptop className={`${className} text-muted-foreground`} />, 'Darth Recorder on a Mac');
    case 'file':
      return wrap(<FileAudio className={`${className} text-muted-foreground`} />, 'Uploaded file');
    case 'text':
      return wrap(<FileText className={`${className} text-muted-foreground`} />, 'Pasted transcript');
    default:
      return wrap(<VideoOff className={`${className} text-muted-foreground/50`} />, 'No conferencing link');
  }
}

export interface RecordingStripProps {
  model: RecordingStripModel;
  /** Replaces the model's text (e.g. clickable artifact badges). */
  children?: React.ReactNode;
  /** Fired for the model's action; the host decides what it means. */
  onAction?: (kind: StripActionKind) => void | Promise<void>;
  /** An `href` turns the action into a link (Open transcript). */
  actionHref?: string | null;
  /** Small muted note after the action ("asked 14:02", "uploading…"). */
  note?: string | null;
  /** Hide the glyph (the row already shows it in the title line). */
  noGlyph?: boolean;
  className?: string;
  /** Extra data-* attributes for tests. */
  data?: Record<string, string | undefined>;
}

export function RecordingStrip({
  model,
  children,
  onAction,
  actionHref,
  note,
  noGlyph = false,
  className = '',
  data,
}: RecordingStripProps) {
  const [busy, setBusy] = useState(false);
  const act = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!model.action || !onAction) return;
    setBusy(true);
    try {
      await onAction(model.action.kind);
    } finally {
      setBusy(false);
    }
  };
  const actionCls =
    'inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-primary/35 bg-primary/5 px-2 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60';
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 text-[11px] leading-5 ${TONE[model.tone]} ${className}`}
      data-status={model.state}
      title={model.title ?? undefined}
      {...Object.fromEntries(Object.entries(data ?? {}).filter(([, v]) => v !== undefined))}
    >
      {!noGlyph && <SourceGlyph source={model.source} className="h-3 w-3" />}
      {model.busy && (
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full ${
            model.state === 'recording' ? 'bg-red-500' : model.tone === 'warn' ? 'bg-amber-500' : 'bg-primary'
          }`}
          aria-hidden
        />
      )}
      <span className="min-w-0 truncate">{children ?? model.text}</span>
      {model.progress && model.progress.pct != null && (
        <span
          className="hidden h-1 w-20 shrink-0 overflow-hidden rounded-full bg-muted sm:inline-block"
          aria-hidden
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(2, Math.min(100, model.progress.pct))}%` }}
          />
        </span>
      )}
      {model.action &&
        (actionHref ? (
          <Link
            href={actionHref}
            onClick={(e) => e.stopPropagation()}
            className={actionCls}
            title={model.action.title}
            data-strip-action={model.action.kind}
          >
            {model.action.label}
          </Link>
        ) : onAction ? (
          <button
            type="button"
            disabled={busy}
            title={model.action.title}
            onClick={(e) => void act(e)}
            className={actionCls}
            data-strip-action={model.action.kind}
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {model.action.label}
          </button>
        ) : null)}
      {/* min-w-0, not shrink-0: a long note ("capture never finished — …")
          truncates inside the card instead of pushing past it. */}
      {note && (
        <span className="min-w-0 truncate text-muted-foreground" title={note}>
          · {note}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A Darth Recorder recording matched to a calendar occurrence — the
// interactive strip (upload from this Mac / ask the owner / open).

export interface RecorderRefStripProps {
  rec: RecorderRecordingRef;
  /** The occurrence, forwarded to the tray as the upload's linked event. */
  event: {
    id: string | null;
    title: string | null;
    startTime: string;
    endTime: string | null;
    meetingCode: string | null;
  };
  /** A Teams-chat verdict this strip replaces (kept in the tooltip). */
  originalNote?: string | null;
  /** The owner linked or dismissed the suggestion — the host refetches. */
  onChanged?: (what: 'linked' | 'dismissed') => void;
  className?: string;
}

export function RecorderRefStrip({ rec, event, originalNote, onChanged, className }: RecorderRefStripProps) {
  const companion = useCompanion();
  const [note, setNote] = useState<string | null>(null);
  const model = stripForRecorderRef(rec, {
    trayConnected: companion.connected,
    fmtDuration: formatDuration,
  });
  if (originalNote) model.title = `${model.title ?? ''} · ${originalNote}`;

  // No "Ask <first> to upload" any more (P2): the nudge acted on somebody
  // else's private recording, on the strength of a machine match, and the
  // route it posted to is gone.
  const onAction = async (kind: StripActionKind) => {
    setNote(null);
    if (kind === 'upload') {
      const ok = getCompanion().upload(rec.id, {
        id: event.id,
        title: event.title,
        startTime: event.startTime,
        endTime: event.endTime,
        meetingCode: event.meetingCode,
      });
      setNote(ok ? 'uploading…' : 'Open Darth Recorder on that Mac to upload it');
      return;
    }
    if (kind === 'open-recorder') {
      setNote('Open Darth Recorder on the Mac that holds the file');
    }
  };

  // Two ids, two meanings. `transcriptId` is arm (b): the server sets it
  // only when this recording is linked to a meeting the caller can already
  // open (P1) — before that it was built from a machine match and handed a
  // private meeting's id to people who were never shared on it.
  // `ownTranscriptId` is arm (a) and is served to the OWNER alone: a
  // recording is reachable by its owner whether or not anyone linked it, so
  // "Open recording" has somewhere to go.
  const openId = rec.transcriptId ?? (rec.mine ? rec.ownTranscriptId : null);

  // The owner's own row, when the meeting still carries a live suggestion
  // for THIS occurrence: the same strip the transcript page and the listing
  // mount, running the same link and dismiss routes. Nothing new is
  // implemented here — the server decides whether there is a suggestion at
  // all, and only a confident match ever becomes one.
  const suggestion =
    rec.mine && rec.ownTranscriptId && rec.suggestedEvent ? (
      <SuggestedEventStrip
        compact
        transcriptId={rec.ownTranscriptId}
        suggested={rec.suggestedEvent}
        onChanged={(what) => onChanged?.(what)}
      />
    ) : null;

  const strip = (
    <RecordingStrip
      model={model}
      onAction={onAction}
      actionHref={model.action?.kind === 'open' && openId ? `/transcript/${openId}` : null}
      note={note}
      className={className}
      data={{ 'data-recorder-recording': rec.status, 'data-recorder-mine': rec.mine ? '1' : '0' }}
    />
  );
  if (!suggestion) return strip;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {strip}
      {suggestion}
    </div>
  );
}

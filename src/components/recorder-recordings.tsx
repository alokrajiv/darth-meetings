'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Film,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  formatCompanionBytes,
  formatCompanionDuration,
  getCompanion,
  recordingMatchesEvent,
  recordingStatusLabel,
  sortRecordingsForPicker,
  useCompanion,
  useCompanionRecordings,
  type CompanionRecording,
  type CompanionUploadState,
} from '@/lib/companion/companion-client';

/**
 * "Recordings on this Mac" — the tray's local registry ({cmd:"list_recordings"}),
 * shared by the Settings recorder card and the upload dialog's "From Darth
 * Recorder on this Mac" source.
 *
 * Every degraded state renders as a sentence, never as a spinner that never
 * resolves:
 *  - no tray on the socket        → "Darth Recorder isn't running"
 *  - a pre-0.2.0 tray (0.1.5)     → "Update your recorder" + the version it is on
 *  - a 0.2.0 tray, empty registry → "No recordings on this Mac yet"
 * The list itself is read-only apart from Upload / Retry and Delete (0.3.8 —
 * files + folder off the Mac, row synced to the server as deleted, an uploaded
 * transcript untouched), which are ws commands; the tray owns the files.
 */

export type RecorderRecordingsProps = {
  /** false while a dialog is closed — we then never touch the socket. */
  enabled?: boolean;
  /** Attached to every {cmd:"upload"} this list sends (the dialog's chosen event). */
  linkedEvent?: unknown | null;
  /** Called after an upload command goes out (the dialog closes on it). */
  onUploadStarted?: (r: CompanionRecording) => void;
  /** Rows to show before "Show all" (0 = no cap). */
  limit?: number;
  compact?: boolean;
  /** Calendar event the surrounding dialog is about: its recording is pinned
   * first with a "this meeting" chip (docs/recorder-upload-ux.md P5). */
  pinEventId?: string | null;
  /** Show already-uploaded rows straight away. The Settings card does (it is a
   * history); the upload picker does not — they hide behind "Show N uploaded",
   * because a picker is for picking something to upload. */
  showUploaded?: boolean;
};

export function RecorderRecordings({
  enabled = true,
  linkedEvent = null,
  onUploadStarted,
  limit = 0,
  compact = false,
  pinEventId = null,
  showUploaded = true,
}: RecorderRecordingsProps) {
  const c = useCompanion();
  const { recordings, loading, error, refresh } = useCompanionRecordings(enabled);
  const [showAll, setShowAll] = useState(false);
  const [uploadedOpen, setUploadedOpen] = useState(false);

  // Newest first, the dialog's own recording on top. `deleted` rows are already
  // dropped upstream; the filter is a belt for a tray that lists them anyway.
  const sorted = useMemo(
    () => sortRecordingsForPicker(recordings.filter((r) => r.status !== 'deleted'), { eventId: pinEventId }),
    [recordings, pinEventId]
  );
  const visible = useMemo(
    () =>
      showUploaded || uploadedOpen
        ? sorted
        : // The pinned row stays even when it is already uploaded — hiding the
          // one row the dialog is about would be the worst possible fold.
          sorted.filter((r) => r.status !== 'uploaded' || recordingMatchesEvent(r, pinEventId)),
    [sorted, showUploaded, uploadedOpen, pinEventId]
  );
  const uploadedHiddenCount = sorted.length - visible.length;

  const note = (children: React.ReactNode) => (
    <p className="text-xs text-muted-foreground" data-recorder-recordings-note>
      {children}
    </p>
  );

  if (error === 'disconnected') {
    return note('Darth Recorder is not running on this Mac, so there is nothing to list.');
  }
  if (error === 'unsupported') {
    return (
      <div className="space-y-1" data-recorder-recordings-outdated>
        {note(
          <>
            Darth Recorder {c.version ? `v${c.version}` : 'on this Mac'} is too old to list its
            recordings — update your recorder (it updates itself within a few hours, or use
            “Check for updates” in its menu).
          </>
        )}
      </div>
    );
  }
  if (loading && recordings.length === 0) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking Darth Recorder…
      </p>
    );
  }
  if (recordings.length === 0) {
    return note('No recordings on this Mac yet. Press Record when a call is detected.');
  }

  const capped = limit > 0 && !showAll;
  const shown = capped ? visible.slice(0, limit) : visible;

  return (
    <div className="space-y-1.5" data-recorder-recordings>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto pr-1" data-recorder-recordings-scroll>
        {shown.length === 0 && note('Nothing waiting to be uploaded on this Mac.')}
        {shown.map((r) => (
          <Row
            key={r.id}
            r={r}
            pinned={recordingMatchesEvent(r, pinEventId)}
            upload={c.uploads[r.id]?.status === 'uploading' ? c.uploads[r.id] : null}
            compact={compact}
            onUpload={() => {
              getCompanion().upload(r.id, linkedEvent ?? r.matched ?? null);
              onUploadStarted?.(r);
            }}
            onDelete={() => {
              getCompanion().deleteRecording(r.id);
              // The tray's recording_deleted answer refetches; an older tray
              // never answers, so refetch anyway and the row simply stays.
              setTimeout(refresh, 800);
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        {capped && visible.length > shown.length && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            data-recorder-show-all
          >
            Show all ({visible.length})
          </button>
        )}
        {uploadedHiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setUploadedOpen(true)}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            data-recorder-show-uploaded
          >
            Show {uploadedHiddenCount} uploaded
          </button>
        )}
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
    </div>
  );
}

function Row({
  r,
  upload,
  pinned,
  compact,
  onUpload,
  onDelete,
}: {
  r: CompanionRecording;
  /** Live upload state off the socket, only while it is uploading. */
  upload: CompanionUploadState | null;
  /** This row is the recording for the meeting the dialog was opened on. */
  pinned?: boolean;
  compact: boolean;
  onUpload: () => void;
  onDelete: () => void;
}) {
  const when = r.started_at ? new Date(r.started_at) : null;
  const title =
    r.call?.title ||
    (r.call?.app ? `${r.call.app} call` : null) ||
    (when ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Recording');
  const sub = [
    when && (r.call?.title || r.call?.app)
      ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : null,
    r.duration ? formatCompanionDuration(r.duration) : null,
    r.bytes ? formatCompanionBytes(r.bytes) : null,
    r.files.length > 1 ? `${r.files.length} parts` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // One label for both cases: `recordingStatusLabel` already folds the live
  // upload state ("Uploading 43% · 298 MB of 696 MB · part 3 of 6").
  const status = recordingStatusLabel(
    upload ? { ...r, status: 'uploading' } : r,
    upload ?? undefined
  );
  const busy = r.status === 'uploading' || r.status === 'recording';

  return (
    <div
      className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5${
        pinned ? ' border-primary/40 bg-primary/[0.03]' : ''
      }`}
      data-recorder-recording
      data-status={r.status}
      data-recorder-pinned={pinned ? '' : undefined}
    >
      <Icon status={r.status} />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{title}</span>
          {pinned && (
            <span className="shrink-0 rounded-full border border-primary/40 px-1.5 text-[10px] font-normal text-primary">
              this meeting
            </span>
          )}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {sub}
          {sub ? ' · ' : ''}
          {status}
        </p>
      </div>
      {r.status === 'uploaded' && r.transcript_id ? (
        <Button size="sm" variant="outline" className="h-7 shrink-0 px-2.5 text-xs" asChild>
          <Link href={`/transcript/${r.transcript_id}`}>Open</Link>
        </Button>
      ) : r.status === 'uploaded' || r.status === 'deleted' ? null : (
        <Button
          size="sm"
          variant={r.status === 'upload_failed' ? 'outline' : 'default'}
          className="h-7 shrink-0 px-2.5 text-xs"
          disabled={busy}
          onClick={onUpload}
          data-recorder-upload
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {compact ? '' : r.status === 'upload_failed' ? 'Retry' : 'Upload'}
        </Button>
      )}
      {!busy && r.status !== 'deleted' && (
        <button
          type="button"
          title={
            r.status === 'uploaded'
              ? 'Delete the file from this Mac (the transcript stays)'
              : 'Delete this recording from this Mac — it was never uploaded, so it is gone for good'
          }
          aria-label="Delete from this Mac"
          onClick={() => {
            const what = r.status === 'uploaded' ? 'the local file (the transcript stays)' : 'this recording — it was never uploaded';
            if (window.confirm(`Delete ${what}?\n\n${title}`)) onDelete();
          }}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
          data-recorder-delete
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function Icon({ status }: { status: string }) {
  if (status === 'recording') return <CircleDot className="h-4 w-4 shrink-0 animate-pulse text-red-600" />;
  if (status === 'uploaded') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
  if (status === 'upload_failed') return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
  if (status === 'uploading') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
  return <Film className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

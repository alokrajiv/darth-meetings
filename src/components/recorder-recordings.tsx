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
import {
  formatCompanionBytes,
  formatCompanionDuration,
  getCompanion,
  recordingStatusLabel,
  useCompanion,
  useCompanionRecordings,
  type CompanionRecording,
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
};

export function RecorderRecordings({
  enabled = true,
  linkedEvent = null,
  onUploadStarted,
  limit = 0,
  compact = false,
}: RecorderRecordingsProps) {
  const c = useCompanion();
  const { recordings, loading, error, refresh } = useCompanionRecordings(enabled);

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

  const shown = limit > 0 ? recordings.slice(0, limit) : recordings;

  return (
    <div className="space-y-1.5" data-recorder-recordings>
      {shown.map((r) => (
        <Row
          key={r.id}
          r={r}
          pct={c.uploads[r.id]?.status === 'uploading' ? c.uploads[r.id].pct : null}
          compact={compact}
          onUpload={() => {
            getCompanion().upload(r.id, linkedEvent ?? r.matched ?? null);
            onUploadStarted?.(r);
          }}
          onDelete={() => {
            getCompanion().deleteRecording(r.id);
            // The tray's recording_deleted answer refetches; an older tray never
            // answers, so refetch anyway and the row simply stays.
            setTimeout(refresh, 800);
          }}
        />
      ))}
      <div className="flex items-center gap-3 pt-0.5">
        {limit > 0 && recordings.length > shown.length && (
          <span className="text-xs text-muted-foreground">
            +{recordings.length - shown.length} older on this Mac
          </span>
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
  pct,
  compact,
  onUpload,
  onDelete,
}: {
  r: CompanionRecording;
  pct: number | null;
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

  const status = recordingStatusLabel(r, pct != null ? { status: 'uploading', pct, segment: null, transcriptId: null, error: null, at: 0 } : undefined);
  const busy = r.status === 'uploading' || r.status === 'recording';

  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5"
      data-recorder-recording
      data-status={r.status}
    >
      <Icon status={r.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {sub}
          {sub ? ' · ' : ''}
          {pct != null ? `Uploading ${Math.round(pct)}%` : status}
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

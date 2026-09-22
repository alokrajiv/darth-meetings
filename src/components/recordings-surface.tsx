'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  CalendarSearch,
  Check,
  ExternalLink,
  Laptop,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { formatBytes, formatDuration, type TranscriptListRow, type TranscriptListV2Response } from '@/lib/format';
import { isBareRecording, meetingTitleOf, shortWhen } from '@/lib/meeting-title';
import { stripForArchiveRow, stripForRecorderRef, type StripActionKind } from '@/lib/recording-strip';
import type { RecorderMatch, RecorderRecordingRef } from '@/lib/recorder';
import { recorderRowIsConfident, RECORDING_STALE_MS } from '@/lib/recorder';
import {
  getCompanion,
  useCompanion,
  useCompanionRecordings,
} from '@/lib/companion/companion-client';
import { RecordingStrip, SourceGlyph } from '@/components/recording-strip';
import { LinkEventDialog } from '@/components/link-event-dialog';
import { OFFLINE_TITLE } from '@/lib/offline/offline-types';
import { isNetworkFailure, offlineAwareError } from '@/lib/offline/offline-fetch';

/**
 * The Recordings tab (docs/listing-ui-redesign.md §6): recordings that
 * belong to no meeting yet.
 *
 *  1. On your Macs — the caller's own Darth Recorder registry rows that
 *     are not uploaded (GET /api/recorder/recordings?mine=1).
 *  2. Uploaded, not linked to a meeting — archive rows that are BARE
 *     (no calendar event, no human title — lib/meeting-title).
 *
 * Linking or naming a recording promotes it into the archive; it leaves
 * this tab on the next refresh. Under the first-class model (D-B) section 2
 * reads `recordings` with no segment instead of filtering transcripts —
 * the cards stay the same.
 */

/** Own-registry row as /api/recorder/recordings?mine=1 serves it
 * (lib/server/recorder-view OwnRecordingView, re-declared here so no
 * server module is imported into the client bundle). */
export interface OwnRecorderRecording {
  id: string;
  device_id: string | null;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  bytes: number | null;
  segments: unknown;
  call: { title?: string; app?: string; kind?: string } | null;
  matched: RecorderMatch | null;
  /** The server's verdict on `matched` — the ONE definition of confident
   * (lib/server/recorder-view). Absent on a row the server matched before
   * 2026-09-22 17:00 SGT; `recorderRowIsConfident()` below re-derives it. */
  matched_confident?: boolean;
  transcript_id: string | null;
  error: string | null;
}

const MAC_PENDING = new Set(['recording', 'local', 'uploading', 'upload_failed']);

export interface UnlinkedRecordings {
  /** Bare archive rows (mine), newest first. */
  bare: TranscriptListRow[];
  /** Own registry rows (every status except deleted). */
  registry: OwnRecorderRecording[];
  /** Registry rows still on a Mac and not represented by a bare row. */
  onMac: OwnRecorderRecording[];
  loading: boolean;
  error: string | null;
  count: number;
  refresh: () => void;
}

function segmentCount(segments: unknown): number | null {
  return Array.isArray(segments) ? segments.length : null;
}

/**
 * Fetches both halves once, on demand, and folds them: a registry row that
 * already has a bare archive row (via `transcript_id` or the row's
 * `recorder_recording_id`) is one recording, not two.
 */
export function useUnlinkedRecordings(opts: { enabled: boolean; refreshKey: number; tz: string }): UnlinkedRecordings {
  const { enabled, refreshKey, tz } = opts;
  const [bare, setBare] = useState<TranscriptListRow[]>([]);
  const [registry, setRegistry] = useState<OwnRecorderRecording[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const genRef = useRef(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const companion = useCompanion();
  // Registry-dirtying tray events (upload done/failed, a recording stopped).
  const ev = companion.lastEvent;
  const evKey =
    ev && ['recording_stopped', 'upload_done', 'upload_failed', 'recording_deleted'].includes(ev.type) ? ev.at : 0;

  useEffect(() => {
    if (!enabled) return;
    const gen = ++genRef.current;
    let live = true;
    setLoading(true);
    const params = new URLSearchParams({ v: '2', tab: 'mine', tz, days: '60', minRows: '200' });
    void Promise.all([
      fetch(`/api/transcripts?${params.toString()}`, { credentials: 'include' }).then(async (res) => {
        if (!res.ok) throw await offlineAwareError(res, `Failed to load recordings (${res.status})`);
        return (await res.json()) as TranscriptListV2Response;
      }),
      fetch('/api/recorder/recordings?mine=1', { credentials: 'include' }).then(async (res) => {
        // The registry is optional: a user without a recorder simply has none.
        if (!res.ok) return { recordings: [] as OwnRecorderRecording[] };
        return (await res.json()) as { recordings: OwnRecorderRecording[] };
      }),
    ])
      .then(([list, reg]) => {
        if (!live || gen !== genRef.current) return;
        setBare(list.days.flatMap((d) => d.rows).filter((r) => isBareRecording(r)));
        setRegistry(reg.recordings.filter((r) => r.status !== 'deleted'));
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live || gen !== genRef.current) return;
        setError(isNetworkFailure(err) ? OFFLINE_TITLE : err instanceof Error ? err.message : 'Failed to load recordings');
      })
      .finally(() => {
        if (live && gen === genRef.current) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, refreshKey, nonce, evKey, tz]);

  const onMac = useMemo(() => {
    const byTranscript = new Set(bare.map((b) => b.assemblyai_id));
    const byRecorder = new Set(bare.map((b) => b.recorder_recording_id).filter(Boolean));
    return registry.filter(
      (r) =>
        MAC_PENDING.has(r.status) &&
        !byRecorder.has(r.id) &&
        !(r.transcript_id && byTranscript.has(r.transcript_id))
    );
  }, [bare, registry]);

  return {
    bare,
    registry,
    onMac,
    loading,
    error,
    count: bare.length + onMac.length,
    refresh,
  };
}

// ---------------------------------------------------------------------------

export interface RecordingsSurfaceProps {
  data: UnlinkedRecordings;
  disabled?: boolean;
  /** Something changed that the archive should notice (a link, a name, a trash). */
  onChanged?: () => void;
}

export function RecordingsSurface({ data, disabled = false, onChanged }: RecordingsSurfaceProps) {
  const { bare, registry, onMac, loading, error, refresh } = data;
  const companion = useCompanion();
  const tray = useCompanionRecordings(companion.connected);
  const trayIds = useMemo(() => new Set(tray.recordings.map((r) => r.id)), [tray.recordings]);
  const registryById = useMemo(() => new Map(registry.map((r) => [r.id, r])), [registry]);
  const [linkFor, setLinkFor] = useState<{ id: string; dateIso: string | null } | null>(null);

  const changed = useCallback(() => {
    refresh();
    onChanged?.();
  }, [refresh, onChanged]);

  const empty = !loading && !error && bare.length === 0 && onMac.length === 0;

  return (
    <div className="space-y-6" data-recordings-surface>
      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span className="truncate">{error}</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={refresh}>
            Retry
          </Button>
        </div>
      )}
      {loading && bare.length === 0 && onMac.length === 0 && !error && (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin" />
        </div>
      )}
      {empty && (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">
            <Laptop className="h-5 w-5 text-muted-foreground" />
          </div>
          <p className="mt-3 text-sm font-medium">Nothing waiting here</p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            A recording is yours and stays yours. When one looks like a meeting in your calendar it
            says so here and you decide — nothing is linked or shared on a match alone.
          </p>
        </div>
      )}

      {onMac.length > 0 && (
        <section>
          <SectionHeading
            title="On your Macs"
            count={onMac.length}
            sub={
              companion.connected
                ? 'Darth Recorder is connected on this Mac'
                : 'Darth Recorder is not connected on this Mac — uploads run from the Mac that holds the file'
            }
          />
          <div className="grid gap-2 md:grid-cols-2">
            {onMac.map((r) => (
              <MacCard
                key={r.id}
                r={r}
                trayHasIt={companion.connected && trayIds.has(r.id)}
                live={companion.uploads[r.id]?.status === 'uploading' ? companion.uploads[r.id] : null}
                disabled={disabled}
                onChanged={() => {
                  setTimeout(refresh, 800);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {bare.length > 0 && (
        <section>
          <SectionHeading
            title="Uploaded, not linked to a meeting"
            count={bare.length}
            sub="Link the calendar event or give it a name — it then moves into the meetings list"
          />
          <div className="grid gap-2 md:grid-cols-2">
            {bare.map((row) => (
              <BareCard
                key={row.assemblyai_id}
                row={row}
                reg={row.recorder_recording_id ? registryById.get(row.recorder_recording_id) ?? null : null}
                live={
                  row.recorder_recording_id && companion.uploads[row.recorder_recording_id]?.status === 'uploading'
                    ? companion.uploads[row.recorder_recording_id]
                    : null
                }
                disabled={disabled}
                onLink={() => setLinkFor({ id: row.assemblyai_id, dateIso: row.recorded_at ?? row.created_at })}
                onChanged={changed}
              />
            ))}
          </div>
        </section>
      )}

      {linkFor && (
        <LinkEventDialog
          open
          transcriptId={linkFor.id}
          initialDateIso={linkFor.dateIso}
          onClose={() => setLinkFor(null)}
          onLinked={() => {
            setLinkFor(null);
            changed();
          }}
        />
      )}
    </div>
  );
}

function SectionHeading({ title, count, sub }: { title: string; count: number; sub?: string }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-foreground/80">{title}</h3>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** "Looks like Data scrum · 14:00 · 82 %" — the matcher's best guess, shown
 * only when it is a confident one, and only ever to the owner. */
function MatchHint({ m, onLink, busy }: { m: RecorderMatch | null; onLink?: () => void; busy?: boolean }) {
  if (!m || !m.title) return null;
  const when = new Date(m.occ_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pct = Math.round((m.score ?? 0) * 100);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" data-match-hint>
      <CalendarSearch className="h-3 w-3 shrink-0" />
      <span className="min-w-0 truncate">
        Looks like <span className="text-foreground/80">{m.title}</span> · {when} · {pct}%
      </span>
      {onLink && (
        <button
          type="button"
          disabled={busy}
          onClick={onLink}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-primary/35 bg-primary/5 px-2 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-60"
          data-link-suggested
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
          Link to it
        </button>
      )}
    </div>
  );
}

function cardCls(extra = '') {
  return `flex min-w-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] ${extra}`;
}

// ---------------------------------------------------------------------------

function MacCard({
  r,
  trayHasIt,
  live,
  disabled,
  onChanged,
}: {
  r: OwnRecorderRecording;
  trayHasIt: boolean;
  live: { pct: number; bytesSent: number | null; bytesTotal: number | null; segment: number | null; segmentsTotal: number | null } | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const ref: RecorderRecordingRef = {
    id: r.id,
    mine: true,
    ownerEmail: null,
    hostname: null,
    status: live ? 'uploading' : r.status,
    startedAt: r.started_at,
    durationS: r.duration_s,
    transcriptId: r.transcript_id,
  };
  const model = stripForRecorderRef(ref, { trayConnected: trayHasIt, fmtDuration: formatDuration });
  if (live) {
    const parts: string[] = [`Uploading from your Mac · ${Math.round(live.pct)}%`];
    if (live.bytesSent != null && live.bytesTotal != null && live.bytesTotal > 0) {
      parts.push(`${formatBytes(live.bytesSent)} of ${formatBytes(live.bytesTotal)}`);
    }
    if (live.segment != null && live.segmentsTotal != null && live.segmentsTotal > 1) {
      parts.push(`part ${live.segment} of ${live.segmentsTotal}`);
    }
    model.text = parts.join(' · ');
    model.progress = { pct: live.pct, label: model.text, live: true };
  }
  const startedMs = r.started_at ? Date.parse(r.started_at) : NaN;
  const stale = r.status === 'recording' && Number.isFinite(startedMs) && Date.now() - startedMs > RECORDING_STALE_MS;
  const title = r.call?.title?.trim() || (r.call?.app ? `${r.call.app} call` : null) || `Recording · ${shortWhen(r.started_at)}`;
  const segs = segmentCount(r.segments);
  const meta = [
    r.call?.title ? shortWhen(r.started_at) : null,
    r.duration_s ? formatDuration(r.duration_s) : null,
    r.bytes ? formatBytes(r.bytes) : null,
    segs && segs > 1 ? `${segs} segments` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const onAction = (kind: StripActionKind) => {
    setNote(null);
    if (kind === 'upload') {
      // No linked event: the server has not linked an upload to a calendar
      // match since 6287854, and never will — linking is the person's
      // action, taken from the card's own suggestion or the Link dialog.
      const ok = getCompanion().upload(r.id, null);
      setNote(ok ? 'uploading…' : 'Open Darth Recorder on that Mac to upload it');
      onChanged();
    } else if (kind === 'open-recorder') {
      setNote('Open Darth Recorder on the Mac that holds the file');
    }
  };
  const busy = r.status === 'uploading' || (r.status === 'recording' && !stale) || !!live;

  return (
    <div className={cardCls()} data-recording-card="mac" data-status={r.status} data-recorder-recording={r.status} data-recorder-mine="1">
      <div className="flex min-w-0 items-start gap-2">
        <SourceGlyph source="mac" className="mt-1 h-3.5 w-3.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{title}</p>
          {meta && <p className="truncate text-[11px] text-muted-foreground">{meta}</p>}
        </div>
        {!busy && trayHasIt && (
          <button
            type="button"
            disabled={disabled}
            title="Delete this recording from this Mac — it was never uploaded, so it is gone for good"
            aria-label="Delete from this Mac"
            data-recorder-delete
            onClick={() => {
              if (window.confirm(`Delete this recording from this Mac? It was never uploaded.\n\n${title}`)) {
                getCompanion().deleteRecording(r.id);
                onChanged();
              }
            }}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <MatchHint m={recorderRowIsConfident(r) ? r.matched : null} />
      <RecordingStrip
        model={model}
        noGlyph
        onAction={onAction}
        note={note ?? (r.status === 'upload_failed' && r.error ? r.error : null)}
        disabled={disabled}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function BareCard({
  row,
  reg,
  live,
  disabled,
  onLink,
  onChanged,
}: {
  row: TranscriptListRow;
  reg: OwnRecorderRecording | null;
  live: { pct: number; bytesSent: number | null; bytesTotal: number | null } | null;
  disabled: boolean;
  onLink: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'name' | 'link' | 'trash' | 'retry' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const placeholder = row.status === 'uploading' || row.assemblyai_id.startsWith('defer-');
  const { primary, filename } = meetingTitleOf(row);
  const model =
    stripForArchiveRow(row, { live, fmtBytes: formatBytes, fmtDuration: formatDuration }) ??
    ({
      source: row.provider === 'gmeet' ? 'meet' : row.provider === 'teams' ? 'teams' : row.source === 'uploaded' ? 'file' : 'text',
      state: 'transcribed',
      tone: 'muted',
      text: [
        'Transcribed',
        row.duration ? formatDuration(row.duration) : null,
        row.speaker_count ? `${row.speaker_count} speaker${row.speaker_count === 1 ? '' : 's'}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      title: filename,
      progress: null,
      action: null,
      busy: false,
    } as const);
  const source = model.source;

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(isNetworkFailure(e) ? OFFLINE_TITLE : e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };
  const saveName = () =>
    run('name', async () => {
      const t = name.trim();
      if (!t) return;
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Rename failed (${res.status})`);
      setRenaming(false);
      onChanged();
    });
  const linkSuggested = () =>
    run('link', async () => {
      // Belt on the braces: the button only renders for a confident match.
      if (!recorderRowIsConfident(reg) || !reg?.matched?.event_key) return;
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/link-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventKey: reg.matched.event_key }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Link failed (${res.status})`);
      }
      onChanged();
    });
  const trash = () =>
    run('trash', async () => {
      if (placeholder && !window.confirm('Cancel this upload?')) return;
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Delete failed (${res.status})`);
      onChanged();
    });
  const retry = () =>
    run('retry', async () => {
      const res = await fetch(`/api/transcripts/${row.assemblyai_id}/retry-ingest`, { method: 'POST' });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `Retry failed (${res.status})`);
      }
      onChanged();
    });

  const iconBtn = 'h-7 gap-1 px-2 text-xs';
  return (
    <div className={cardCls()} data-recording-card="bare" data-status={row.status} data-row-id={row.assemblyai_id}>
      <div className="flex min-w-0 items-start gap-2">
        <SourceGlyph source={source} className="mt-1 h-3.5 w-3.5" title={filename ?? undefined} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(false);
                }}
                placeholder="Name this meeting"
                className="h-7 text-sm"
                data-rename-input
              />
              <Button type="submit" size="sm" variant="default" className="h-7 px-2" disabled={busy === 'name' || !name.trim()}>
                {busy === 'name' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setRenaming(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </form>
          ) : (
            <p className="truncate text-sm font-medium" title={filename ?? undefined}>
              {primary}
            </p>
          )}
          {!renaming && (
            <p className="truncate text-[11px] text-muted-foreground">
              {[
                new Date(row.recorded_at ?? row.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
                (row.recording_count ?? 1) > 1 ? `${row.recording_count} ${source === 'mac' ? 'segments' : 'parts'}` : null,
                reg?.bytes ? formatBytes(reg.bytes) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>
      <MatchHint
        m={recorderRowIsConfident(reg) ? reg!.matched : null}
        onLink={recorderRowIsConfident(reg) && reg!.matched!.event_key && !placeholder ? linkSuggested : undefined}
        busy={busy === 'link'}
      />
      <RecordingStrip
        model={model}
        noGlyph
        onAction={(k) => (k === 'retry' ? retry() : undefined)}
        disabled={disabled}
      />
      {err && <p className="text-[11px] text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        <Button size="sm" variant="outline" className={iconBtn} disabled={disabled || placeholder} onClick={onLink} data-link-meeting>
          <Link2 className="h-3.5 w-3.5" />
          Link to a meeting…
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={iconBtn}
          disabled={disabled || placeholder}
          onClick={() => {
            setName(row.title && !filename?.startsWith(row.title) ? row.title : '');
            setRenaming(true);
          }}
          data-name-meeting
        >
          <Pencil className="h-3.5 w-3.5" />
          Name…
        </Button>
        {!placeholder && (
          <Button size="sm" variant="ghost" className={iconBtn} onClick={() => router.push(`/transcript/${row.assemblyai_id}`)}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </Button>
        )}
        {row.access === 'owner' && (
          <Button
            size="sm"
            variant="ghost"
            className={`${iconBtn} ml-auto text-muted-foreground hover:text-destructive`}
            disabled={disabled || busy === 'trash'}
            onClick={trash}
            title={placeholder ? 'Cancel the upload' : 'Move to trash'}
          >
            {busy === 'trash' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        )}
        {row.status === 'uploading' && !live && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Upload className="h-3 w-3" /> in flight
          </span>
        )}
      </div>
    </div>
  );
}

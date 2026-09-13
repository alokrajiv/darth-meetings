'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2, CircleAlert, CloudDownload, CloudOff, Loader2 } from 'lucide-react';
import { useOffline } from '@/lib/offline/offline-context';
import { pinMeeting, unpinMeeting } from '@/lib/offline/offline-pins';
import { fetchOfflinePlan } from '@/lib/offline/offline-sync';
import { estimatePinBytes, levelIncludes } from '@/lib/offline/offline-urls';
import {
  AUDIO_BYTES_PER_SEC,
  OFFLINE_CHANGE_EVENT,
  TRANSCRIPT_ESTIMATE_BYTES,
  type PinLevel,
  type PinRecord,
  type PlanMeeting,
} from '@/lib/offline/offline-types';
import { formatBytes } from '@/lib/format';

/**
 * Per-meeting "keep on this device" chooser. The ladder is cumulative:
 * audio includes the transcript, video includes both (and the audio-only
 * derivative, so the player has something small to fall back on).
 *
 * The transcript page hands us what it already has (id, title, date,
 * duration); the exact media inventory (parts, byte sizes, whether the
 * recording has video) comes from /api/offline/plan?ids=<id> when the
 * dialog opens — that same row is passed to pinMeeting as `meta` so the
 * ledger carries the server's rev and the sync engine does not re-download
 * on its next pass.
 */

/** What the caller must know; `media` is optional — the dialog fetches it. */
export interface PinDialogMeeting {
  id: string;
  title: string | null;
  recordedAt: string | null;
  durationSec: number | null;
  media?: PlanMeeting['media'] | null;
}

const LEVELS: Array<{ value: PinLevel; label: string; hint: string }> = [
  { value: 'none', label: 'Not saved', hint: 'Removes it from this device and keeps the automatic policy from re-adding it.' },
  { value: 'transcript', label: 'Transcript', hint: 'Page, speakers, notes and report. Small and quick.' },
  { value: 'audio', label: 'Transcript + audio', hint: 'Adds a compact audio-only copy for playback with the transcript.' },
  { value: 'video', label: 'Transcript + audio + video', hint: 'Adds the full recording. Largest, best for detailed review.' },
];

const LEVEL_SHORT: Record<PinLevel, string> = {
  none: 'Not saved',
  transcript: 'Transcript',
  audio: 'Audio',
  video: 'Video',
};

function mediaHasVideo(media: PlanMeeting['media'] | null | undefined): boolean {
  if (!media) return false;
  return media.isVideo || media.parts.some((p) => p.isVideo);
}

function pinnedBytes(rec: PinRecord | undefined): number {
  if (!rec) return 0;
  return rec.bytes.transcript + rec.bytes.audio + rec.bytes.video;
}

export function OfflinePinDialog({
  open,
  onClose,
  meeting,
}: {
  open: boolean;
  onClose: () => void;
  meeting: PinDialogMeeting;
}) {
  const { pins, sw } = useOffline();
  const record = pins.find((p) => p.id === meeting.id);
  const [plan, setPlan] = useState<PlanMeeting | null>(null);
  const [planState, setPlanState] = useState<'idle' | 'loading' | 'ready' | 'gone' | 'error'>('idle');
  const [level, setLevel] = useState<PinLevel>(record?.level ?? 'transcript');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh plan row on every open (sizes / parts can change between visits).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPlanState('loading');
    setError(null);
    setLevel(record?.level ?? 'transcript');
    fetchOfflinePlan([meeting.id])
      .then((p) => {
        if (cancelled) return;
        const row = p.meetings.find((m) => m.id === meeting.id) ?? null;
        setPlan(row);
        setPlanState(row ? 'ready' : 'gone');
      })
      .catch(() => {
        if (cancelled) return;
        setPlan(null);
        setPlanState('error');
      });
    return () => {
      cancelled = true;
    };
    // record?.level is only the initial selection — do not re-run on ledger updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meeting.id]);

  const media = plan?.media ?? meeting.media ?? null;
  const durationSec = plan?.durationSec ?? meeting.durationSec;
  const hasLocal = media ? media.hasLocal : false;
  const hasVideo = mediaHasVideo(media);
  const mediaKnown = planState === 'ready' || !!meeting.media;

  const estimates = useMemo(() => {
    const constants = { transcript: TRANSCRIPT_ESTIMATE_BYTES, audioPerSec: AUDIO_BYTES_PER_SEC };
    const out = {} as Record<PinLevel, number>;
    for (const l of LEVELS) out[l.value] = estimatePinBytes(l.value, { durationSec, media }, constants);
    return out;
  }, [durationSec, media]);

  const disabledFor = (l: PinLevel): string | null => {
    if (l === 'none' || l === 'transcript') return null;
    if (!mediaKnown) return planState === 'loading' ? 'Checking the recording…' : 'Recording details unavailable';
    if (!hasLocal) return 'No recording stored for this meeting';
    if (l === 'video' && !hasVideo) return 'Recording is audio-only';
    return null;
  };

  // The download can take minutes (a 202 poll while ffmpeg transcodes, then
  // GBs of video); the ledger flips to 'pending' the moment the record is
  // written and the chip / settings row show progress from there, so the
  // modal closes as soon as that first write lands. Only a failure BEFORE
  // the record exists (no IndexedDB, quota) is surfaced here.
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await Promise.race([
        pinMeeting(meeting.id, level, { manual: true, meta: plan }),
        firstPinEvent(meeting.id),
      ]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const resetToAuto = async () => {
    setSaving(true);
    setError(null);
    try {
      await unpinMeeting(meeting.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset');
    } finally {
      setSaving(false);
    }
  };

  const currentLabel = record && record.level !== 'none' ? LEVEL_SHORT[record.level] : 'Not saved';
  const progressPct =
    record?.status === 'pending' && estimates[record.level] > 0
      ? Math.min(99, Math.round((pinnedBytes(record) / estimates[record.level]) * 100))
      : null;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <CloudDownload className="h-4 w-4" />
            Save for offline
          </DialogTitle>
          <DialogDescription className="truncate">{meeting.title || 'Untitled meeting'}</DialogDescription>
        </DialogHeader>

        {sw === 'unsupported' && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            This browser can’t keep pages offline (no service worker or cache storage).
          </p>
        )}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>On this device:</span>
          <StatusPill record={record} />
          <span className="font-medium text-foreground">{currentLabel}</span>
          {record && pinnedBytes(record) > 0 && <span>· {formatBytes(pinnedBytes(record))}</span>}
          {record?.manual && <span>· chosen by you</span>}
        </div>
        {progressPct !== null && <Progress value={progressPct} className="h-1.5" />}
        {record?.status === 'error' && record.error && (
          <p className="text-xs text-destructive">Last attempt failed: {record.error}</p>
        )}

        <fieldset className="space-y-2" disabled={saving || sw === 'unsupported'}>
          {LEVELS.map((l) => {
            const why = disabledFor(l.value);
            return (
              <label
                key={l.value}
                className={`flex items-start gap-2.5 rounded-md border px-3 py-2 ${
                  why ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/50'
                } ${level === l.value ? 'border-primary/50 bg-primary/5' : ''}`}
                title={why ?? undefined}
              >
                <input
                  type="radio"
                  name="offline-pin-level"
                  className="mt-0.5 h-4 w-4 accent-primary"
                  checked={level === l.value}
                  disabled={!!why}
                  onChange={() => setLevel(l.value)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2 text-sm">
                    <span>{l.label}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {l.value === 'none' ? '' : `~${formatBytes(estimates[l.value])}`}
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">{why ?? l.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        {planState === 'gone' && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            This meeting is no longer available to you on the server; only what is already saved can be kept.
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter className="sm:items-center sm:justify-between">
          {record?.manual ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
              disabled={saving}
              onClick={() => void resetToAuto()}
              title="Forget your choice and let the automatic policy decide (removes the saved copy)"
            >
              Reset to automatic
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving || sw === 'unsupported'}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Resolves on the first ledger event for `id` (the 'pending' write). */
function firstPinEvent(id: string): Promise<void> {
  return new Promise((resolve) => {
    const onChange = (ev: Event) => {
      const d = (ev as CustomEvent<{ kind?: string; id?: string }>).detail;
      if (d?.kind === 'pin' && d.id === id) {
        window.removeEventListener(OFFLINE_CHANGE_EVENT, onChange);
        resolve();
      }
    };
    window.addEventListener(OFFLINE_CHANGE_EVENT, onChange);
  });
}

function StatusPill({ record }: { record: PinRecord | undefined }) {
  if (!record || record.level === 'none') return <CloudOff className="h-3.5 w-3.5" />;
  if (record.status === 'pending') return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (record.status === 'error') return <CircleAlert className="h-3.5 w-3.5 text-destructive" />;
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />;
}

/**
 * Inline chip for the transcript page header: the meeting's offline level
 * and status. With `meeting` it becomes a button that opens the dialog
 * (and shows "Save offline" when nothing is pinned yet); without it the
 * chip is display-only and renders nothing when the meeting isn't pinned.
 */
export function OfflinePinStatus({ id, meeting, className = '' }: { id: string; meeting?: PinDialogMeeting; className?: string }) {
  const { pins, sw } = useOffline();
  const [open, setOpen] = useState(false);
  const record = pins.find((p) => p.id === id);
  const pinned = !!record && record.level !== 'none';

  if (sw === 'unsupported') return null;
  if (!pinned && !meeting) return null;

  const label = pinned
    ? record.status === 'pending'
      ? `Saving ${LEVEL_SHORT[record.level].toLowerCase()}…`
      : record.status === 'error'
        ? 'Offline save failed'
        : `Offline: ${LEVEL_SHORT[record.level].toLowerCase()}`
    : 'Save offline';
  const title = pinned
    ? `Kept on this device at ${LEVEL_SHORT[record.level].toLowerCase()} level${record.manual ? ' (your choice)' : ' (automatic)'}${
        levelIncludes(record.level, 'audio') ? ' — playable offline' : ''
      }`
    : 'Keep this meeting on this device for offline use';

  const chip = (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs ${
        pinned
          ? record.status === 'error'
            ? 'border-destructive/40 text-destructive'
            : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'border-dashed text-muted-foreground hover:text-foreground'
      } ${className}`}
    >
      <StatusPill record={record} />
      <span className="hidden md:inline">{label}</span>
    </span>
  );

  if (!meeting) {
    return (
      <span title={title} data-offline-pin-status>
        {chip}
      </span>
    );
  }
  return (
    <>
      <button type="button" title={title} onClick={() => setOpen(true)} data-offline-pin-status>
        {chip}
      </button>
      <OfflinePinDialog open={open} onClose={() => setOpen(false)} meeting={meeting} />
    </>
  );
}

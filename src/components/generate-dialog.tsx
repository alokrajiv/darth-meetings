'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FileText, Film, Sparkles, Clock } from 'lucide-react';

interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Context the AI hasn't seen since the last run (stale banner). */
  staleLabels: string[];
  hasLocalVideo: boolean;
  canFetchVideo: boolean;
  /** Recording still being prepared by the provider — video mode queues. */
  videoPreparing: boolean;
  /** Recording bytes currently downloading — video mode waits, then starts. */
  videoFetching: boolean;
  generating: boolean;
  onGenerate: (opts: {
    video: boolean;
    instructions: string;
    /** T4: ISO instant to run the detailed report at, instead of now. */
    runAt?: string;
  }) => void;
}

/**
 * The single generation dialog. Since 2026-09-21 a run always writes BOTH
 * tiers — the quick summary and the detailed report — so there is nothing to
 * tick: the only choices are the report's flavour (video frames vs text
 * only) and when to run it. One run produces both: the report fires and the
 * summary auto-distills from that same session afterwards.
 */
export function GenerateDialog({
  open,
  onOpenChange,
  staleLabels,
  hasLocalVideo,
  canFetchVideo,
  videoPreparing,
  videoFetching,
  generating,
  onGenerate,
}: GenerateDialogProps) {
  const videoAvailable = hasLocalVideo || canFetchVideo || videoPreparing;
  const [instructions, setInstructions] = useState('');
  const [useVideo, setUseVideo] = useState(true);
  // T4: when to run the detailed report. 'now' | 'tonight' (next 02:00
  // local) | 'custom' with a datetime-local value.
  const [runWhen, setRunWhen] = useState<'now' | 'tonight' | 'custom'>('now');
  const [runCustom, setRunCustom] = useState('');

  const runAtIso = (): string | undefined => {
    if (runWhen === 'now') return undefined;
    if (runWhen === 'tonight') {
      const t = new Date();
      t.setHours(2, 0, 0, 0);
      if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
      return t.toISOString();
    }
    const t = new Date(runCustom);
    return Number.isNaN(t.getTime()) || t.getTime() <= Date.now() ? undefined : t.toISOString();
  };

  // Fresh choices each time the dialog opens; instructions intentionally
  // survive a close-reopen within the page visit.
  useEffect(() => {
    if (open) {
      setRunWhen('now');
      setRunCustom('');
      setUseVideo(true);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Generate with Claude</DialogTitle>
          <DialogDescription className="text-xs">
            Optional instructions steer the run — tone, depth, focus, or language.
          </DialogDescription>
        </DialogHeader>
        {staleLabels.length > 0 && (
          <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <Sparkles className="mr-1.5 inline h-3.5 w-3.5 text-primary" />
            New since the last run:{' '}
            <span className="font-medium text-foreground">{staleLabels.join(', ')}</span>. The AI
            folds these in — it may decide nothing needs changing.
          </p>
        )}
        <Textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={
            'e.g. "be very detailed", "focus on action items and owners", "keep it to five bullets"'
          }
          rows={2}
          maxLength={2000}
          className="text-sm"
        />
        <div className="space-y-1.5">
          <div className="rounded-md border p-3 text-sm">
            <span className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4 text-primary" />
              Summary + detailed report
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Both are always written. The detailed report is the wiki-style deep dive at high
              effort — topic sections, tables, click-to-jump citations — and the quick summary
              distills from that same session right after.
            </span>
          </div>
          {videoAvailable && (
            <div className="space-y-1.5 rounded-md border p-3">
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="generate-report-mode"
                  className="mt-0.5"
                  checked={useVideo}
                  disabled={generating}
                  onChange={() => setUseVideo(true)}
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <Film className="h-3.5 w-3.5 text-primary" />
                    With video frames
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    Claude looks at the screen shares and embeds screenshots.
                    {!hasLocalVideo &&
                      (videoPreparing
                        ? ' The recording is still being prepared — the report queues and starts on its own the moment the video lands.'
                        : videoFetching
                          ? ' The recording is still downloading — the report waits for it, then starts.'
                          : ' The recording is pulled first, then the report starts.')}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="generate-report-mode"
                  className="mt-0.5"
                  checked={!useVideo}
                  disabled={generating}
                  onChange={() => setUseVideo(false)}
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                    Text only
                  </span>
                  <span className="mt-0.5 block text-muted-foreground">
                    Cheaper; use when the meeting had no screen share worth seeing.
                  </span>
                </span>
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 px-1 pt-1 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              Run
            </span>
            <select
              className="rounded border bg-background px-1.5 py-1"
              value={runWhen}
              disabled={generating}
              onChange={(e) => setRunWhen(e.target.value as 'now' | 'tonight' | 'custom')}
            >
              <option value="now">now</option>
              <option value="tonight">tonight (02:00)</option>
              <option value="custom">at…</option>
            </select>
            {runWhen === 'custom' && (
              <input
                type="datetime-local"
                className="rounded border bg-background px-1.5 py-1"
                value={runCustom}
                onChange={(e) => setRunCustom(e.target.value)}
              />
            )}
            {runWhen !== 'now' && (
              <span className="text-muted-foreground">
                the summary distills after the report lands
              </span>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={generating}
            onClick={() =>
              onGenerate({
                video: videoAvailable && useVideo,
                instructions,
                runAt: runAtIso(),
              })
            }
          >
            <Sparkles className="h-4 w-4" />
            {runAtIso() ? 'Schedule summary + report' : 'Generate summary + report'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

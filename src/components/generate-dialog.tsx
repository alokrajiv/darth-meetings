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
  /** Pre-tick the detailed option (dialog opened from the report tab). */
  defaultDetailed: boolean;
  onGenerate: (opts: {
    detailed: boolean;
    video: boolean;
    instructions: string;
    /** T4: ISO instant to run the detailed report at, instead of now. */
    runAt?: string;
  }) => void;
}

/**
 * The single generation dialog: the quick summary is always written; the
 * detailed report is an opt-in on top with a video-frames/text-only mode
 * choice. When detailed is picked only the report run fires — the summary
 * auto-distills from that session afterwards, so "summary always" is free.
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
  defaultDetailed,
  onGenerate,
}: GenerateDialogProps) {
  const videoAvailable = hasLocalVideo || canFetchVideo || videoPreparing;
  const [instructions, setInstructions] = useState('');
  const [detailed, setDetailed] = useState(defaultDetailed);
  const [useVideo, setUseVideo] = useState(true);
  // T4: when to run the detailed report. 'now' | 'tonight' (next 02:00
  // local) | 'custom' with a datetime-local value.
  const [runWhen, setRunWhen] = useState<'now' | 'tonight' | 'custom'>('now');
  const [runCustom, setRunCustom] = useState('');

  const runAtIso = (): string | undefined => {
    if (!detailed || runWhen === 'now') return undefined;
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
      setDetailed(defaultDetailed);
      setUseVideo(true);
    }
  }, [open, defaultDetailed]);

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
          <label className="flex items-start gap-2 rounded-md border p-3">
            <input type="checkbox" className="mt-0.5" checked disabled readOnly />
            <span className="text-sm">
              <span className="flex items-center gap-2 font-medium">
                <Sparkles className="h-4 w-4 text-primary" />
                Quick summary
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Always written — fast and clean. Remembers earlier runs of this meeting when the
                session is still fresh.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[:checked]:border-primary">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={detailed}
              disabled={generating}
              onChange={(e) => setDetailed(e.target.checked)}
            />
            <span className="min-w-0 flex-1 text-sm">
              <span className="flex items-center gap-2 font-medium">
                <FileText className="h-4 w-4 text-primary" />
                Also write a detailed report
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Wiki-style deep dive at high effort: topic sections, tables, and click-to-jump
                citations. Slower and pricier. The quick summary then distills from it.
              </span>
              {detailed && videoAvailable && (
                <span className="mt-2 block space-y-1.5">
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <input
                      type="radio"
                      name="generate-report-mode"
                      className="mt-0.5"
                      checked={useVideo}
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
                </span>
              )}
              {detailed && (
                <span className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="flex items-center gap-1.5 font-medium">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                    Run
                  </span>
                  <select
                    className="rounded border bg-background px-1.5 py-1"
                    value={runWhen}
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
                </span>
              )}
            </span>
          </label>
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
                detailed,
                video: detailed && videoAvailable && useVideo,
                instructions,
                runAt: runAtIso(),
              })
            }
          >
            <Sparkles className="h-4 w-4" />
            {detailed
              ? runAtIso()
                ? 'Schedule report + summary'
                : 'Generate report + summary'
              : 'Generate summary'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

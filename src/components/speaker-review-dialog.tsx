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
import { Input } from '@/components/ui/input';
import { Check, Mic, RefreshCw, Sparkles } from 'lucide-react';
import type { SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';
import { defaultSpeakerLabel, speakerColorVar } from '@/lib/speaker-display';

interface SpeakerReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unique raw speaker keys, in display order. */
  speakers: string[];
  utteranceCounts: Record<string, number>;
  speakerLabels: SpeakerLabel[];
  suggestions: SpeakerSuggestionMap;
  /** The speaker-ID AI pass is still running — more suggestions may land. */
  identifying: boolean;
  /** Save the entered names (batch) and start summary generation. */
  onConfirm: (names: Record<string, string>) => Promise<void>;
  /** Generate without touching the labels. */
  onSkip: () => void;
}

/**
 * The review interrupt between "transcript is ready" and "summary is
 * generated": AI-suggested names for each diarized speaker, editable, with
 * the evidence shown — the human finalizes labels once, then the summary is
 * written with real names from the start (instead of regenerating later).
 */
export function SpeakerReviewDialog({
  open,
  onOpenChange,
  speakers,
  utteranceCounts,
  speakerLabels,
  suggestions,
  identifying,
  onConfirm,
  onSkip,
}: SpeakerReviewDialogProps) {
  const initialNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const sp of speakers) {
      const confirmed = speakerLabels
        .find((l) => l.originalSpeaker === sp)
        ?.customName.trim();
      names[sp] = confirmed || suggestions[sp]?.name?.trim() || '';
    }
    return names;
  }, [speakers, speakerLabels, suggestions]);

  const [names, setNames] = useState<Record<string, string>>(initialNames);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Late-arriving suggestions (the AI pass finishing while the dialog is
  // open) fill fields the user hasn't touched — never overwrite their edits.
  useEffect(() => {
    setNames((prev) => {
      const next = { ...prev };
      for (const sp of speakers) {
        if (!dirty.has(sp) && !next[sp] && initialNames[sp]) next[sp] = initialNames[sp];
      }
      return next;
    });
  }, [initialNames, speakers, dirty]);

  const filledCount = speakers.filter((sp) => (names[sp] ?? '').trim()).length;
  // Every name was already human-confirmed (a rerun after an earlier
  // generation): the gate stays — the summary is still written with these
  // names — but "the AI guessed" would be wrong, so the copy changes.
  const allConfirmed =
    speakers.length > 0 &&
    speakers.every(
      (sp) => !!speakerLabels.find((l) => l.originalSpeaker === sp)?.customName.trim()
    );

  return (
    <Dialog open={open} onOpenChange={(v) => !submitting && onOpenChange(v)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">
            Who&apos;s who in this meeting?
          </DialogTitle>
          <DialogDescription className="text-xs">
            {allConfirmed
              ? 'All names were confirmed earlier — a quick glance is enough. The summary is written with these names, so fix anything that looks off before generating.'
              : `The AI guessed names from the transcript${identifying ? '' : ', voiceprints, and video'} — fix anything wrong, then generate. The summary is written with these names, so a minute here beats regenerating later.`}
          </DialogDescription>
        </DialogHeader>

        {identifying && (
          <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin text-primary" />
            The AI is still identifying speakers (transcript, voiceprints, video) — guesses will
            appear here as they land.
          </div>
        )}

        <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
          {speakers.map((sp) => {
            const suggestion = suggestions[sp];
            const confirmed = !!speakerLabels
              .find((l) => l.originalSpeaker === sp)
              ?.customName.trim();
            const count = utteranceCounts[sp] ?? 0;
            return (
              <div key={sp} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: speakerColorVar(sp) }}
                  />
                  <span className="w-24 shrink-0 truncate text-xs text-muted-foreground">
                    {defaultSpeakerLabel(sp)} · {count} {count === 1 ? 'line' : 'lines'}
                  </span>
                  <Input
                    value={names[sp] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setNames((prev) => ({ ...prev, [sp]: v }));
                      setDirty((prev) => new Set(prev).add(sp));
                    }}
                    placeholder="Name…"
                    className="h-8 text-sm"
                    disabled={submitting}
                  />
                </div>
                <div className="mt-1 flex items-center gap-1.5 pl-[18px] text-[11px] text-muted-foreground">
                  {confirmed ? (
                    <>
                      <Check className="h-3 w-3 shrink-0 text-primary" />
                      confirmed earlier
                    </>
                  ) : suggestion ? (
                    suggestion.source === 'voice' ? (
                      <>
                        <Mic className="h-3 w-3 shrink-0" />
                        {Math.round(suggestion.confidence * 100)}% voice match — hint, not proof
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3 w-3 shrink-0" />
                        <span className="truncate" title={suggestion.evidence}>
                          {suggestion.evidence || 'guessed from context'}
                        </span>
                      </>
                    )
                  ) : (
                    <span className="italic">no guess — name them if you can</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            disabled={submitting}
            onClick={onSkip}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline sm:mr-auto"
          >
            Skip — generate without names
          </button>
          <Button
            size="sm"
            disabled={submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onConfirm(names);
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <Sparkles className="h-4 w-4" />
            {submitting
              ? 'Saving…'
              : allConfirmed
                ? 'Looks right — generate summary'
                : `Confirm ${filledCount}/${speakers.length} & generate summary`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

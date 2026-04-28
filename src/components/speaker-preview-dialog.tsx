'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  Headphones,
} from 'lucide-react';
import { formatTime, type SpeakerLabel } from '@/lib/format';
import { defaultSpeakerLabel } from '@/lib/speaker-display';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface PreviewSegment {
  /** Index of the focus utterance (the long one by the target speaker). */
  focusIdx: number;
  /** Indices included in this snippet (before-context + focus + after-context). */
  contextIdxs: number[];
}

interface SpeakerPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The raw AAI speaker key (A/B/C). */
  originalSpeaker: string;
  utterances: Utterance[];
  speakerLabels: SpeakerLabel[];
  /** /api/transcripts/[id]/audio */
  audioSrc: string;
}

const TOP_N_SEGMENTS = 5;
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;

/**
 * Pick the speaker's longest N utterances by character length — those are
 * the moments where they actually said something distinctive. Each pick gets
 * ±2 turns of surrounding context so the user can hear who they're
 * responding to and the back-and-forth.
 */
function buildSegments(utterances: Utterance[], speaker: string): PreviewSegment[] {
  const indexed = utterances
    .map((u, i) => ({ u, i }))
    .filter((x) => x.u.speaker === speaker);

  // Sort by text length desc — longer = more distinctive content.
  indexed.sort((a, b) => b.u.text.length - a.u.text.length);

  const seenFocus = new Set<number>();
  const out: PreviewSegment[] = [];

  for (const { i } of indexed) {
    if (out.length >= TOP_N_SEGMENTS) break;
    if (seenFocus.has(i)) continue;
    const start = Math.max(0, i - CONTEXT_BEFORE);
    const end = Math.min(utterances.length - 1, i + CONTEXT_AFTER);
    const contextIdxs: number[] = [];
    for (let j = start; j <= end; j++) contextIdxs.push(j);
    out.push({ focusIdx: i, contextIdxs });
    // Avoid neighbouring picks that would render the same context twice.
    for (let j = start; j <= end; j++) seenFocus.add(j);
  }

  return out;
}

export function SpeakerPreviewDialog({
  open,
  onOpenChange,
  originalSpeaker,
  utterances,
  speakerLabels,
  audioSrc,
}: SpeakerPreviewDialogProps) {
  const segments = useMemo(
    () => buildSegments(utterances, originalSpeaker),
    [utterances, originalSpeaker]
  );

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const mapping = speakerLabels.find((m) => m.originalSpeaker === originalSpeaker);
  const displayName = mapping?.customName?.trim() || defaultSpeakerLabel(originalSpeaker);

  // Reset to first segment whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setCursor(0);
    } else {
      audioRef.current?.pause();
      setPlaying(false);
    }
  }, [open]);

  const currentSegment = segments[cursor];
  const focusStartSec = useMemo(() => {
    if (!currentSegment) return null;
    const u = utterances[currentSegment.focusIdx];
    return u ? u.start / 1000 : null;
  }, [currentSegment, utterances]);

  /**
   * Seek the inline audio to the snippet's focus start. Robust against the
   * audio element not having metadata yet — falls back to a one-shot
   * loadedmetadata listener and triggers `load()` to nudge it along.
   */
  const seekToFocus = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || focusStartSec == null) return;
    const apply = () => {
      try {
        audio.currentTime = focusStartSec;
      } catch {
        // ignore — readyState wasn't sufficient yet
      }
    };
    if (audio.readyState >= 1) {
      apply();
    } else {
      const onMeta = () => {
        apply();
        audio.removeEventListener('loadedmetadata', onMeta);
      };
      audio.addEventListener('loadedmetadata', onMeta, { once: true });
      audio.load();
    }
  }, [focusStartSec]);

  // Whenever the snippet changes (or the dialog opens), seek to the new
  // focus. We don't auto-play — user explicitly clicks ▶ to avoid surprise
  // audio.
  useEffect(() => {
    if (open) seekToFocus();
  }, [open, seekToFocus]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      // Always start the snippet from the focus utterance, even if the
      // user previously scrubbed somewhere else with the native controls.
      seekToFocus();
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const seekTo = (utteranceIdx: number) => {
    const u = utterances[utteranceIdx];
    if (!u) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = u.start / 1000;
    if (audio.paused) void audio.play();
  };

  const next = () => setCursor((c) => (c + 1) % Math.max(segments.length, 1));
  const prev = () =>
    setCursor((c) => (c - 1 + Math.max(segments.length, 1)) % Math.max(segments.length, 1));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Headphones className="h-4 w-4" />
            Preview {displayName}
            <Badge variant="outline" className="text-[10px]">
              {defaultSpeakerLabel(originalSpeaker)}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Cycle through this speaker&apos;s most distinctive moments to put
            a voice to the label.
          </DialogDescription>
        </DialogHeader>

        {segments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No utterances by {displayName} found in this transcript.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={prev}
                disabled={segments.length < 2}
                title="Previous snippet"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-xs text-muted-foreground">
                Snippet {cursor + 1} of {segments.length}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={next}
                disabled={segments.length < 2}
                title="Next snippet"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="rounded-md border bg-card p-3">
              <div className="space-y-2 max-h-[55vh] min-h-[260px] overflow-y-auto">
                {currentSegment?.contextIdxs.map((idx) => {
                  const u = utterances[idx];
                  if (!u) return null;
                  const focus = idx === currentSegment.focusIdx;
                  const m = speakerLabels.find((x) => x.originalSpeaker === u.speaker);
                  const name = m?.customName?.trim() || defaultSpeakerLabel(u.speaker);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => seekTo(idx)}
                      className={`block w-full rounded-md p-2 text-left transition-colors ${
                        focus
                          ? 'bg-amber-50 ring-1 ring-amber-200'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex items-baseline gap-2 text-xs text-muted-foreground mb-1">
                        <Badge
                          variant={focus ? 'default' : 'outline'}
                          className="text-[10px]"
                        >
                          {name}
                        </Badge>
                        <span className="font-mono">{formatTime(u.start)}</span>
                      </div>
                      <div className={`text-sm ${focus ? 'font-medium' : ''}`}>
                        {u.text}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
              <Button
                size="sm"
                variant="default"
                onClick={togglePlay}
                title={playing ? 'Pause' : 'Play snippet'}
              >
                {playing ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
              <audio
                ref={audioRef}
                src={audioSrc}
                preload="metadata"
                controls
                className="h-9 flex-1"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

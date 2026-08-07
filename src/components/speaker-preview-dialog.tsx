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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Play,
  Pause,
  Headphones,
  Pencil,
  X,
} from 'lucide-react';
import { formatTime, type SpeakerLabel } from '@/lib/format';
import { defaultSpeakerLabel } from '@/lib/speaker-display';
import { UserPicker, type PickerPerson } from '@/components/user-picker';

interface Utterance {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface PreviewSegment {
  focusIdx: number;
  contextIdxs: number[];
}

interface SpeakerPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Speaker to start on (raw AAI key like "A"). */
  initialSpeaker: string;
  /** All unique speakers in the transcript, in display order. */
  speakers: string[];
  utterances: Utterance[];
  speakerLabels: SpeakerLabel[];
  /** /api/transcripts/[id]/audio — null when the transcript has no playable
   *  audio; the dialog still works for editing names + context. */
  audioSrc: string | null;
  /** The stored file has a video stream — offer a "Show video" toggle so you
   *  can see who's talking while identifying speakers. */
  hasVideo?: boolean;
  canEdit: boolean;
  onSave: (
    originalSpeaker: string,
    patch: { customName?: string; description?: string }
  ) => void;
  onPickPerson?: (person: PickerPerson) => void;
  onRequestCreatePerson?: (originalSpeaker: string, name: string) => void;
}

const TOP_N_SEGMENTS = 5;
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 2;

function buildSegments(utterances: Utterance[], speaker: string): PreviewSegment[] {
  const indexed = utterances
    .map((u, i) => ({ u, i }))
    .filter((x) => x.u.speaker === speaker);
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
    for (let j = start; j <= end; j++) seenFocus.add(j);
  }
  return out;
}

function fmtHMS(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * "Identify speaker" workspace. Cycle through every speaker, hear their
 * most distinctive snippets, and set their name + context inline — all
 * without leaving the dialog.
 */
export function SpeakerPreviewDialog({
  open,
  onOpenChange,
  initialSpeaker,
  speakers,
  utterances,
  speakerLabels,
  audioSrc,
  hasVideo,
  canEdit,
  onSave,
  onPickPerson,
  onRequestCreatePerson,
}: SpeakerPreviewDialogProps) {
  const [speaker, setSpeaker] = useState(initialSpeaker);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editingName, setEditingName] = useState(false);
  // Audio or video element, depending on the toggle — same seek/play API.
  const audioRef = useRef<HTMLMediaElement | null>(null);
  const [videoOn, setVideoOn] = useState(false);
  // Carry position/play-state across the audio<->video element swap.
  const carryRef = useRef<{ t: number; playing: boolean } | null>(null);

  const toggleVideo = () => {
    const el = audioRef.current;
    carryRef.current = el
      ? { t: el.currentTime, playing: !el.paused && !el.ended }
      : null;
    setVideoOn((v) => !v);
  };

  // After the element swap, restore where we were.
  useEffect(() => {
    const carried = carryRef.current;
    const el = audioRef.current;
    if (!carried || !el) return;
    carryRef.current = null;
    const apply = () => {
      try {
        el.currentTime = carried.t;
      } catch {
        /* ignore */
      }
      if (carried.playing) void el.play().catch(() => {});
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
  }, [videoOn]);

  // Reset to the requested speaker each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSpeaker(initialSpeaker);
      setCursor(0);
      setEditingName(false);
    } else {
      audioRef.current?.pause();
      setPlaying(false);
    }
  }, [open, initialSpeaker]);

  const segments = useMemo(() => buildSegments(utterances, speaker), [utterances, speaker]);
  const lineCount = useMemo(
    () => utterances.filter((u) => u.speaker === speaker).length,
    [utterances, speaker]
  );

  const mapping = speakerLabels.find((m) => m.originalSpeaker === speaker);
  const displayName = mapping?.customName?.trim() || defaultSpeakerLabel(speaker);

  // Local drafts for the editable name / description, synced from props.
  const [nameDraft, setNameDraft] = useState(mapping?.customName ?? '');
  const [descDraft, setDescDraft] = useState(mapping?.description ?? '');
  useEffect(() => {
    setNameDraft(mapping?.customName ?? '');
    setDescDraft(mapping?.description ?? '');
    setEditingName(false);
  }, [speaker, mapping?.customName, mapping?.description]);

  const speakerIdx = Math.max(0, speakers.indexOf(speaker));
  const nextSpeaker = () => {
    if (speakers.length < 2) return;
    setSpeaker(speakers[(speakerIdx + 1) % speakers.length]!);
    setCursor(0);
  };
  const prevSpeaker = () => {
    if (speakers.length < 2) return;
    setSpeaker(speakers[(speakerIdx - 1 + speakers.length) % speakers.length]!);
    setCursor(0);
  };

  const currentSegment = segments[cursor];
  const focusStartSec = useMemo(() => {
    if (!currentSegment) return null;
    const u = utterances[currentSegment.focusIdx];
    return u ? u.start / 1000 : null;
  }, [currentSegment, utterances]);

  const seekToFocus = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || focusStartSec == null) return;
    const apply = () => {
      try {
        audio.currentTime = focusStartSec;
      } catch {
        /* readyState too low */
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

  useEffect(() => {
    if (open) seekToFocus();
  }, [open, seekToFocus]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
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

  const nextSnippet = () => setCursor((c) => (c + 1) % Math.max(segments.length, 1));
  const prevSnippet = () =>
    setCursor((c) => (c - 1 + Math.max(segments.length, 1)) % Math.max(segments.length, 1));

  const commitName = (value: string) => {
    setEditingName(false);
    const trimmed = value.trim();
    setNameDraft(trimmed);
    if (trimmed !== (mapping?.customName ?? '')) {
      onSave(speaker, { customName: trimmed });
    }
  };

  const commitDesc = () => {
    const trimmed = descDraft.trim();
    if (trimmed !== (mapping?.description ?? '')) {
      onSave(speaker, { description: trimmed });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Headphones className="h-4 w-4" />
            Identify speakers
            {speakers.length > 1 && (
              <Badge variant="outline" className="text-[10px]">
                {speakerIdx + 1} / {speakers.length}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            Cycle through each speaker, hear their distinctive moments, and
            set their name + context — all from here.
          </DialogDescription>
        </DialogHeader>

        {/* Speaker selector */}
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2">
          <Button
            variant="outline"
            size="sm"
            onClick={prevSpeaker}
            disabled={speakers.length < 2}
            title="Previous speaker"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="default">{defaultSpeakerLabel(speaker)}</Badge>
            <span className="font-medium">{displayName}</span>
            <span className="text-xs text-muted-foreground">
              {lineCount} line{lineCount === 1 ? '' : 's'}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={nextSpeaker}
            disabled={speakers.length < 2}
            title="Next speaker"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Inline name + description editing */}
        {canEdit && (
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
            <div>
              {editingName ? (
                <UserPicker
                  mode="freeform"
                  initialValue={nameDraft}
                  placeholder="Name or email"
                  onSelect={(sel) => {
                    if (sel.type === 'person') {
                      commitName(sel.person.name);
                      onPickPerson?.(sel.person);
                    }
                  }}
                  onCustomSubmit={(text) => {
                    setEditingName(false);
                    if (onRequestCreatePerson) {
                      onRequestCreatePerson(speaker, text);
                    } else {
                      commitName(text);
                    }
                  }}
                  onCancel={() => setEditingName(false)}
                />
              ) : (
                <div
                  onDoubleClick={() => setEditingName(true)}
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm hover:bg-muted/40 cursor-default"
                  title="Double-click to edit"
                >
                  <span className={`truncate flex-1 ${nameDraft.trim() ? '' : 'text-muted-foreground italic'}`}>
                    {nameDraft.trim() || 'Set a name'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="rounded p-1 text-muted-foreground/70 hover:bg-muted hover:text-foreground"
                    title="Edit name"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
            <Textarea
              value={descDraft}
              placeholder="Context (role, voice, who they are — optional)"
              rows={2}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={commitDesc}
            />
          </div>
        )}

        {!audioSrc ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            No playable audio for this transcript — name &amp; context editing only.
          </p>
        ) : segments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No utterances by {displayName} in this transcript.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={prevSnippet}
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
                onClick={nextSnippet}
                disabled={segments.length < 2}
                title="Next snippet"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="rounded-md border bg-card p-3">
              <div
                className={`space-y-2 overflow-y-auto ${
                  videoOn ? 'max-h-[20vh]' : 'max-h-[42vh] min-h-[200px]'
                }`}
              >
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
                          ? 'bg-amber-50 ring-1 ring-amber-200 dark:bg-amber-950/30 dark:ring-amber-800'
                          : 'hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex items-baseline gap-2 text-xs text-muted-foreground mb-1">
                        <Badge variant={focus ? 'default' : 'outline'} className="text-[10px]">
                          {name}
                        </Badge>
                        <span className="font-mono">{formatTime(u.start)}</span>
                      </div>
                      <div className={`text-sm ${focus ? 'font-medium' : ''}`}>{u.text}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {videoOn && (
              <video
                ref={(el) => {
                  audioRef.current = el;
                }}
                src={audioSrc}
                preload="auto"
                controls
                playsInline
                className="max-h-[32vh] w-full rounded-md bg-black"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
            )}
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2">
              <Button
                size="sm"
                variant="default"
                onClick={togglePlay}
                title={playing ? 'Pause' : 'Play snippet'}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
              {videoOn ? (
                <span className="flex-1" />
              ) : (
                <audio
                  ref={(el) => {
                    audioRef.current = el;
                  }}
                  src={audioSrc}
                  preload="auto"
                  controls
                  className="h-9 flex-1"
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />
              )}
              {hasVideo && (
                <button
                  type="button"
                  onClick={toggleVideo}
                  title={
                    videoOn
                      ? 'Back to audio-only'
                      : 'See who’s on screen while you identify speakers'
                  }
                  className="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted"
                >
                  {videoOn ? <X className="h-3 w-3" /> : <Film className="h-3 w-3" />}
                  {videoOn ? 'Hide video' : 'Show video'}
                </button>
              )}
              {focusStartSec != null && (
                <span className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">
                  starts at <span className="font-mono">{fmtHMS(focusStartSec)}</span>
                </span>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

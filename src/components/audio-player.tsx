'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Film, X } from 'lucide-react';

export interface AudioPlayerHandle {
  /** Seek to a position (seconds) and start playing. */
  seekToSeconds: (seconds: number) => void;
  /** Seek to a position (seconds) WITHOUT changing play/pause state. */
  seekOnly: (seconds: number) => void;
  /** Pause without changing position. */
  pause: () => void;
  /** Whether audio is currently playing. */
  isPlaying: () => boolean;
}

interface AudioPlayerProps {
  /** URL to fetch audio from — typically `/api/transcripts/[id]/audio`. */
  src: string;
  /** The stored file contains a video stream — offer a video toggle. */
  hasVideo?: boolean;
  /** Called every `timeupdate` with the current time in seconds. */
  onTimeUpdate?: (seconds: number) => void;
  /** Called once the media's metadata is ready — the parent uses this to
   * apply a pending seek after swapping src (multi-video part switch). */
  onLoadedMetadata?: () => void;
  /** Called when the audio fails to load (so the parent can hide the player). */
  onError?: () => void;
  /** Optional className for layout. */
  className?: string;
}

/**
 * Thin imperative wrapper around `<audio controls>` — or, when the stored
 * recording is a video and the user toggles it on, a `<video controls>`
 * (same src, same element API; the video's audio track plays either way).
 * Position and play state carry over when switching modes.
 *
 * Why a wrapper at all? So the transcript page can call `seekToSeconds(start)`
 * when the user clicks an utterance, without having to manage a raw media
 * ref or thread state through props. The parent owns the highlight state
 * (driven by onTimeUpdate); we own playback.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, hasVideo, onTimeUpdate, onLoadedMetadata, onError, className }, ref) {
    const mediaRef = useRef<HTMLMediaElement | null>(null);
    const [videoOn, setVideoOn] = useState(false);
    // Carry position/play-state across the audio<->video element swap.
    const carryRef = useRef<{ t: number; playing: boolean } | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        seekToSeconds(seconds: number) {
          const el = mediaRef.current;
          if (!el) return;
          el.currentTime = seconds;
          // Best-effort autoplay; browsers may block on first interaction.
          void el.play().catch(() => {});
        },
        seekOnly(seconds: number) {
          const el = mediaRef.current;
          if (!el) return;
          // Avoid clobbering currentTime before metadata is ready (some
          // browsers throw INDEX_SIZE_ERR otherwise).
          if (el.readyState >= 1) {
            try {
              el.currentTime = seconds;
            } catch {
              /* ignore */
            }
          }
        },
        pause() {
          mediaRef.current?.pause();
        },
        isPlaying() {
          const el = mediaRef.current;
          return !!el && !el.paused && !el.ended;
        },
      }),
      []
    );

    const toggleVideo = () => {
      const el = mediaRef.current;
      carryRef.current = el
        ? { t: el.currentTime, playing: !el.paused && !el.ended }
        : null;
      setVideoOn((v) => !v);
    };

    // After the element swap, restore where we were.
    useEffect(() => {
      const carried = carryRef.current;
      const el = mediaRef.current;
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

    const mediaEvents = {
      onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) =>
        onTimeUpdate?.((e.target as HTMLMediaElement).currentTime),
      onLoadedMetadata: () => onLoadedMetadata?.(),
      onError: () => onError?.(),
    };

    return (
      <div className="relative">
        {videoOn ? (
          <video
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={src}
            controls
            preload="metadata"
            playsInline
            className="max-h-[50vh] w-full rounded-md bg-black"
            {...mediaEvents}
          />
        ) : (
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={src}
            controls
            preload="metadata"
            className={className ?? 'w-full'}
            {...mediaEvents}
          />
        )}
        {hasVideo && (
          <button
            type="button"
            onClick={toggleVideo}
            title={videoOn ? 'Back to audio-only' : 'Show the video (screen shares) while playing'}
            className={
              videoOn
                ? 'absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white hover:bg-black/80'
                : 'mt-1 flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted'
            }
          >
            {videoOn ? <X className="h-3 w-3" /> : <Film className="h-3 w-3" />}
            {videoOn ? 'Hide video' : 'Show video'}
          </button>
        )}
      </div>
    );
  }
);

'use client';

import { forwardRef, useImperativeHandle, useRef } from 'react';

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
  /** Called every `timeupdate` with the current time in seconds. */
  onTimeUpdate?: (seconds: number) => void;
  /** Called when the audio fails to load (so the parent can hide the player). */
  onError?: () => void;
  /** Optional className for layout. */
  className?: string;
}

/**
 * Thin imperative wrapper around `<audio controls>`.
 *
 * Why a wrapper at all? So the transcript page can call `seekToSeconds(start)`
 * when the user clicks an utterance, without having to manage a raw <audio>
 * ref or thread state through props. The parent owns the highlight state
 * (driven by onTimeUpdate); we own playback.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, onTimeUpdate, onError, className }, ref) {
    const audioRef = useRef<HTMLAudioElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        seekToSeconds(seconds: number) {
          const el = audioRef.current;
          if (!el) return;
          el.currentTime = seconds;
          // Best-effort autoplay; browsers may block on first interaction.
          void el.play().catch(() => {});
        },
        seekOnly(seconds: number) {
          const el = audioRef.current;
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
          audioRef.current?.pause();
        },
        isPlaying() {
          const el = audioRef.current;
          return !!el && !el.paused && !el.ended;
        },
      }),
      []
    );

    return (
      <audio
        ref={audioRef}
        src={src}
        controls
        preload="metadata"
        className={className ?? 'w-full'}
        onTimeUpdate={(e) => onTimeUpdate?.((e.target as HTMLAudioElement).currentTime)}
        onError={() => onError?.()}
      />
    );
  }
);

'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
  /** Media Session (lock screen / headset buttons) metadata. When absent the
   * title is taken from `document.title` (the transcript page sets it to
   * "<meeting> · Darth Meetings"). */
  mediaTitle?: string;
  /** Second line on the lock screen — e.g. the meeting date. */
  mediaSubtitle?: string;
}

/** Suffix the transcript page appends to document.title. */
const TITLE_SUFFIX_RE = /\s*·\s*Darth Meetings\s*$/;
const SEEK_STEP_SEC = 10;
const PROBE_TIMEOUT_MS = 4000;

/**
 * The audio-only URL for a media route URL, spelled EXACTLY as
 * lib/offline/offline-urls.ts spells it (`variant=audio` first, then
 * `part=N`): the service worker matches cached media on the full
 * path+query, so a 'video' offline pin — which caches both the recording
 * and the extract under these two keys — keeps serving the player from
 * cache in either mode. Null when the URL already names a variant.
 */
function audioVariantUrl(src: string): string | null {
  if (/[?&]variant=/.test(src)) return null;
  const [path, q] = src.split('?');
  return `${path}?variant=audio${q ? `&${q}` : ''}`;
}

/**
 * Thin imperative wrapper around `<audio controls>` — or, when the stored
 * recording is a video and the user toggles it on, a `<video controls>`
 * (same element API; the video's audio track plays either way). Position
 * and play state carry over when switching modes.
 *
 * Audio mode on a video recording streams the 64 kbps audio-only extract
 * (`?variant=audio`, ~30 MB/h) instead of the whole mp4 (100–500 MB/h):
 * a one-off two-byte Range probe on mount asks the route whether the
 * extract is ready (206) — otherwise (202 still preparing, 5xx, offline)
 * the full recording is used exactly as before. The video toggle always
 * plays the recording itself.
 *
 * Media Session: title/date/app icon on the lock screen and play / pause /
 * ±10 s / scrub from headset buttons and notification controls. Skipped
 * silently where `navigator.mediaSession` does not exist.
 *
 * Why a wrapper at all? So the transcript page can call `seekToSeconds(start)`
 * when the user clicks an utterance, without having to manage a raw media
 * ref or thread state through props. The parent owns the highlight state
 * (driven by onTimeUpdate); we own playback.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer(
    { src, hasVideo, onTimeUpdate, onLoadedMetadata, onError, className, mediaTitle, mediaSubtitle },
    ref
  ) {
    const mediaRef = useRef<HTMLMediaElement | null>(null);
    const [videoOn, setVideoOn] = useState(false);
    // Carry position/play-state across the audio<->video element swap.
    const carryRef = useRef<{ t: number; playing: boolean } | null>(null);
    // URL the <audio> element uses: the extract when it is ready, else src.
    // null = probe in flight (element not mounted yet — a few ms).
    const [audioSrc, setAudioSrc] = useState<string | null>(() =>
      hasVideo && audioVariantUrl(src) ? null : src
    );

    useEffect(() => {
      const variant = hasVideo ? audioVariantUrl(src) : null;
      if (!variant) {
        setAudioSrc(src);
        return;
      }
      setAudioSrc(null);
      let cancelled = false;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      fetch(variant, {
        headers: { Range: 'bytes=0-1' },
        credentials: 'same-origin',
        signal: ctrl.signal,
      })
        .then((r) => {
          void r.body?.cancel().catch(() => {});
          if (!cancelled) setAudioSrc(r.status === 206 || r.status === 200 ? variant : src);
        })
        .catch(() => {
          if (!cancelled) setAudioSrc(src);
        })
        .finally(() => clearTimeout(timer));
      return () => {
        cancelled = true;
        clearTimeout(timer);
        ctrl.abort();
      };
    }, [src, hasVideo]);

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

    // ---- Media Session -------------------------------------------------
    const applyMetadata = useCallback(() => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      const fromDocument =
        typeof document !== 'undefined' ? document.title.replace(TITLE_SUFFIX_RE, '').trim() : '';
      const title = mediaTitle?.trim() || fromDocument || 'Meeting recording';
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title,
          artist: mediaSubtitle?.trim() || 'Darth Meetings',
          album: 'Darth Meetings',
          artwork: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        });
      } catch {
        /* MediaMetadata missing or rejected — controls still work */
      }
    }, [mediaTitle, mediaSubtitle]);

    useEffect(() => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      applyMetadata();
      const el = () => mediaRef.current;
      const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
        ['play', () => void el()?.play().catch(() => {})],
        ['pause', () => el()?.pause()],
        [
          'seekbackward',
          (d) => {
            const m = el();
            if (m) m.currentTime = Math.max(0, m.currentTime - (d.seekOffset ?? SEEK_STEP_SEC));
          },
        ],
        [
          'seekforward',
          (d) => {
            const m = el();
            if (!m) return;
            const max = Number.isFinite(m.duration) ? m.duration : Infinity;
            m.currentTime = Math.min(max, m.currentTime + (d.seekOffset ?? SEEK_STEP_SEC));
          },
        ],
        [
          'seekto',
          (d) => {
            const m = el();
            if (!m || typeof d.seekTime !== 'number') return;
            if (d.fastSeek && typeof m.fastSeek === 'function') m.fastSeek(d.seekTime);
            else m.currentTime = d.seekTime;
          },
        ],
      ];
      const set = new Set<MediaSessionAction>();
      for (const [action, handler] of handlers) {
        try {
          ms.setActionHandler(action, handler);
          set.add(action);
        } catch {
          /* action not supported by this browser */
        }
      }
      return () => {
        for (const action of set) {
          try {
            ms.setActionHandler(action, null);
          } catch {
            /* ignore */
          }
        }
        try {
          ms.metadata = null;
          ms.playbackState = 'none';
        } catch {
          /* ignore */
        }
      };
    }, [applyMetadata]);

    const syncPositionState = (m: HTMLMediaElement) => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      if (typeof ms.setPositionState !== 'function') return;
      const duration = m.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        ms.setPositionState({
          duration,
          playbackRate: m.playbackRate || 1,
          position: Math.min(Math.max(0, m.currentTime), duration),
        });
      } catch {
        /* out-of-range values throw — harmless */
      }
    };
    const setPlaybackState = (state: MediaSessionPlaybackState) => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.playbackState = state;
      } catch {
        /* ignore */
      }
    };

    const mediaEvents = {
      onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        const m = e.target as HTMLMediaElement;
        onTimeUpdate?.(m.currentTime);
        syncPositionState(m);
      },
      onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        syncPositionState(e.target as HTMLMediaElement);
        onLoadedMetadata?.();
      },
      onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        // The page sets document.title after its own fetch — re-read it now.
        applyMetadata();
        setPlaybackState('playing');
        syncPositionState(e.target as HTMLMediaElement);
      },
      onPause: () => setPlaybackState('paused'),
      onRateChange: (e: React.SyntheticEvent<HTMLMediaElement>) =>
        syncPositionState(e.target as HTMLMediaElement),
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
        ) : audioSrc ? (
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={audioSrc}
            controls
            preload="metadata"
            className={className ?? 'w-full'}
            {...mediaEvents}
          />
        ) : (
          // Probe in flight — keep the row's height so nothing jumps.
          <div className={className ?? 'h-10 w-full'} aria-hidden />
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

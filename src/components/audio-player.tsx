'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Film, Pause, Play, X } from 'lucide-react';
import {
  clampMeetingMs,
  fileMsOf,
  holeAt,
  meetingMsOf,
  pastWindowEnd,
  windowDurationMs,
  type PlaybackWindow,
} from '@/lib/clip-window';
import { formatTimestamp, type ClipHole } from '@/lib/clips';

/**
 * Every second in this interface is MEETING time — what the transcript shows
 * and what a `t:` chip means. With a window (Phase 3a) that is file time
 * minus `windowFromMs`; the player does the mapping so no caller has to
 * (lib/clip-window.ts).
 */
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
  /**
   * D6 (docs/recorder-link-confirm-spec.md): what to say INSTEAD of the
   * video toggle when there is no video. Until 2026-09-22 the spot was
   * simply empty, which reads as "video is broken" rather than "this call
   * was never captured with one" — see lib/suggested-event.ts noVideoNote().
   * Ignored when `hasVideo` is true.
   */
  noVideoNote?: string | null;
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
  /**
   * The window of the file this meeting is (Phase 3a — a meeting split off a
   * longer recording). null/undefined = the whole file, which is every
   * meeting that was never split.
   *
   * Nothing is cut: `/audio` serves the same bytes. The PLAYER clamps —
   * playback starts at `fromMs`, stops at `toMs`, the scrubber spans the
   * window and the clock reads from 0. Native controls cannot lie about a
   * file's duration, so a windowed player draws its own transport.
   */
  window?: PlaybackWindow | null;
  /**
   * Stretches of THIS meeting's timeline that are now a meeting of their own
   * (the source's side of a split). Not its content any more, so playback
   * skips them.
   */
  holes?: ClipHole[];
}

/** Suffix the transcript page appends to document.title. */
const TITLE_SUFFIX_RE = /\s*·\s*Darth Meetings\s*$/;
const SEEK_STEP_SEC = 10;
const PROBE_TIMEOUT_MS = 4000;

/**
 * "Answer from the app, don't 302 me to Blob" (DEC-3 Stage B,
 * lib/server/media-serve.ts). The probe below sends it because a
 * cross-origin `fetch()` carrying a `Range` header would need a CORS
 * preflight against the storage account.
 *
 * The `<audio>` / `<video>` elements themselves cannot send headers, and do
 * not need to: a media element's load is `no-cors`, `Range` is safelisted
 * for it, and it follows the cross-origin redirect and seeks against Blob
 * with no CORS rule at all.
 */
const VIA_APP_HEADER = { 'x-darth-media-via': 'app' } as const;

/** `?via=app` — the URL form of the same thing, for the last-ditch retry. */
function viaAppUrl(url: string): string {
  return url.includes('?') ? `${url}&via=app` : `${url}?via=app`;
}

/**
 * The audio-only URL for a media route URL (`variant=audio` first, then
 * any existing query such as `part=N`). Null when the URL already names a
 * variant.
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
 * extract is ready (206) — otherwise (202 still preparing, 5xx, no network)
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
    {
      src,
      hasVideo,
      noVideoNote,
      onTimeUpdate,
      onLoadedMetadata,
      onError,
      className,
      mediaTitle,
      mediaSubtitle,
      // `window` as a prop name reads right at the call site and would be a
      // trap in here, where the global is used for timers — so it is renamed
      // exactly once, on the way in.
      window: clipWindow = null,
      holes,
    },
    ref
  ) {
    const mediaRef = useRef<HTMLMediaElement | null>(null);
    // Live in a ref too: the media event handlers below are recreated every
    // render, but the imperative handle and the Media Session handlers are
    // not, and they all have to map through the SAME window.
    const windowRef = useRef<PlaybackWindow | null>(clipWindow);
    windowRef.current = clipWindow;
    const holesRef = useRef<ClipHole[]>(holes ?? []);
    holesRef.current = holes ?? [];
    const windowed = clipWindow !== null;
    /** File seconds for a MEETING position. */
    const toFileSec = useCallback(
      (meetingSec: number) => fileMsOf(meetingSec * 1000, windowRef.current) / 1000,
      []
    );
    /** MEETING seconds for a file position. */
    const toMeetingSec = useCallback(
      (fileSec: number) => meetingMsOf(fileSec * 1000, windowRef.current) / 1000,
      []
    );
    // What the custom transport renders. Only kept in state when there IS a
    // window — a plain player leaves the native controls to do this.
    const [position, setPosition] = useState(0); // meeting seconds
    const [spanSec, setSpanSec] = useState<number | null>(null);
    const [playing, setPlaying] = useState(false);
    const [scrubbing, setScrubbing] = useState<number | null>(null);
    const [videoOn, setVideoOn] = useState(false);
    // Carry position/play-state across the audio<->video element swap.
    const carryRef = useRef<{ t: number; playing: boolean } | null>(null);
    // Stage B recovery (see handleMediaError): how many times this URL has
    // been re-requested, and whether we have fallen back to `?via=app`.
    const reloadsRef = useRef(0);
    const [forceViaApp, setForceViaApp] = useState(false);
    // URL the <audio> element uses: the extract when it is ready, else src.
    // null = probe in flight (element not mounted yet — a few ms).
    const [audioSrc, setAudioSrc] = useState<string | null>(() =>
      hasVideo && audioVariantUrl(src) ? null : src
    );

    // A new recording (or part) starts with a clean recovery budget.
    useEffect(() => {
      reloadsRef.current = 0;
      setForceViaApp(false);
    }, [src]);

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
        headers: { Range: 'bytes=0-1', ...VIA_APP_HEADER },
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
          el.currentTime = toFileSec(seconds);
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
              el.currentTime = toFileSec(seconds);
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
      [toFileSec]
    );

    /**
     * The file seconds a ±N-second nudge lands on, kept inside the window.
     * Without the clamp, "forward 10 s" at the end of a 13-minute part would
     * start playing the meeting next door.
     */
    const seekWithin = useCallback(
      (m: HTMLMediaElement, deltaSec: number): number => {
        const fileDuration = Number.isFinite(m.duration) ? m.duration * 1000 : null;
        const target = toMeetingSec(m.currentTime) + deltaSec;
        return toFileSec(clampMeetingMs(target * 1000, windowRef.current, fileDuration) / 1000);
      },
      [toFileSec, toMeetingSec]
    );

    /**
     * Keep playback inside this meeting: start at the window, stop at its
     * end, and step over a hole that belongs to a meeting split off this one.
     * Returns the MEETING seconds the caller should report.
     */
    const clampPlayhead = useCallback((m: HTMLMediaElement): number => {
      const w = windowRef.current;
      if (w && m.currentTime * 1000 < w.fromMs - 250) {
        // Before the window: the initial seek has not landed (or a native
        // control was used on a browser that still shows one).
        try {
          m.currentTime = w.fromMs / 1000;
        } catch {
          /* metadata not ready yet — the loadedmetadata seek will do it */
        }
        return 0;
      }
      if (pastWindowEnd(m.currentTime * 1000, w)) {
        m.pause();
        try {
          m.currentTime = w!.toMs! / 1000;
        } catch {
          /* ignore */
        }
        return meetingMsOf(w!.toMs!, w) / 1000;
      }
      const meetingMs = meetingMsOf(m.currentTime * 1000, w);
      const hole = holeAt(holesRef.current, meetingMs);
      if (hole) {
        // Not this meeting's content any more — step over it rather than
        // play somebody else's conversation.
        try {
          m.currentTime = fileMsOf(hole.toMs, w) / 1000;
        } catch {
          /* ignore */
        }
        return hole.toMs / 1000;
      }
      return meetingMs / 1000;
    }, []);

    const toggleVideo = () => {
      const el = mediaRef.current;
      carryRef.current = el
        ? { t: el.currentTime, playing: !el.paused && !el.ended }
        : null;
      setVideoOn((v) => !v);
    };

    // After the element swap (or a `?via=app` fallback), restore where we were.
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
    }, [videoOn, forceViaApp]);

    /**
     * A media `error`, and what DEC-3 Stage B made of it.
     *
     * The app answers `/api/…/audio` with a 302 to a SAS that lives 60
     * minutes. A recording longer than that — or simply left paused — will
     * one day ask Blob for the next byte range with a signature that has
     * expired, and the element reports a plain network/decode error. That is
     * recoverable and the user must not notice: re-request the SAME app URL
     * (a fresh 302, a fresh SAS) and resume at the same second.
     *
     * A failure with NO progress at all is a different animal: the redirect
     * itself did not work for this browser / worker combination. One retry
     * with `?via=app` pins the answer to the app (local bytes, same origin,
     * no redirect) and playback continues, slower but correct.
     *
     * Only when both are spent does the parent hear `onError` — which is what
     * hides the player or falls back to part 1.
     */
    const handleMediaError = () => {
      const el = mediaRef.current;
      if (!el) {
        onError?.();
        return;
      }
      const progressed = el.readyState >= 1 || el.currentTime > 0;
      const carried = { t: el.currentTime, playing: !el.paused && !el.ended };

      if (progressed && reloadsRef.current === 0) {
        reloadsRef.current = 1;
        carryRef.current = carried;
        try {
          el.load(); // same src → new request → new 302 → new SAS
        } catch {
          onError?.();
          return;
        }
        const apply = () => {
          try {
            el.currentTime = carried.t;
          } catch {
            /* ignore */
          }
          if (carried.playing) void el.play().catch(() => {});
        };
        carryRef.current = null;
        if (el.readyState >= 1) apply();
        else el.addEventListener('loadedmetadata', apply, { once: true });
        return;
      }

      if (!forceViaApp) {
        reloadsRef.current = 2;
        carryRef.current = carried;
        setForceViaApp(true);
        return;
      }

      onError?.();
    };

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
            if (m) m.currentTime = seekWithin(m, -(d.seekOffset ?? SEEK_STEP_SEC));
          },
        ],
        [
          'seekforward',
          (d) => {
            const m = el();
            if (m) m.currentTime = seekWithin(m, d.seekOffset ?? SEEK_STEP_SEC);
          },
        ],
        [
          'seekto',
          (d) => {
            const m = el();
            if (!m || typeof d.seekTime !== 'number') return;
            // `seekTime` comes back in the units setPositionState reported —
            // meeting seconds.
            const file = toFileSec(d.seekTime);
            if (d.fastSeek && typeof m.fastSeek === 'function') m.fastSeek(file);
            else m.currentTime = file;
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
    }, [applyMetadata, seekWithin, toFileSec]);

    const syncPositionState = (m: HTMLMediaElement) => {
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      if (typeof ms.setPositionState !== 'function') return;
      // The lock screen shows the MEETING, not the file: a 13-minute part of
      // an hour-long recording must not read "1:00:00" on a phone either.
      const fileDuration = Number.isFinite(m.duration) ? m.duration * 1000 : null;
      const span = windowDurationMs(windowRef.current, fileDuration);
      const duration = span === null ? NaN : span / 1000;
      if (!Number.isFinite(duration) || duration <= 0) return;
      try {
        ms.setPositionState({
          duration,
          playbackRate: m.playbackRate || 1,
          position: Math.min(Math.max(0, toMeetingSec(m.currentTime)), duration),
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
        const at = clampPlayhead(m);
        setPosition(at);
        onTimeUpdate?.(at);
        syncPositionState(m);
      },
      onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        const m = e.target as HTMLMediaElement;
        const fileDuration = Number.isFinite(m.duration) ? m.duration * 1000 : null;
        const span = windowDurationMs(windowRef.current, fileDuration);
        setSpanSec(span === null ? null : span / 1000);
        // A split-off meeting opens at its own 0, not at the top of the hour.
        // A pending seek from the parent (a part switch, a `t:` chip clicked
        // before the media was ready) overrides this a tick later.
        const w = windowRef.current;
        if (w && m.currentTime * 1000 < w.fromMs) {
          try {
            m.currentTime = w.fromMs / 1000;
          } catch {
            /* ignore */
          }
        }
        syncPositionState(m);
        onLoadedMetadata?.();
      },
      onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => {
        // The page sets document.title after its own fetch — re-read it now.
        applyMetadata();
        setPlaying(true);
        setPlaybackState('playing');
        syncPositionState(e.target as HTMLMediaElement);
      },
      onPause: () => {
        setPlaying(false);
        setPlaybackState('paused');
      },
      onRateChange: (e: React.SyntheticEvent<HTMLMediaElement>) =>
        syncPositionState(e.target as HTMLMediaElement),
      onError: handleMediaError,
    };

    // What the elements actually load. `forceViaApp` is only ever set by the
    // recovery path above; until then these are the URLs the page passed.
    const videoElementSrc = forceViaApp ? viaAppUrl(src) : src;
    const audioElementSrc = audioSrc && forceViaApp ? viaAppUrl(audioSrc) : audioSrc;

    const togglePlay = () => {
      const m = mediaRef.current;
      if (!m) return;
      if (m.paused || m.ended) void m.play().catch(() => {});
      else m.pause();
    };

    const scrubTo = (meetingSec: number) => {
      const m = mediaRef.current;
      if (!m) return;
      try {
        m.currentTime = toFileSec(meetingSec);
      } catch {
        /* metadata not ready */
      }
      setPosition(meetingSec);
    };

    /**
     * The transport a WINDOWED player draws for itself.
     *
     * `<audio controls>` reads its duration off the file and there is no way
     * to tell it otherwise — on a meeting that is 20:00–33:20 of an hour it
     * would show an hour-long scrubber, start at 0:00 and happily play into
     * the next meeting. So the element goes silent (no `controls`) and this
     * row says the truth: a clock that starts at 0, a scrubber that spans the
     * window, and ±10 s that stop at its edges. Both controls are ordinary
     * focusable elements, so Tab/Space/arrow keys work as they always did.
     */
    const transport = windowed ? (
      <div className="flex items-center gap-2 py-0.5" data-clip-transport>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause' : 'Play'}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-card text-foreground hover:bg-muted"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="ml-0.5 h-3.5 w-3.5" />}
        </button>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" data-clip-position>
          {formatTimestamp((scrubbing ?? position) * 1000)}
        </span>
        {/* `step` is one second: an arrow key has to move a noticeable amount
            — at 0.1 it would take four thousand presses to cross a
            13-minute part. */}
        <input
          type="range"
          min={0}
          max={spanSec ?? 0}
          step={1}
          value={scrubbing ?? Math.min(position, spanSec ?? position)}
          disabled={spanSec === null}
          aria-label="Seek within this meeting"
          onChange={(e) => setScrubbing(Number(e.target.value))}
          onMouseUp={() => {
            if (scrubbing !== null) scrubTo(scrubbing);
            setScrubbing(null);
          }}
          onTouchEnd={() => {
            if (scrubbing !== null) scrubTo(scrubbing);
            setScrubbing(null);
          }}
          onKeyUp={() => {
            if (scrubbing !== null) scrubTo(scrubbing);
            setScrubbing(null);
          }}
          onBlur={() => {
            if (scrubbing !== null) scrubTo(scrubbing);
            setScrubbing(null);
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-primary"
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground" data-clip-span>
          {spanSec === null ? '—' : formatTimestamp(spanSec * 1000)}
        </span>
      </div>
    ) : null;

    return (
      <div className="relative">
        {videoOn ? (
          <video
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={videoElementSrc}
            controls={!windowed}
            preload="metadata"
            playsInline
            className="max-h-[50vh] w-full rounded-md bg-black"
            {...mediaEvents}
          />
        ) : audioElementSrc ? (
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={audioElementSrc}
            controls={!windowed}
            preload="metadata"
            className={windowed ? 'hidden' : (className ?? 'w-full')}
            {...mediaEvents}
          />
        ) : (
          // Probe in flight — keep the row's height so nothing jumps.
          <div className={className ?? 'h-10 w-full'} aria-hidden />
        )}
        {transport}
        {!hasVideo && noVideoNote && (
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground" data-no-video-note>
            {noVideoNote}
          </p>
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

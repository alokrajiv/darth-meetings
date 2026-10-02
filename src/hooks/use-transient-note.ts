'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A short sentence that says what just happened and then gets out of the way.
 *
 * There is no toast library here on purpose — the app's transient notes are
 * plain text that appears where the action was. This is the same idea with a hold time and a
 * fade, for notes that used to stay on screen forever.
 *
 * Contract for the caller: render ONE wrapper that is always in the DOM and
 * carries `role="status" aria-live="polite"`, and put `note` inside it keyed on
 * `id`. An always-present region is what makes the announcement reliable, and
 * the key makes the SAME sentence twice in a row announce twice (switching
 * back and forth between two versions says the same thing both ways).
 */

/** How long the sentence stays fully visible. */
export const TRANSIENT_NOTE_MS = 12_000;
/** The fade itself. Skipped entirely under `prefers-reduced-motion`. */
export const TRANSIENT_NOTE_FADE_MS = 600;

/** `true` when the reader has asked the OS for less animation. */
export function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    );
  } catch {
    return false;
  }
}

export interface TransientNote {
  /** The sentence to show, or null. */
  note: string | null;
  /** Bumped on every `show` — use it as the React key of the text node. */
  id: number;
  /** The hold is over and the note is fading out. Never true when the reader
   * asked for reduced motion: it is removed outright instead. */
  fading: boolean;
  show: (text: string) => void;
  dismiss: () => void;
}

export function useTransientNote(holdMs: number = TRANSIENT_NOTE_MS): TransientNote {
  const [state, setState] = useState<{ note: string | null; id: number }>({
    note: null,
    id: 0,
  });
  const [fading, setFading] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  }, []);

  // Unmounting mid-hold must not leave a timer poking at dead state.
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    },
    []
  );

  const dismiss = useCallback(() => {
    clearTimers();
    setFading(false);
    setState((prev) => ({ note: null, id: prev.id }));
  }, [clearTimers]);

  const show = useCallback(
    (text: string) => {
      clearTimers();
      setFading(false);
      setState((prev) => ({ note: text, id: prev.id + 1 }));
      timers.current.push(
        window.setTimeout(() => {
          if (prefersReducedMotion()) {
            setState((prev) => ({ note: null, id: prev.id }));
            return;
          }
          setFading(true);
          timers.current.push(
            window.setTimeout(() => {
              setState((prev) => ({ note: null, id: prev.id }));
              setFading(false);
            }, TRANSIENT_NOTE_FADE_MS)
          );
        }, holdMs)
      );
    },
    [clearTimers, holdMs]
  );

  return { note: state.note, id: state.id, fading, show, dismiss };
}

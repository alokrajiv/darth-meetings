'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * One small confirmation pill ("Link copied") at the bottom centre of the
 * window. No toast library on purpose (hooks/use-transient-note.ts explains
 * the house style for longer notes); this is for one-word confirmations of an
 * action whose result is invisible — a clipboard write.
 *
 * `showToast(text)` from anywhere (a window CustomEvent, so menus and pages
 * need no context); `<Toaster />` is mounted once in the root layout and owns
 * an always-present `role="status"` region so screen readers announce it.
 */

const TOAST_EVENT = 'darth-meetings:toast';
export const TOAST_MS = 1800;

export function showToast(text: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { text } }));
}

export function Toaster() {
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const text = (e as CustomEvent<{ text?: unknown }>).detail?.text;
      if (typeof text !== 'string' || !text) return;
      seq += 1;
      setToast({ text, id: seq });
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
      data-testid="toast-region"
    >
      {toast && (
        <span
          key={toast.id}
          className="rounded-full bg-foreground px-3.5 py-1.5 text-xs font-medium text-background shadow-lg"
          data-testid="toast"
        >
          {toast.text}
        </span>
      )}
    </div>
  );
}

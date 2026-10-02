'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The header / toolbar popover idiom: one wrapper ref (trigger + panel), open
 * state, closes on a mousedown outside the wrapper and on Escape. Escape is
 * consumed (stopPropagation at the document) so the listing's window-level
 * Escape — which clears the bulk row selection — does not fire too.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(defaultOpen = false) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<T | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, close, toggle, ref };
}

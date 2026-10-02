import { useEffect, useRef } from 'react';

/**
 * The Darth desktop shell's signals into the page — window CustomEvents the
 * shell dispatches through `webContents.executeJavaScript` (no preload), only
 * ever inside the shell. Nothing flows page → shell. Same contract as Darth
 * Chat (`src/lib/client/shell-signals.ts` there, SPEC §20.76-8/9):
 *
 *   darth-shell:search          detail { query: string, submit: boolean } —
 *                               submit:false while typing (debounced by the
 *                               shell; query '' = cleared), submit:true on Enter
 *   darth-shell:toggle-sidebar  the band's sidebar button (here: the labels rail)
 *   darth-shell:new-chat        not applicable to Meetings — never listened for
 */
export const SHELL_SIGNALS = {
  toggleSidebar: 'darth-shell:toggle-sidebar',
  newChat: 'darth-shell:new-chat',
  search: 'darth-shell:search',
} as const;

export interface ShellSearchDetail {
  query: string;
  submit: boolean;
}

export interface ShellSignalHandlers {
  toggleSidebar: () => void;
  search: (detail: ShellSearchDetail) => void;
}

type SignalTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** The detail of a `darth-shell:search` event, or null when it is not the
 * contract's shape (no string query). Pure. */
export function shellSearchDetail(e: Event): ShellSearchDetail | null {
  const d = (e as CustomEvent<unknown>).detail as { query?: unknown; submit?: unknown } | null | undefined;
  if (!d || typeof d !== 'object' || typeof d.query !== 'string') return null;
  return { query: d.query, submit: d.submit === true };
}

/**
 * What one search event does to the results panel. Closed: a non-empty query
 * opens it (`open`), and so does an EMPTY Enter (the panel opens on its
 * suggestions — "Search in <this meeting>" and Recent searches); a clear
 * while typing is ignored. Open: every event updates it in place (`update`)
 * — never a second panel. Pure.
 */
export function shellSearchAction(
  panelOpen: boolean,
  detail: ShellSearchDetail
): 'open' | 'update' | 'ignore' {
  if (panelOpen) return 'update';
  return detail.query.trim() || detail.submit ? 'open' : 'ignore';
}

/** Listens for the shell signals on `target`; returns the unsubscribe. The
 * DOM-free test target is a plain EventTarget. */
export function subscribeShellSignals(target: SignalTarget, handlers: ShellSignalHandlers): () => void {
  const entries: (readonly [string, (e: Event) => void])[] = [
    [SHELL_SIGNALS.toggleSidebar, () => handlers.toggleSidebar()],
    [
      SHELL_SIGNALS.search,
      (e: Event) => {
        const detail = shellSearchDetail(e);
        if (detail) handlers.search(detail);
      },
    ],
  ];
  for (const [type, fn] of entries) target.addEventListener(type, fn);
  return () => {
    for (const [type, fn] of entries) target.removeEventListener(type, fn);
  };
}

/** The shell signals on `window`, only while `enabled` (inside the shell —
 * outside it no listener is registered at all). Handlers are read at event
 * time, so fresh closures every render are fine. */
export function useShellSignals(enabled: boolean, handlers: ShellSignalHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return;
    return subscribeShellSignals(window, {
      toggleSidebar: () => latest.current.toggleSidebar(),
      search: (detail) => latest.current.search(detail),
    });
  }, [enabled]);
}

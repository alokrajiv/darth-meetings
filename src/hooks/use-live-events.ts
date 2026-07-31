'use client';

import { useEffect, useRef } from 'react';

export interface LiveEvent {
  kind: string;
  assemblyaiId?: string;
  at?: number;
}

/**
 * Subscribe to the server's /api/events SSE stream. Reconnects with backoff
 * on drops; the callback ref pattern means consumers can pass inline
 * closures without re-opening the connection every render.
 */
export function useLiveEvents(onEvent: (e: LiveEvent) => void): void {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource('/api/events');
      es.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as LiveEvent;
          if (e.kind && e.kind !== 'hello') cb.current(e);
        } catch {
          // malformed frame — skip
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
}

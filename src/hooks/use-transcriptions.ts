'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivateTranscriptionResponse,
  RetranscribeRequest,
  RunningTranscription,
  TranscriptionsResponse,
} from '@/lib/transcriptions';

/**
 * The transcription VERSIONS of one meeting, for the transcript page
 * (docs/recordings-phase2-spec.md §UI). Wire contract: `lib/transcriptions.ts`.
 *
 * Revalidation is event-driven: the page already holds an SSE subscription
 * for this meeting, so it hands 'status' / 'meta' events to `refresh()`
 * instead of this hook opening a second EventSource. The only timer is a
 * gentle 15 s fallback WHILE a run is in flight — the job completes on the
 * server whether or not anyone has the page open, and the poller that
 * observes it may publish nothing this tab hears.
 *
 * A server that does not answer this route yet (or a meeting on the
 * pre-Phase-2 fallback path) simply leaves `data` null / `versioned` false:
 * the Sources card then keeps today's behaviour, unchanged.
 */

/** What POST /retranscribe meant, in terms the dialog can act on. */
export type RetranscribeOutcome =
  /** A version is now being transcribed on this meeting. */
  | { kind: 'started'; running: RunningTranscription | null }
  /** The pre-Phase-2 path ran (or had already run): a separate meeting row. */
  | { kind: 'new-row'; newId: string }
  /** Same model AND language as the current version — resend with `force`. */
  | { kind: 'same-settings' }
  /** A run is already going. */
  | { kind: 'busy'; running: RunningTranscription | null };

export interface UseTranscriptions {
  data: TranscriptionsResponse | null;
  /** Only the first load — refreshes are silent. */
  loading: boolean;
  /** The last load failure, plain; actions report their own errors. */
  error: string | null;
  refresh: () => void;
  retranscribe: (req: RetranscribeRequest) => Promise<RetranscribeOutcome>;
  activate: (
    transcriptionId: string
  ) => Promise<Extract<ActivateTranscriptionResponse, { ok: true }>>;
  submitting: boolean;
  activatingId: string | null;
}

export function useTranscriptions(
  transcriptId: string,
  {
    enabled = true,
    onActiveChanged,
  }: {
    enabled?: boolean;
    /** The active version changed under us (a run finished, or someone
     * switched): the page reloads the transcript body, edits and speakers. */
    onActiveChanged?: () => void;
  } = {}
): UseTranscriptions {
  const [data, setData] = useState<TranscriptionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  // Stale-response guard: the page keys a remount per meeting, but a load
  // started for the previous id must never land on this one anyway.
  const liveIdRef = useRef(transcriptId);
  liveIdRef.current = transcriptId;
  const activeIdRef = useRef<string | null>(null);
  const changedRef = useRef(onActiveChanged);
  changedRef.current = onActiveChanged;

  const refresh = useCallback(() => {
    if (!enabled) return;
    const forId = transcriptId;
    void (async () => {
      try {
        const res = await fetch(`/api/transcripts/${forId}/transcriptions`);
        if (liveIdRef.current !== forId) return;
        if (!res.ok) {
          // 404 = this build has no versions route; anything else is
          // transient. Either way: no versions UI, no noise on the page.
          setError(res.status === 404 ? null : `Could not read the versions (${res.status})`);
          return;
        }
        const payload = (await res.json()) as TranscriptionsResponse;
        if (liveIdRef.current !== forId) return;
        setError(null);
        setData(payload);
        const active = payload.versions.find((v) => v.active)?.id ?? null;
        const previous = activeIdRef.current;
        activeIdRef.current = active;
        // Never on the first read — that IS what the page is showing.
        if (previous !== null && active !== null && previous !== active) {
          changedRef.current?.();
        }
      } catch {
        // offline / network blip — keep whatever we last knew
      } finally {
        if (liveIdRef.current === forId) setLoading(false);
      }
    })();
  }, [transcriptId, enabled]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    refresh();
  }, [refresh, enabled]);

  // Fallback while a run is in flight (see the note above).
  const running = data?.running ?? null;
  useEffect(() => {
    if (!enabled || !running) return;
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [enabled, running, refresh]);

  const retranscribe = useCallback(
    async (req: RetranscribeRequest): Promise<RetranscribeOutcome> => {
      setSubmitting(true);
      try {
        const res = await fetch(`/api/transcripts/${transcriptId}/retranscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          ok?: true;
          mode?: 'version' | 'new-row';
          already?: true;
          newId?: string;
          running?: RunningTranscription;
          sameSettings?: true;
          error?: string;
        };
        if (res.status === 409 && payload.sameSettings) return { kind: 'same-settings' };
        if (res.status === 409 && payload.running) {
          setData((prev) => (prev ? { ...prev, running: payload.running! } : prev));
          return { kind: 'busy', running: payload.running };
        }
        if (!res.ok) throw new Error(payload.error || `Could not start it (${res.status})`);
        if (payload.newId) return { kind: 'new-row', newId: payload.newId };
        // Paint the running line from the response, then confirm from the
        // list — the card must not wait a round-trip to say something.
        if (payload.running) {
          setData((prev) => (prev ? { ...prev, running: payload.running! } : prev));
        }
        refresh();
        return { kind: 'started', running: payload.running ?? null };
      } finally {
        setSubmitting(false);
      }
    },
    [transcriptId, refresh]
  );

  const activate = useCallback(
    async (transcriptionId: string) => {
      setActivatingId(transcriptionId);
      try {
        const res = await fetch(
          `/api/transcripts/${transcriptId}/transcriptions/${transcriptionId}/activate`,
          { method: 'POST' }
        );
        const payload = (await res.json().catch(() => ({}))) as ActivateTranscriptionResponse;
        if (!res.ok || !('ok' in payload)) {
          throw new Error(
            ('error' in payload && payload.error) || `Could not switch version (${res.status})`
          );
        }
        // The row, its edits and its speaker names all just changed: the
        // page reloads them (the list too, for the new set-aside counts).
        activeIdRef.current = payload.activeId;
        refresh();
        changedRef.current?.();
        return payload;
      } finally {
        setActivatingId(null);
      }
    },
    [transcriptId, refresh]
  );

  return { data, loading, error, refresh, retranscribe, activate, submitting, activatingId };
}

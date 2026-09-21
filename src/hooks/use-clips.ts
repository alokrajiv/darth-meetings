'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipsResponse, UnsplitResponse } from '@/lib/clips';

/**
 * The clips of one meeting, for the transcript page (Phase 3a,
 * docs/recordings-phase3-clips-spec.md §UI). Wire contract: `lib/clips.ts`.
 *
 * What this answer is FOR: whether "Split off a part…" may be offered at all,
 * where the holes are, and which other meetings sit on the same recording.
 * It is already caller-scoped — a sibling the reader cannot open never
 * appears — so everything here may be rendered verbatim.
 *
 * The PLAYER's window deliberately does NOT come from here: the page reads it
 * off the row it already has (`windowFromContext`), so a split-off meeting is
 * clamped on its first frame instead of one round-trip later, and stays
 * clamped on a server where `MW_CLIPS` has since been switched off. This hook
 * is for what only the server can know.
 *
 * A build without the route (404) or with the flag off leaves `data.enabled`
 * false and the page shows nothing about clips — today's behaviour, exactly.
 */
export interface UseClips {
  data: ClipsResponse | null;
  loading: boolean;
  refresh: () => void;
  /** Put this meeting back into the one it was split off. */
  unsplit: () => Promise<Extract<UnsplitResponse, { ok: true }>>;
  unsplitting: boolean;
}

export function useClips(transcriptId: string, { enabled = true }: { enabled?: boolean } = {}): UseClips {
  const [data, setData] = useState<ClipsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsplitting, setUnsplitting] = useState(false);

  // Same stale-response guard as useTranscriptions: a load started for the
  // previous meeting must never land on this one.
  const liveIdRef = useRef(transcriptId);
  liveIdRef.current = transcriptId;

  const refresh = useCallback(() => {
    if (!enabled) return;
    const forId = transcriptId;
    void (async () => {
      try {
        const res = await fetch(`/api/transcripts/${forId}/clips`);
        if (liveIdRef.current !== forId || !res.ok) return;
        const payload = (await res.json()) as ClipsResponse;
        if (liveIdRef.current !== forId) return;
        setData(payload);
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

  const unsplit = useCallback(async () => {
    setUnsplitting(true);
    try {
      const res = await fetch(`/api/transcripts/${transcriptId}/unsplit`, { method: 'POST' });
      const payload = (await res.json().catch(() => ({}))) as UnsplitResponse;
      if (!res.ok || !('ok' in payload)) {
        // The server's words — they are written to name no meeting the
        // caller cannot open.
        throw new Error(('error' in payload && payload.error) || `Could not put it back (${res.status})`);
      }
      return payload;
    } finally {
      setUnsplitting(false);
    }
  }, [transcriptId]);

  return { data, loading, refresh, unsplit, unsplitting };
}

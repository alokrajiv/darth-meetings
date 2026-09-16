'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { GmeetContext } from '@/lib/format';

type Failure = NonNullable<GmeetContext['ingestFailure']>;

/**
 * Next to the "Failed" badge of a kept-failure row: WHY the hand-off to
 * AssemblyAI failed, whether the sweeper is still retrying, and a "Retry now"
 * for editors. The recording itself is safe on the server (that is what
 * "kept" means) — the copy says so, because the 2026-09-16 outage taught us
 * a vanished row reads as "my recording is gone".
 */
export function IngestFailureNote({
  id,
  failure,
  canRetry,
}: {
  id: string;
  failure: Failure;
  canRetry: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const retry = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/transcripts/${id}/retry-ingest`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || `Retry failed (${res.status})`);
      setMsg('Retrying — this page updates when it lands.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };
  const when = failure.nextAt ? new Date(failure.nextAt) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-ingest-failure>
      <span title={failure.message}>
        Transcription hand-off failed ({failure.message}). The recording is saved on the server
        {failure.retryable
          ? when && when.getTime() > Date.now()
            ? ` — next automatic retry ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
            : ' — retrying automatically.'
          : ' — automatic retries gave up after 3 days.'}
      </span>
      {canRetry && (
        <button
          type="button"
          onClick={retry}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} /> Retry now
        </button>
      )}
      {msg && <span className="text-[11px]">{msg}</span>}
    </span>
  );
}

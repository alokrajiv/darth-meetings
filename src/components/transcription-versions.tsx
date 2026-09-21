'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { setAsideSentence, versionCopy } from '@/lib/transcription-copy';
import type { ActivateTranscriptionResponse, TranscriptionVersion } from '@/lib/transcriptions';

interface TranscriptionVersionsProps {
  versions: TranscriptionVersion[];
  canEdit: boolean;
  /** Offline: switching needs the server — shown, but inert. */
  disabled?: boolean;
  /** The reader, so their own runs read as "You". */
  selfEmail?: string | null;
  activatingId: string | null;
  onActivate: (
    transcriptionId: string
  ) => Promise<Extract<ActivateTranscriptionResponse, { ok: true }>>;
}

/**
 * "Versions" — every transcription this meeting has had, newest first
 * (docs/recordings-phase2-spec.md §UI). One line each: what ran, in what
 * language, when, who asked and why, and what of yours is parked with it.
 * Switching is instant and says in one sentence what happened to your edits
 * and names; nothing is ever thrown away.
 */
export function TranscriptionVersions({
  versions,
  canEdit,
  disabled = false,
  selfEmail,
  activatingId,
  onActivate,
}: TranscriptionVersionsProps) {
  const [open, setOpen] = useState(false);
  const [switched, setSwitched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const switchTo = async (id: string) => {
    setError(null);
    setSwitched(null);
    try {
      setSwitched(setAsideSentence(await onActivate(id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch version');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        Versions ({versions.length})
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <ul className="mt-1 space-y-1.5 rounded-md border bg-muted/30 px-2 py-1.5 text-[11px] leading-snug">
          {versions.map((v) => {
            const c = versionCopy(v, selfEmail);
            const busy = activatingId === v.id;
            return (
              <li key={v.id} className="border-b border-dashed pb-1.5 last:border-0 last:pb-0">
                {/* Inline, not flex: a model name that wraps (narrow rail, or
                    390 px) must carry its status with it — as flex siblings
                    the status aligns to the model's FIRST baseline and reads
                    as "Universal-2 — asked for Universal-3.5 · reading now"
                    above a stranded "Pro". */}
                <div>
                  <span className={v.active ? 'font-medium' : ''}>{c.model}</span>
                  {v.active && (
                    <span className="whitespace-nowrap text-muted-foreground"> · reading now</span>
                  )}
                  {v.status === 'processing' && (
                    <span className="whitespace-nowrap text-muted-foreground"> · running</span>
                  )}
                  {v.status === 'error' && (
                    <span className="whitespace-nowrap text-destructive"> · failed</span>
                  )}
                </div>
                <div className="text-muted-foreground">
                  {[c.language, c.when, c.who].filter(Boolean).join(' · ')}
                </div>
                {c.reason && <div className="text-muted-foreground">{c.reason}</div>}
                {c.error && <div className="text-destructive">{c.error}</div>}
                {(c.setAside || (canEdit && !v.active && v.status === 'completed')) && (
                  <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-muted-foreground">{c.setAside}</span>
                    {canEdit && !v.active && v.status === 'completed' && (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
                        disabled={disabled || busy || activatingId !== null}
                        title={
                          disabled
                            ? 'Not available offline'
                            : 'Read the meeting from this version — your edits and names on the current one are kept with it'
                        }
                        onClick={() => void switchTo(v.id)}
                      >
                        {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                        {busy ? 'Switching…' : 'Use this version'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {switched && <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{switched}</p>}
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </>
  );
}

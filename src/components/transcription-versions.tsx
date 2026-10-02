'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { setAsideSentence, versionCopy } from '@/lib/transcription-copy';
import { TRANSIENT_NOTE_FADE_MS, useTransientNote } from '@/hooks/use-transient-note';
import type { ActivateTranscriptionResponse, TranscriptionVersion } from '@/lib/transcriptions';

interface TranscriptionVersionsProps {
  versions: TranscriptionVersion[];
  canEdit: boolean;
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
  selfEmail,
  activatingId,
  onActivate,
}: TranscriptionVersionsProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the switch did to your edits and names. It used to sit there for the
  // rest of the session; it is news, not state, so it goes away by itself and
  // can be dismissed at once.
  const switched = useTransientNote();

  const switchTo = async (id: string) => {
    setError(null);
    switched.dismiss();
    try {
      switched.show(setAsideSentence(await onActivate(id)));
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
                        disabled={busy || activatingId !== null}
                        title="Read the meeting from this version — your edits and names on the current one are kept with it"
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
      {/* Always in the DOM so the live region exists before the sentence lands
          — a region created and filled in the same tick often goes
          unannounced. Empty it takes no space, so nothing below it moves. */}
      <div
        style={switched.fading ? { transitionDuration: `${TRANSIENT_NOTE_FADE_MS}ms` } : undefined}
        className={`flex items-start gap-1.5 transition-opacity motion-reduce:transition-none ${
          switched.note ? 'mt-1.5' : ''
        } ${switched.fading ? 'opacity-0' : 'opacity-100'}`}
      >
        <p
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground"
        >
          {switched.note && <span key={switched.id}>{switched.note}</span>}
        </p>
        {switched.note && (
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={switched.dismiss}
            className="-mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

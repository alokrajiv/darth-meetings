'use client';

import { Loader2, Merge, SquarePlus } from 'lucide-react';
import {
  joinChoiceCopy,
  type LinkCandidatesResponse,
  type LinkMode,
  type OccurrenceMeetingCandidate,
} from '@/lib/occurrence-join';

/**
 * "This occurrence already has a meeting by Ka Wen Koh — Add my recording to
 * it (default) / Keep mine separate" (owner, 2026-10-02).
 *
 * Shown by the link dialog and the suggestion strip when the server reports a
 * meeting of the picked occurrence that this recording can join
 * (`GET …/link-candidates`). Purely presentational: the parent makes the
 * link call with the `mode` the person picked. "Add" is first and is the
 * default — it is what the tray and darth-cli get without asking.
 */
export function JoinChoice({
  candidate,
  busy,
  onPick,
  compact,
}: {
  candidate: OccurrenceMeetingCandidate;
  /** Which button is working, if any. */
  busy?: LinkMode | null;
  onPick: (mode: LinkMode) => void;
  /** The suggestion strip's one-line form. */
  compact?: boolean;
}) {
  const copy = joinChoiceCopy(candidate);
  const disabled = !!busy;
  if (compact) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-join-choice={candidate.meetingId}>
        <span>
          {copy.headline}
          {copy.title ? <> — “{copy.title}”</> : null}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick('join')}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
          data-join-mode="join"
        >
          {busy === 'join' && <Loader2 className="h-3 w-3 animate-spin" />}
          {copy.join}
        </button>
        <span aria-hidden>·</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick('separate')}
          className="inline-flex items-center gap-1 font-medium hover:underline disabled:opacity-50"
          data-join-mode="separate"
        >
          {busy === 'separate' && <Loader2 className="h-3 w-3 animate-spin" />}
          {copy.separate}
        </button>
      </span>
    );
  }
  return (
    <div className="space-y-3 min-w-0" data-join-choice={candidate.meetingId}>
      <div className="min-w-0">
        <p className="text-sm font-medium">{copy.headline}</p>
        {copy.title && <p className="truncate text-sm text-muted-foreground">“{copy.title}”</p>}
      </div>
      <div className="grid gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick('join')}
          className="flex w-full items-start gap-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-left transition-colors hover:bg-primary/10 disabled:opacity-60"
          data-join-mode="join"
        >
          {busy === 'join' ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <Merge className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          )}
          <span className="min-w-0">
            <span className="block text-sm font-medium">
              {copy.join} <span className="font-normal text-muted-foreground">(default)</span>
            </span>
            <span className="block text-xs text-muted-foreground">{copy.joinHint}</span>
          </span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick('separate')}
          className="flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors hover:bg-accent/40 disabled:opacity-60"
          data-join-mode="separate"
        >
          {busy === 'separate' ? (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <SquarePlus className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0">
            <span className="block text-sm font-medium">{copy.separate}</span>
            <span className="block text-xs text-muted-foreground">{copy.separateHint}</span>
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Ask the server whether the picked occurrence already has a meeting this
 * recording / meeting could join. `null` on any failure: the link then goes
 * ahead with the server's default, which is the same question asked again.
 */
export async function fetchLinkCandidates(
  base: { recordingId: string } | { transcriptId: string },
  query: Record<string, string | null | undefined>
): Promise<LinkCandidatesResponse | null> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  const path =
    'recordingId' in base
      ? `/api/recordings/${encodeURIComponent(base.recordingId)}/link-candidates`
      : `/api/transcripts/${encodeURIComponent(base.transcriptId)}/link-candidates`;
  try {
    const res = await fetch(`${path}?${params}`);
    if (!res.ok) return null;
    return (await res.json()) as LinkCandidatesResponse;
  } catch {
    return null;
  }
}

/** Where a link answer says to go: the joined meeting, when there was a join. */
export function joinedMeetingHref(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { joined?: unknown; meetingId?: unknown };
  if (b.joined !== true || typeof b.meetingId !== 'string' || !b.meetingId) return null;
  return `/transcript/${encodeURIComponent(b.meetingId)}`;
}

'use client';

import { useState } from 'react';
import { CalendarSearch, Loader2 } from 'lucide-react';
import { suggestedEventLine, suggestedEventWhy } from '@/lib/suggested-event';
import type { SuggestedEvent } from '@/lib/format';
import type { LinkMode, OccurrenceMeetingCandidate } from '@/lib/occurrence-join';
import {
  JoinChoice,
  fetchLinkCandidates,
  joinedMeetingHref,
} from '@/components/occurrence-join-choice';

/**
 * "Looks like ‘Triton next steps!’ · 15:30–16:30 · Google Meet —
 * Link to it · Not this" (docs/recorder-link-confirm-spec.md D4-web).
 *
 * The server matched this recording to a calendar occurrence and did NOT act
 * on it (D1). This strip is the whole of what the guess does: two buttons,
 * both explicit.
 *
 *  - **Link to it** runs the SAME link flow darth-cli `meetings link` uses
 *    (`POST :id/link-event` with the event key resolved from the caller's own
 *    calendar cache): title, date, attendees, and share SUGGESTIONS —
 *    nothing is shared with anyone until a human accepts those separately.
 *    When that occurrence already has a meeting the caller can open and
 *    this one can be folded into (owner, 2026-10-02), the strip first asks:
 *    "This occurrence already has a meeting by … — Add my recording to it ·
 *    Keep mine separate", and a join lands on that meeting.
 *  - **Not this** stamps `suggestedEvent.dismissedAt` and the strip goes.
 *  - **Pick another…** opens the existing calendar picker.
 *
 * PRIVACY: the suggestion names an occurrence from the OWNER's calendar, so
 * the caller must already be able to act on the row — the page mounts this
 * for owners and editors only, never for a read-only share.
 */
export function SuggestedEventStrip({
  transcriptId,
  suggested,
  onChanged,
  onPickAnother,
  compact,
}: {
  transcriptId: string;
  suggested: SuggestedEvent;
  /** Called after a successful link or dismiss — reload the row. */
  onChanged: (what: 'linked' | 'dismissed') => void;
  /** Opens the "link the calendar event" picker (the ?link=1 dialog). */
  onPickAnother?: () => void;
  /** Listing rows render a single tighter line. */
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<null | 'link' | 'dismiss'>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<OccurrenceMeetingCandidate | null>(null);
  const [choosing, setChoosing] = useState<LinkMode | null>(null);

  const linkWith = async (mode: LinkMode | null) => {
    setBusy('link');
    setError(null);
    try {
      const r = await fetch(`/api/transcripts/${transcriptId}/link-event`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          eventKey: suggested.key,
          ...(mode ? { mode } : {}),
        }),
      });
      const d = (await r.json().catch(() => null)) as { error?: string } | null;
      if (!r.ok) throw new Error(d?.error ?? `Link failed (${r.status})`);
      const joinedHref = joinedMeetingHref(d);
      if (joinedHref) {
        window.location.assign(joinedHref);
        return;
      }
      onChanged('linked');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setChoosing(null);
    }
  };

  const link = async () => {
    setBusy('link');
    setError(null);
    const answer = await fetchLinkCandidates({ transcriptId }, { event: suggested.key });
    if (answer?.candidate) {
      setBusy(null);
      setChoice(answer.candidate);
      return;
    }
    await linkWith(null);
  };

  const choose = (mode: LinkMode) => {
    setChoosing(mode);
    void linkWith(mode);
  };

  const dismiss = async () => {
    setBusy('dismiss');
    setError(null);
    try {
      const r = await fetch(`/api/transcripts/${transcriptId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dismissSuggestedEvent: true }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(d?.error ?? `Could not dismiss (${r.status})`);
      }
      onChanged('dismissed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'
          : 'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dashed bg-muted/30 px-2.5 py-1.5 text-[12px] text-muted-foreground'
      }
      title={suggestedEventWhy(suggested)}
      data-suggested-event={suggested.key}
    >
      <CalendarSearch className="h-3.5 w-3.5 shrink-0" />
      {choice ? (
        <>
          <JoinChoice candidate={choice} busy={choosing} onPick={choose} compact />
          <span aria-hidden>·</span>
          <button
            type="button"
            disabled={choosing !== null}
            onClick={() => setChoice(null)}
            className="font-medium hover:underline disabled:opacity-50"
          >
            Cancel
          </button>
          {error && <span className="text-destructive">{error}</span>}
        </>
      ) : (
        <>
          <span className="min-w-0">{suggestedEventLine(suggested)}</span>
          <span aria-hidden>—</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void link()}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
          >
            {busy === 'link' && <Loader2 className="h-3 w-3 animate-spin" />}
            Link to it
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void dismiss()}
            className="font-medium hover:underline disabled:opacity-50"
          >
            {busy === 'dismiss' ? 'Dismissing…' : 'Not this'}
          </button>
          {onPickAnother && (
            <>
              <span aria-hidden>·</span>
              <button
                type="button"
                disabled={busy !== null}
                onClick={onPickAnother}
                className="font-medium hover:underline disabled:opacity-50"
              >
                Pick another…
              </button>
            </>
          )}
          {error && <span className="text-destructive">{error}</span>}
        </>
      )}
    </div>
  );
}

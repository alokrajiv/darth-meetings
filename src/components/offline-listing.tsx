'use client';

/**
 * The listing from the desktop replica (README "Offline in the Darth desktop
 * shell"): the newest 100 meetings as they were saved, by day. A meeting
 * whose text is stored opens IN PLACE (`/#read=<id>`, no document load, so it
 * works whether or not the shell cached its page); one without it is dimmed
 * with "Not available offline". Search goes through the band's results panel,
 * which answers from the replica while offline (components/shell-search.tsx).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { LabelChip } from '@/components/label-chips';
import { formatDuration, type TranscriptListRow } from '@/lib/format';
import { meetingTitleOf } from '@/lib/meeting-title';
import { loadStoredListing } from '@/lib/offline/replica-client';
import { meetingAt, type StoredListing } from '@/lib/offline/replica';
import {
  NOT_AVAILABLE_OFFLINE,
  OFFLINE_READ_EVENT,
  dayHeading,
  groupByLocalDay,
  readHashOf,
  readIdFromHash,
  savedLine,
} from '@/lib/offline/offline-copy';
import { OfflineMeeting } from '@/components/offline-meeting';

export interface OfflineListingViewProps {
  listing: StoredListing;
  online: boolean;
  onOpen: (id: string) => void;
  onRetry?: () => void;
  now?: Date;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function OfflineRow({ row, saved, onOpen, now }: { row: TranscriptListRow; saved: boolean; onOpen: (id: string) => void; now?: Date }) {
  const title = meetingTitleOf(row, now);
  const owner = row.access !== 'owner' ? row.owner_name || row.owner_email || 'Shared with you' : null;
  const meta = [
    owner,
    row.duration ? formatDuration(row.duration) : null,
    row.speaker_count ? `${row.speaker_count} speaker${row.speaker_count === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const labels = row.labels ?? [];
  const inner = (
    <>
      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{timeOf(meetingAt(row))}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium" title={title.filename ?? undefined}>
            {title.primary}
          </span>
          {labels.slice(0, 2).map((l) => (
            <LabelChip key={l.id} label={l} color={l.color ?? null} />
          ))}
          {labels.length > 2 && <span className="shrink-0 text-[11px] text-muted-foreground">+{labels.length - 2}</span>}
        </span>
        {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
      {!saved && <span className="shrink-0 text-xs text-muted-foreground">{NOT_AVAILABLE_OFFLINE}</span>}
    </>
  );
  if (!saved) {
    return (
      <li
        className="flex items-center gap-3 rounded-md px-2 py-2 opacity-50"
        title={NOT_AVAILABLE_OFFLINE}
        data-offline-row={row.assemblyai_id}
        data-offline-saved="0"
      >
        {inner}
      </li>
    );
  }
  return (
    <li data-offline-row={row.assemblyai_id} data-offline-saved="1">
      <button
        type="button"
        onClick={() => onOpen(row.assemblyai_id)}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted"
      >
        {inner}
      </button>
    </li>
  );
}

export function OfflineListingView({ listing, online, onOpen, onRetry, now }: OfflineListingViewProps) {
  const groups = groupByLocalDay(listing.rows, meetingAt);
  return (
    <div data-testid="offline-listing">
      <p className="mb-3 text-xs text-muted-foreground" data-testid="offline-saved-line">
        {savedLine(listing.savedAt, now)}
        {online && onRetry && (
          <>
            {' · '}
            <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground">
              Try again
            </button>
          </>
        )}
      </p>
      {listing.rows.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No meetings were saved on this Mac yet. Open Meetings once while online and the newest 100 are kept for
          offline reading.
        </p>
      )}
      {groups.map((g) => (
        <section key={g.key} className="mb-4">
          <h2 className="mb-1 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{dayHeading(g.key, now)}</h2>
          <ul>
            {g.rows.map((r) => (
              <OfflineRow key={r.assemblyai_id} row={r} saved={listing.saved.has(r.assemblyai_id)} onOpen={onOpen} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The listing page's offline body: the stored listing, or one stored meeting
 * in place when the URL says `#read=<id>`. Back returns to the list.
 */
export function OfflineListing({ online, onRetry }: { online: boolean; onRetry?: () => void }) {
  const [listing, setListing] = useState<StoredListing | null | 'loading'>('loading');
  const [readId, setReadId] = useState<string | null>(null);
  const pushedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    loadStoredListing()
      .then((l) => {
        if (alive) setListing(l);
      })
      .catch(() => {
        if (alive) setListing(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const open = useCallback((id: string) => {
    // Keep the router's history state on the entry so its popstate handler
    // treats Back as its own (no reload).
    window.history.pushState(window.history.state, '', `${window.location.pathname}${window.location.search}${readHashOf(id)}`);
    pushedRef.current = true;
    setReadId(id);
    window.scrollTo(0, 0);
  }, []);
  const back = useCallback(() => {
    if (pushedRef.current) {
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    setReadId(null);
  }, []);

  useEffect(() => {
    setReadId(readIdFromHash(window.location.hash));
    const onPop = () => {
      pushedRef.current = false;
      setReadId(readIdFromHash(window.location.hash));
    };
    const onRead = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === 'string' && id) open(id);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    window.addEventListener(OFFLINE_READ_EVENT, onRead);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
      window.removeEventListener(OFFLINE_READ_EVENT, onRead);
    };
  }, [open]);

  if (readId) return <OfflineMeeting id={readId} online={online} onRetry={onRetry} onBack={back} bare />;
  if (listing === 'loading') return null;
  if (listing === null) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        Nothing was saved on this Mac for offline reading.
      </p>
    );
  }
  return <OfflineListingView listing={listing} online={online} onOpen={open} onRetry={onRetry} />;
}

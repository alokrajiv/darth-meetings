'use client';

/**
 * A meeting read from the desktop replica (README "Offline in the Darth
 * desktop shell"): what was saved on this Mac — title, when, people, labels,
 * the AI notes / report and the transcript as speaker-named turns. Shown on
 * /transcript/<id> while the shell says offline (or the page's own load
 * failed to reach the server), and in place on the listing (`/#read=<id>`).
 *
 * Read only: playback, sharing, AI and every edit are disabled with "Not
 * available offline". No spinner that can wait forever: the store answers
 * (or fails) in milliseconds, and a missing copy says so. No offline banner:
 * the shell's band pill says Offline.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Headphones, Share2, Sparkles } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { NotesMarkdown } from '@/components/notes-markdown';
import { LabelChip } from '@/components/label-chips';
import { useShellSearchScope } from '@/components/shell-search';
import { formatDuration, formatTime, type TranscriptListRow } from '@/lib/format';
import { meetingTitleOf } from '@/lib/meeting-title';
import { speakerColorVar } from '@/lib/speaker-display';
import { loadStoredMeeting } from '@/lib/offline/replica-client';
import type { StoredReplicaDoc } from '@/lib/offline/replica';
import { NOT_AVAILABLE_OFFLINE, savedLine } from '@/lib/offline/offline-copy';
import { LISTING_MAX_CONTENT_PX } from '@/lib/listing-layout';

export interface OfflineMeetingViewProps {
  id: string;
  doc: StoredReplicaDoc | null;
  /** The listing row, when only that is stored (title, date, people). */
  row: TranscriptListRow | null;
  /** The shell says online (the page fell back because a read failed). */
  online: boolean;
  /** "Try again" (online only): back to the live page. */
  onRetry?: () => void;
  /** In-place reader on the listing: "← Meetings". */
  onBack?: () => void;
  /** Render without the app header (the listing already has one). */
  bare?: boolean;
  now?: Date;
}

function whenOf(recordedAt: string | null | undefined, createdAt: string | undefined): string | null {
  const iso = recordedAt || createdAt;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A disabled control with the family's offline copy. */
function OfflineAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      disabled
      title={NOT_AVAILABLE_OFFLINE}
      aria-label={`${label} — ${NOT_AVAILABLE_OFFLINE}`}
      className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground opacity-60"
    >
      {icon}
      {label}
    </button>
  );
}

export function OfflineMeetingView({ id, doc, row, online, onRetry, onBack, bare = false, now }: OfflineMeetingViewProps) {
  const meta = doc?.meta ?? null;
  const titleFields = meta ?? row;
  const title = titleFields
    ? meetingTitleOf(
        {
          title: titleFields.title,
          original_filename: titleFields.original_filename,
          has_event: meta ? meta.has_event : row?.has_event,
          recorded_at: titleFields.recorded_at,
          created_at: titleFields.created_at,
          recorder_recording_id: meta ? meta.recorder_recording_id : row?.recorder_recording_id,
          source: titleFields.source,
          provider: meta ? meta.provider : row?.provider,
        },
        now
      ).primary
    : 'Meeting';
  const when = whenOf(titleFields?.recorded_at, titleFields?.created_at);
  const duration = titleFields?.duration ? formatDuration(titleFields.duration) : null;
  const owner =
    titleFields && titleFields.access !== 'owner'
      ? titleFields.owner_name || titleFields.owner_email || 'Shared with you'
      : null;
  const labels = (meta?.labels?.length ? meta.labels : row?.labels) ?? [];
  const [tab, setTab] = useState<'notes' | 'report'>(doc?.report && !doc?.notes ? 'report' : 'notes');
  const notesBody = tab === 'report' ? doc?.report : doc?.notes;
  const turns = useMemo(() => doc?.turns ?? [], [doc]);

  const jumpTo = useCallback((index: number) => {
    const el = document.querySelector<HTMLElement>(`[data-offline-turn="${index}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('search-jump-flash');
    window.setTimeout(() => el.classList.remove('search-jump-flash'), 1600);
  }, []);
  const seek = useCallback(
    (seconds: number) => {
      // No player offline: a timestamp chip in the notes scrolls to that moment.
      const ms = seconds * 1000;
      let idx = -1;
      for (let i = 0; i < turns.length; i++) {
        if (turns[i]![1] <= ms) idx = i;
        else break;
      }
      if (idx >= 0) jumpTo(idx);
    },
    [turns, jumpTo]
  );

  // The band's "Search in <title>" works offline too: over the stored turns.
  useShellSearchScope(
    doc && turns.length
      ? {
          id,
          title,
          utterances: () => turns.map(([speaker, startMs, text], index) => ({ index, startMs, speaker, text })),
          jump: jumpTo,
        }
      : null
  );

  const body = (
    <main className="mx-auto px-6 py-4" style={{ maxWidth: LISTING_MAX_CONTENT_PX }} data-testid="offline-meeting">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Meetings
        </button>
      )}
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        {when && <span>{when}</span>}
        {duration && <span>· {duration}</span>}
        {owner && <span>· {owner}</span>}
        {meta && meta.speakers.length > 0 && (
          <span>
            · {meta.speakers.length} speaker{meta.speakers.length === 1 ? '' : 's'}
          </span>
        )}
        {labels.slice(0, 4).map((l) => (
          <LabelChip key={l.id} label={l} color={l.color ?? null} />
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground" data-testid="offline-saved-line">
        {doc ? savedLine(doc.savedAt, now) : 'Only the listing row was saved on this Mac'}
        {online && onRetry && (
          <>
            {' · '}
            <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-foreground">
              Try again
            </button>
          </>
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <OfflineAction icon={<Headphones className="h-3.5 w-3.5" />} label="Play" />
        <OfflineAction icon={<Share2 className="h-3.5 w-3.5" />} label="Share" />
        <OfflineAction icon={<Sparkles className="h-3.5 w-3.5" />} label="Ask AI" />
        <span className="text-xs text-muted-foreground">Playback and changes: {NOT_AVAILABLE_OFFLINE.toLowerCase()}</span>
      </div>

      {!doc && (
        <div className="mt-6 rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-testid="offline-not-saved">
          The transcript and notes of this meeting were not saved on this Mac. Meetings you open while online, and the
          newest 100, are kept for offline reading.
        </div>
      )}

      {doc && (
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section aria-label="Notes" className="min-w-0">
            {meta && (meta.attendees.length > 0 || meta.organizer) && (
              <div className="mb-4 text-sm">
                <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">People</h2>
                <ul className="flex flex-wrap gap-1.5">
                  {meta.attendees.map((a) => (
                    <li key={a.email} className="rounded-full border px-2 py-0.5 text-xs" title={a.email}>
                      {a.name || a.email}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(doc.notes || doc.report) && (
              <div>
                <div className="mb-2 flex items-center gap-1 text-xs">
                  {doc.notes && (
                    <button
                      type="button"
                      onClick={() => setTab('notes')}
                      className={`rounded-md px-2 py-1 ${tab === 'notes' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                    >
                      Summary
                    </button>
                  )}
                  {doc.report && (
                    <button
                      type="button"
                      onClick={() => setTab('report')}
                      className={`rounded-md px-2 py-1 ${tab === 'report' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                    >
                      Detailed report
                    </button>
                  )}
                </div>
                {notesBody && (
                  <div className="markdown-body max-w-[75ch] text-sm">
                    <NotesMarkdown markdown={notesBody} transcriptId={id} onSeek={seek} />
                  </div>
                )}
              </div>
            )}
            {!doc.notes && !doc.report && <p className="text-sm text-muted-foreground">No AI notes were saved for this meeting.</p>}
          </section>
          <section aria-label="Transcript" className="min-w-0">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Transcript</h2>
            {turns.length === 0 && <p className="text-sm text-muted-foreground">No transcript text was saved for this meeting.</p>}
            <ol className="space-y-2">
              {turns.map(([speaker, startMs, text], i) => {
                const head = i === 0 || turns[i - 1]![0] !== speaker;
                return (
                  <li key={i} data-offline-turn={i} className="rounded-md px-1 text-sm leading-relaxed">
                    {head && (
                      <div className="mt-2 flex items-baseline gap-2">
                        {speaker && (
                          <span className="text-xs font-semibold" style={{ color: speakerColorVar(speaker) }}>
                            {speaker}
                          </span>
                        )}
                        <span className="text-[11px] tabular-nums text-muted-foreground">{formatTime(startMs)}</span>
                      </div>
                    )}
                    <p className="whitespace-pre-wrap">{text}</p>
                  </li>
                );
              })}
            </ol>
            {meta?.truncated && (
              <p className="mt-3 text-xs text-muted-foreground">
                The rest of this transcript was too long to keep on this Mac.
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );

  if (bare) return body;
  return (
    <div className="min-h-screen">
      <AppHeader breadcrumb={{ title }} />
      {body}
    </div>
  );
}

/** Loads the stored copy of one meeting and renders it. */
export function OfflineMeeting({
  id,
  online,
  onRetry,
  onBack,
  bare,
}: {
  id: string;
  online: boolean;
  onRetry?: () => void;
  onBack?: () => void;
  bare?: boolean;
}) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; doc: StoredReplicaDoc | null; row: TranscriptListRow | null }
  >({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    loadStoredMeeting(id)
      .then((r) => {
        if (alive) setState({ status: 'ready', doc: r?.doc ?? null, row: r?.row ?? null });
      })
      .catch(() => {
        if (alive) setState({ status: 'ready', doc: null, row: null });
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (state.status === 'loading') {
    // The store answers in milliseconds: no spinner, just the frame.
    return bare ? null : (
      <div className="min-h-screen">
        <AppHeader breadcrumb={{ title: 'Meeting' }} />
      </div>
    );
  }
  return (
    <OfflineMeetingView id={id} doc={state.doc} row={state.row} online={online} onRetry={onRetry} onBack={onBack} bare={bare} />
  );
}

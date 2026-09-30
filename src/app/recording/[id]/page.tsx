'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Archive,
  ArrowLeft,
  CalendarSearch,
  Check,
  ExternalLink,
  FilePlus2,
  Hourglass,
  Link2,
  Loader2,
  Lock,
  Trash2,
  X,
} from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { AudioPlayer, type AudioPlayerHandle } from '@/components/audio-player';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LinkEventDialog } from '@/components/link-event-dialog';
import { RecordingStrip } from '@/components/recording-strip';
import { formatBytes, formatDuration, formatTime, type TranscriptResponse } from '@/lib/format';
import { shortWhen } from '@/lib/meeting-title';
import {
  expiresCopy,
  recordingDisplayTitle,
  stripForRecordingView,
  type RecordingViewWire,
} from '@/lib/recording-view';

/**
 * `/recording/<id>` — one of the caller's OWN recordings, in recording mode
 * (design P7, §3.1 "Open"): the player, the text and its diarised speakers.
 * No share, notes, labels or series controls — a recording is never shared;
 * the only ways forward are Link to meeting… / Make a meeting (which create
 * the meeting you then share), Keep (a temporary one) and Delete.
 *
 * Everything it reads is owner-only (`/api/recordings/:id`, `/content`,
 * `/audio`); anyone else gets the same "not found" as for an id that does
 * not exist. `?link=1` opens the link picker (the tray's "Not this" lands
 * here through `/transcript/rec-<id>`).
 */
export default function RecordingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const playerRef = useRef<AudioPlayerHandle>(null);
  const [rec, setRec] = useState<RecordingViewWire | null>(null);
  const [missing, setMissing] = useState(false);
  const [content, setContent] = useState<TranscriptResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'keep' | 'delete' | 'link' | 'dismiss' | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const res = await fetch(`/api/recordings/${id}`, { credentials: 'include' });
    if (res.status === 404) {
      setMissing(true);
      return null;
    }
    if (!res.ok) {
      setErr(`Could not load the recording (${res.status})`);
      return null;
    }
    const { recording } = (await res.json()) as { recording: RecordingViewWire };
    setRec(recording);
    if (recording.status === 'ready') {
      const c = await fetch(`/api/recordings/${id}/content`, { credentials: 'include' });
      if (c.status === 200) setContent((await c.json()) as TranscriptResponse);
    }
    return recording;
  }, [id]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const r = await load().catch(() => null);
      if (stop) return;
      if (r && (r.status === 'uploading' || r.status === 'transcribing')) {
        timer = setTimeout(() => void tick(), 5_000);
      }
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('link') === '1') {
      setLinkOpen(true);
    }
  }, []);

  const title = rec ? recordingDisplayTitle(rec, (iso) => shortWhen(iso)) : 'Recording';
  useEffect(() => {
    document.title = `${title} · Darth Meetings`;
  }, [title]);

  const run = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };
  const call = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await res.json().catch(() => ({}))) as { error?: string; meeting?: { id: string } };
    if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
    return j;
  };
  const openMeeting = (j: { meeting?: { id: string } }) => {
    if (j.meeting?.id) router.push(`/transcript/${j.meeting.id}`);
    else void load();
  };

  const speakers = useMemo(() => {
    const seen = new Map<string, number>();
    for (const u of content?.utterances ?? []) seen.set(u.speaker, (seen.get(u.speaker) ?? 0) + (u.end - u.start));
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [content]);

  if (missing) {
    return (
      <div className="min-h-screen">
        <AppHeader />
        <main className="mx-auto max-w-3xl px-4 py-16 text-center text-sm text-muted-foreground">
          Recording not found.{' '}
          <Link href="/recordings" className="underline">
            Back to your recordings
          </Link>
        </main>
      </div>
    );
  }

  const ready = rec?.status === 'ready';
  // Link / Make a meeting are NOT gated on the upload or the transcription
  // (Alok, 2026-09-30): the meeting is born now and its text lands when the
  // recording's does. Only a failed transcription has nothing to hand over.
  const linkable = !!rec && rec.status !== 'failed';
  const model = rec ? stripForRecordingView(rec, { fmtBytes: formatBytes, fmtDuration: formatDuration }) : null;
  const iconBtn = 'h-8 gap-1 px-2.5 text-xs';

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-3xl space-y-4 px-4 py-4 sm:px-6" data-recording-page>
        <Link href="/recordings" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Recordings
        </Link>

        <div className="space-y-1">
          {naming ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run('name', async () => {
                  const t = name.trim();
                  if (!t) return;
                  openMeeting(await call(`/api/recordings/${id}/make-meeting`, 'POST', { title: t }));
                });
              }}
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting title" className="h-8" />
              <Button type="submit" size="sm" className="h-8" disabled={busy === 'name' || !name.trim()}>
                {busy === 'name' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setNaming(false)}>
                <X className="h-4 w-4" />
              </Button>
            </form>
          ) : (
            <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
              {rec?.temporary && <Hourglass className="h-4 w-4 shrink-0 text-amber-600" aria-label="Temporary" />}
              <span className="truncate" title={rec?.original_filename ?? undefined}>
                {title}
              </span>
            </h1>
          )}
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Lock className="h-3 w-3" /> Only you can see this recording
            </span>
            {rec && <span>· {shortWhen(rec.started_at ?? rec.created_at)}</span>}
            {rec?.bytes ? <span>· {formatBytes(rec.bytes)}</span> : null}
            {rec?.temporary && <span>· {expiresCopy(rec.expires_at, now || undefined)}</span>}
          </p>
        </div>

        {rec?.meetings && rec.meetings.length > 0 && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            Part of{' '}
            {rec.meetings.map((m, i) => (
              <span key={m.id}>
                {i > 0 && ', '}
                <Link className="underline" href={`/transcript/${m.id}`}>
                  {m.title || 'a meeting'}
                </Link>
                {m.trashed && ' (in the trash)'}
              </span>
            ))}
          </div>
        )}

        {rec?.suggested_event?.title && !rec.in_meeting && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs" data-match-hint>
            <CalendarSearch className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="min-w-0">
              Looks like <span className="font-medium">{rec.suggested_event.title}</span> ·{' '}
              {new Date(rec.suggested_event.startIso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
            {linkable && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                disabled={busy === 'link'}
                onClick={() =>
                  run('link', async () =>
                    openMeeting(await call(`/api/recordings/${id}/link`, 'POST', { eventKey: rec.suggested_event!.key }))
                  )
                }
              >
                {busy === 'link' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                Link to it
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={busy === 'dismiss'}
              onClick={() =>
                run('dismiss', async () => {
                  await call(`/api/recordings/${id}`, 'PATCH', { dismissSuggestedEvent: true });
                  await load();
                })
              }
            >
              Not this
            </Button>
          </div>
        )}

        {model && <RecordingStrip model={model} />}
        {err && <p className="text-xs text-destructive">{err}</p>}

        {rec && !rec.in_meeting && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" className={iconBtn} disabled={!linkable} onClick={() => setLinkOpen(true)}>
              <Link2 className="h-3.5 w-3.5" /> Link to meeting…
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={iconBtn}
              disabled={!linkable}
              onClick={() => {
                setName(rec.title ?? '');
                setNaming(true);
              }}
            >
              <FilePlus2 className="h-3.5 w-3.5" /> Make a meeting
            </Button>
            {rec.temporary && (
              <Button
                size="sm"
                variant="outline"
                className={iconBtn}
                disabled={busy === 'keep'}
                onClick={() =>
                  run('keep', async () => {
                    await call(`/api/recordings/${id}`, 'PATCH', { keep: true });
                    setNow(Date.now());
                    await load();
                  })
                }
              >
                <Archive className="h-3.5 w-3.5" /> Keep
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className={`${iconBtn} ml-auto text-muted-foreground hover:text-destructive`}
              disabled={busy === 'delete' || rec.status === 'uploading'}
              onClick={() =>
                run('delete', async () => {
                  if (!window.confirm(`Delete this recording for good? Its file and transcript go too.\n\n${title}`)) return;
                  await call(`/api/recordings/${id}`, 'DELETE');
                  router.push('/recordings');
                })
              }
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          </div>
        )}

        {rec && rec.status !== 'uploading' && (
          <AudioPlayer
            ref={playerRef}
            className="h-10 w-full"
            src={`/api/recordings/${id}/audio`}
            hasVideo={!!rec.has_video}
            mediaTitle={title}
          />
        )}

        {speakers.length > 0 && (
          <p className="text-xs text-muted-foreground" data-recording-speakers>
            {speakers.length} speaker{speakers.length === 1 ? '' : 's'}:{' '}
            {speakers.map(([s, ms]) => `Speaker ${s} (${formatDuration(Math.round(ms / 1000))})`).join(' · ')}
          </p>
        )}

        {content?.utterances && content.utterances.length > 0 ? (
          <ol className="space-y-2" data-recording-text>
            {content.utterances.map((u, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <button
                  type="button"
                  className="w-12 shrink-0 text-left font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground"
                  onClick={() => playerRef.current?.seekToSeconds(u.start / 1000)}
                  title="Play from here"
                >
                  {formatTime(u.start)}
                </button>
                <div className="min-w-0">
                  <span className="mr-1.5 text-xs font-semibold text-muted-foreground">Speaker {u.speaker}</span>
                  <span className="break-words">{u.text}</span>
                </div>
              </li>
            ))}
          </ol>
        ) : rec && ready ? (
          <p className="text-sm text-muted-foreground">No speech was found in this recording.</p>
        ) : !rec && !err ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" data-recording-loading>
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the recording…
          </div>
        ) : rec && (rec.status === 'uploading' || rec.status === 'transcribing') ? (
          <div className="flex items-start gap-3 rounded-lg border bg-muted/40 px-4 py-4 text-sm" data-recording-pending>
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium">
                {rec.status === 'uploading' ? 'Uploading — please wait…' : 'Transcribing — please wait…'}
              </p>
              <p className="text-xs text-muted-foreground">
                {rec.status === 'uploading'
                  ? 'The transcript starts as soon as the upload finishes.'
                  : 'Usually a minute or two; longer for a long recording.'}{' '}
                This page updates by itself — you can leave and come back.
              </p>
              {!rec.in_meeting && (
                <p className="text-xs text-muted-foreground">
                  No need to wait: link it or make a meeting now, and the text lands there when it is done.
                </p>
              )}
            </div>
          </div>
        ) : null}

        {rec?.in_meeting && rec.meetings[0] && (
          <Button size="sm" variant="outline" className={iconBtn} onClick={() => router.push(`/transcript/${rec.meetings[0]!.id}`)}>
            <ExternalLink className="h-3.5 w-3.5" /> Open the meeting
          </Button>
        )}
      </main>

      {linkOpen && (
        <LinkEventDialog
          open
          transcriptId=""
          recordingId={id}
          initialDateIso={rec?.started_at ?? rec?.created_at ?? null}
          onClose={() => setLinkOpen(false)}
          onLinked={() => {
            setLinkOpen(false);
            void load().then((r) => {
              const m = r?.meetings?.[0];
              if (m) router.push(`/transcript/${m.id}`);
            });
          }}
        />
      )}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Video, CircleDot, CheckCircle2, ScreenShare, Upload, X, UserRoundCheck } from 'lucide-react';
import {
  callKindLabel,
  formatCompanionDuration,
  getCompanion,
  shareLabel,
  useCompanion,
} from '@/lib/companion/companion-client';

/**
 * Call-outs driven by the local Darth Recorder tray (see companion-client.ts).
 * Mounted once in the root layout, same slot as <OfflineBanner>; renders
 * nothing unless a tray is connected AND there is something to say:
 *
 *  - "Teams call detected" (+ window title) with Record / Not now while a
 *    call is live and nothing is recording. "Not now" hides that one call.
 *  - "Recording · mm:ss" with Stop while the tray records.
 *  - "Darth Recorder isn't signed in" (amber, sticky) whenever the connected
 *    tray reports signed_in:false: nothing it records can upload until its
 *    user approves it once. "Sign in" asks the tray to start the darth device
 *    flow; the tray answers with `auth_prompt` (approval URL + code) and the
 *    banner turns into "Approve in your browser — code XXXX" with a link, so
 *    the approval happens in THIS browser, one click. Shown below any
 *    call/recording banner, dismissable for the page's life only.
 *  - "Recording saved" after a stop (shown ahead of a still-live call). When
 *    the tray did not auto-upload it — auto-upload off, or the upload failed —
 *    the toast carries "Upload now", pre-linked to the event the tray matched,
 *    and sticks around for 90 s instead of 12 s. A 0.1.5 tray reports no
 *    recording id, so there is nothing to address and the plain toast shows.
 *
 * Record/Stop are commands to the tray; the tray does the capture and the
 * upload, this page is only a remote control. Ordinary users with no tray
 * installed never see any of this.
 */
export function CompanionBanner() {
  const c = useCompanion();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [closedSaved, setClosedSaved] = useState(0);
  const [, setTick] = useState(0);

  // Not `lastEvent`: the upload_* events that "Upload now" triggers would
  // otherwise tear the toast down mid-upload.
  const stopped = c.lastStopped;
  const saved = stopped?.saved ?? null;
  const savedId = saved?.recording_id ?? null;
  const upload = savedId ? c.uploads[savedId] : undefined;
  // Offer the manual upload when the tray is not going to do it itself: the
  // toggle is off, or its own attempt failed. autoUpload === null means the
  // tray never reports it (0.1.x) — no recording id either, so no offer.
  const offer = !!savedId && (c.autoUpload === false || upload?.status === 'failed');
  const savedVisible =
    !!stopped && stopped.at !== closedSaved && Date.now() - stopped.at < (offer ? 90_000 : 12_000);

  // 1 Hz re-render while recording (for the timer) or while the saved toast is showing.
  useEffect(() => {
    if (!c.recording && !savedVisible) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [c.recording, savedVisible]);

  const [signInHidden, setSignInHidden] = useState(false);

  if (!c.connected) return null;

  const call = c.calls.find((k) => !dismissed.has(k.id)) ?? null;
  const prompt = c.authPrompt;
  const needsSignIn = c.signedIn === false && !signInHidden;
  const shell =
    'pointer-events-auto mt-2 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]';

  let body: React.ReactNode = null;
  if (c.recording) {
    const since = c.recordingSince ? Date.parse(c.recordingSince) : Date.now();
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    body = (
      <div
        role="status"
        data-companion-recording
        className={`${shell} border-red-300 bg-red-50 text-red-900 dark:border-red-700/60 dark:bg-red-950/80 dark:text-red-200`}
      >
        <CircleDot className="h-4 w-4 shrink-0 animate-pulse" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Recording {c.recordingLabel ?? 'display'} · {mm}:{ss}
          </p>
          <p className="flex min-w-0 items-center gap-1.5 truncate text-xs opacity-80">
            {c.share && <ScreenShare className="h-3 w-3 shrink-0" />}
            {shareLabel(c.share) ?? c.recordingPath ?? 'Darth Recorder on this Mac'}
          </p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs hover:bg-red-100 dark:hover:bg-red-900/50" onClick={() => getCompanion().send('stop')}>
          Stop
        </Button>
      </div>
    );
  } else if (savedVisible && stopped) {
    const matchedTitle = typeof saved?.matched?.title === 'string' ? saved.matched.title : null;
    const failed = upload?.status === 'failed';
    body = (
      <div
        role="status"
        data-companion-saved
        data-companion-offer={offer ? '1' : undefined}
        className={`${shell} ${
          failed
            ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/80 dark:text-amber-200'
            : 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700/60 dark:bg-sky-950/80 dark:text-sky-200'
        }`}
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {failed ? 'Recording saved — upload failed' : 'Recording saved'}
            {saved?.seconds ? ` (${formatCompanionDuration(saved.seconds)})` : ''}
          </p>
          <p className="truncate text-xs opacity-80">
            {upload?.status === 'uploading'
              ? `Uploading ${Math.round(upload.pct)}%…`
              : failed
                ? (upload?.error ?? 'The recorder could not upload it.')
                : offer
                  ? matchedTitle
                    ? `Not uploaded yet — it matches “${matchedTitle}”.`
                    : 'Not uploaded yet — it is still only on this Mac.'
                  : (saved?.path ?? '')}
          </p>
        </div>
        {offer && upload?.status !== 'uploading' && (
          <Button
            size="sm"
            className="h-7 shrink-0 px-2.5 text-xs"
            data-companion-upload-now
            onClick={() => savedId && getCompanion().upload(savedId, saved?.matched ?? null)}
          >
            <Upload className="h-3.5 w-3.5" /> {failed ? 'Retry upload' : 'Upload now'}
          </Button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          className="shrink-0 rounded p-0.5 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
          onClick={() => setClosedSaved(stopped.at)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  } else if (call) {
    body = (
      <div
        role="status"
        data-companion-call
        className={`${shell} border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700/60 dark:bg-emerald-950/80 dark:text-emerald-200`}
      >
        <Video className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{callKindLabel(call.kind)} detected</p>
          <p className="truncate text-xs opacity-80">{call.title || `${call.app} is using the microphone`}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs"
            data-companion-record
            disabled={c.screenPermission === false}
            title={c.screenPermission === false ? 'Allow Screen Recording for Darth Recorder in System Settings first' : undefined}
            onClick={() => getCompanion().send('start', { pid: call.pid })}
          >
            Record
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs hover:bg-emerald-100 dark:hover:bg-emerald-900/50"
            onClick={() => setDismissed((d) => new Set(d).add(call.id))}
          >
            Not now
          </Button>
        </div>
      </div>
    );
  }

  const signIn = needsSignIn ? (
    <div
      role="status"
      data-companion-signin
      data-companion-signin-prompt={prompt ? '1' : undefined}
      className={`${shell} border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/80 dark:text-amber-200`}
    >
      <UserRoundCheck className="h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {prompt ? 'Approve Darth Recorder in your browser' : 'Darth Recorder on this Mac is not signed in'}
        </p>
        <p className="truncate text-xs opacity-80">
          {prompt
            ? `Confirm the code ${prompt.userCode ?? ''} on the approval page — one click, you are already logged in.`
            : 'Recordings stay on this Mac and never reach Darth Meetings until you approve it once.'}
        </p>
      </div>
      {prompt?.verifyUrl ? (
        <Button size="sm" className="h-7 shrink-0 px-2.5 text-xs" asChild data-companion-signin-open>
          <a href={prompt.verifyUrl} target="_blank" rel="noopener">
            Open approval page
          </a>
        </Button>
      ) : (
        <Button size="sm" className="h-7 shrink-0 px-2.5 text-xs" data-companion-signin-btn onClick={() => getCompanion().login()}>
          Sign in
        </Button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
        onClick={() => setSignInHidden(true)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null;

  if (!body && !signIn) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-30 px-6" data-companion-banner>
      <div className="mx-auto max-w-[1720px]">
        {body}
        {signIn}
      </div>
    </div>
  );
}

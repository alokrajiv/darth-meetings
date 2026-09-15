'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AppWindow,
  ArrowUpCircle,
  CheckCircle2,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  LogIn,
  RefreshCw,
  ScreenShare,
} from 'lucide-react';
import {
  callKindLabel,
  companionPlatformSupported,
  getCompanion,
  shareLabel,
  useCompanion,
} from '@/lib/companion/companion-client';
import { RecorderRecordings } from '@/components/recorder-recordings';

/**
 * Settings card for the Mac menu-bar helper ("Darth Recorder"): install
 * one-liner when nothing answers on the local socket, live status when it
 * does (version, Screen Recording grant, current call / recording), and an
 * "Open Darth Recorder" button that uses the app's darth-recorder:// URL
 * scheme (launches it if installed but not running).
 *
 * With a 0.2.0 tray it also shows who the recorder is signed in as, mirrors its
 * "Upload recordings automatically" toggle, lists the recordings still sitting
 * on this Mac (Upload / Retry per row), and reports a staged self-update. A
 * 0.1.5 tray reports none of that: the sign-in block and the toggle are hidden
 * (they are `null`, not `false`) and the list says to update the recorder.
 *
 * Distribution is the shared CLI host on the Tailnet — see
 * poc/mac-recorder/README.md. Windows helper does not exist yet.
 */

export const RECORDER_INSTALL_CMD = 'curl -fsSL https://cli.darth-internal.trames.io/setup-darth-recorder.sh | bash';
const RECORDER_DIST_URL = 'https://cli.darth-internal.trames.io/darth-recorder/version.json';
const RECORDER_DMG_URL = 'https://cli.darth-internal.trames.io/darth-recorder/DarthRecorder-latest.dmg';

export function RecorderCard() {
  const c = useCompanion();
  const [copied, setCopied] = useState(false);
  const [mac, setMac] = useState(true);
  useEffect(() => setMac(companionPlatformSupported()), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(RECORDER_INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command is visible anyway */
    }
  };

  const openApp = () => {
    window.location.href = 'darth-recorder://open';
  };

  const call = c.calls[0];
  const share = shareLabel(c.share);
  const update = c.updateStaged ?? c.updateAvailable;

  return (
    <Card data-recorder-card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AppWindow className="h-4 w-4" />
          Mac recorder
          {c.connected ? (
            <Badge className="ml-1 bg-emerald-600 hover:bg-emerald-600">Connected{c.version ? ` · v${c.version}` : ''}</Badge>
          ) : c.everSeen ? (
            <Badge variant="secondary" className="ml-1">
              Installed · not running
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-1">
              Not installed
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Darth Recorder is a small menu-bar app that notices when a Teams, Meet or Zoom call starts on this
          Mac and records your screen and system audio so the meeting is captured even when the other side
          cannot share theirs. Nothing is recorded until you press Record.
        </p>

        {!mac && !c.connected && !c.everSeen ? (
          <p className="flex items-center gap-2 text-amber-700 dark:text-amber-400" data-recorder-unsupported>
            <CircleAlert className="h-4 w-4 shrink-0" /> macOS only for now — Windows and Linux helpers are planned.
            Nothing to install on this computer yet.
          </p>
        ) : c.connected ? (
          <div className="space-y-2" data-recorder-connected>
            <p className="flex items-center gap-2">
              {c.screenPermission === false ? (
                <>
                  <CircleAlert className="h-4 w-4 shrink-0 text-amber-600" />
                  <span>
                    Screen Recording is not allowed yet — System Settings › Privacy &amp; Security › Screen Recording
                    › <b>Darth Recorder</b>. macOS relaunches the app after you toggle it.
                  </span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>Screen Recording allowed. Ready to record.</span>
                </>
              )}
            </p>
            <p className="text-muted-foreground">
              {c.recording
                ? `Recording ${c.recordingLabel ?? 'display'} → ${c.recordingPath ?? ''}`
                : call
                  ? `${callKindLabel(call.kind)} in progress${call.title ? ` — ${call.title}` : ` (${call.app})`}`
                  : 'No call detected right now. Recordings are saved to ~/Movies/Darth Recorder.'}
            </p>
            {share && (
              <p className="flex items-center gap-2 text-muted-foreground" data-recorder-share>
                <ScreenShare className="h-4 w-4 shrink-0" /> {share}
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={openApp}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open Darth Recorder
              </Button>
              {c.recording ? (
                <Button size="sm" variant="destructive" onClick={() => getCompanion().send('stop')}>
                  Stop recording
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={c.screenPermission === false}
                  onClick={() => getCompanion().send('start', call ? { pid: call.pid } : {})}
                >
                  {call ? 'Record this call' : 'Record screen now'}
                </Button>
              )}
            </div>

            {/* --- 0.2.0 only: sign-in, auto-upload, local recordings --- */}
            {c.signedIn !== null && (
              <div className="flex flex-wrap items-center gap-2 border-t pt-3" data-recorder-signin>
                {c.signedIn ? (
                  <p className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>
                      Signed in as <b>{c.email ?? 'this account'}</b> — recordings upload to your
                      Darth Meetings.
                    </span>
                  </p>
                ) : (
                  <>
                    <p className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                      <CircleAlert className="h-4 w-4 shrink-0" />
                      <span>
                        The recorder is not signed in, so nothing can upload. Signing in opens a
                        browser tab and takes a few seconds.
                      </span>
                    </p>
                    <Button size="sm" onClick={() => getCompanion().login()} data-recorder-signin-btn>
                      <LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign in recorder
                    </Button>
                  </>
                )}
              </div>
            )}

            {c.autoUpload !== null && (
              <label className="flex items-start gap-2 text-sm" data-recorder-autoupload>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={c.autoUpload}
                  onChange={(e) => getCompanion().setAutoUpload(e.target.checked)}
                />
                <span>
                  Upload recordings automatically
                  <span className="block text-xs text-muted-foreground">
                    Mirrors the recorder&apos;s own menu item. Off means every recording waits here
                    until you press Upload.
                  </span>
                </span>
              </label>
            )}

            <div className="space-y-2 border-t pt-3" data-recorder-local>
              <p className="flex items-center justify-between gap-2 font-medium">
                <span>Recordings on this Mac</span>
                {c.recordingsPendingUpload ? (
                  <Badge variant="secondary">{c.recordingsPendingUpload} to upload</Badge>
                ) : null}
              </p>
              <RecorderRecordings limit={6} />
            </div>

            <p className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground" data-recorder-version>
              <span>Version {c.version ?? 'unknown'}</span>
              {update ? (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  {c.updateStaged
                    ? `Update ${c.updateStaged} downloaded — it installs when you are not recording.`
                    : `Update ${c.updateAvailable} available — the recorder fetches it within a few hours.`}
                </span>
              ) : (
                <span>Up to date. It checks for updates on its own.</span>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-2" data-recorder-install>
            {c.everSeen ? (
              <p>
                It is installed on this Mac but not running. Open it from Spotlight (⌘ Space, “Darth Recorder”) or:
              </p>
            ) : (
              <>
                <p>
                  <b>Install (macOS 14 or newer, Trames Tailnet):</b> download, open the disk image, drag{' '}
                  <b>Darth Recorder</b> onto the Applications folder next to it, then open it. Notarized by Apple, so
                  no warning dialog — and if you open it from Downloads instead, it offers to move itself.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" asChild>
                    <a href={RECORDER_DMG_URL} data-recorder-download>
                      <Download className="mr-1.5 h-3.5 w-3.5" /> Download for Mac
                    </a>
                  </Button>
                  <span className="text-xs text-muted-foreground">or from a Terminal, which also installs and launches it:</span>
                </div>
              </>
            )}
            {!c.everSeen && (
              <div className="flex items-center gap-2">
                <code className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
                  {RECORDER_INSTALL_CMD}
                </code>
                <Button size="sm" variant="outline" onClick={copy} title="Copy">
                  <Copy className="h-3.5 w-3.5" />
                  <span className="sr-only">Copy</span>
                </Button>
                {copied && <span className="text-xs text-emerald-600">Copied</span>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant={c.everSeen ? 'default' : 'outline'} onClick={openApp}>
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open Darth Recorder
              </Button>
              <Button size="sm" variant="ghost" onClick={() => getCompanion().retryNow()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Check again
              </Button>
              <a
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                href={RECORDER_DIST_URL}
                target="_blank"
                rel="noreferrer"
              >
                current version
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              After install macOS asks once for Screen Recording. Then this card turns green and a banner
              appears here whenever a call starts.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

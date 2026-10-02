'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { legacyTabRedirect } from '@/lib/app-nav';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload, requestMediaUpload } from '@/components/audio-upload';
import { getGoogleAccessToken } from '@/lib/google-token';
import { GmeetImportDialog } from '@/components/gmeet-import-dialog';
import { GmeetRemindersCard, type Reminder } from '@/components/gmeet-reminders-card';
import { TranscriptImportDialog } from '@/components/transcript-import-dialog';
import { AppHeader } from '@/components/app-header';
import { SetupReviewDialog } from '@/components/setup-review-dialog';
import { LabelRail, LABEL_RAIL_STORAGE_KEY } from '@/components/label-rail';
import { useShellToggleSidebar } from '@/components/shell-search';
import { Button } from '@/components/ui/button';
import { ImportSplitButton } from '@/components/import-split-button';
import { CircleAlert } from 'lucide-react';
import { LISTING_MAX_CONTENT_PX } from '@/lib/listing-layout';
import { labelFilterToParams, parseLabelFilter, type LabelFilter } from '@/lib/labels';

const REMINDERS_COLLAPSED_KEY = 'mw-reminders-collapsed';

/** Rewrite `?label=&exact=` in place (history.replaceState, other params kept). */
function writeLabelFilterToUrl(f: LabelFilter | null): void {
  if (typeof window === 'undefined') return;
  const sp = new URLSearchParams(window.location.search);
  sp.delete('label');
  sp.delete('exact');
  for (const [k, v] of Object.entries(labelFilterToParams(f))) sp.set(k, v);
  const qs = sp.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== cur) window.history.replaceState(window.history.state, '', next);
}

function readLabelFilterFromUrl(): LabelFilter | null {
  const sp = new URLSearchParams(window.location.search);
  return parseLabelFilter(sp.get('label'), sp.get('exact'));
}


export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const to = legacyTabRedirect(window.location.search);
    if (to) router.replace(to);
  }, [router]);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [gmeetOpen, setGmeetOpen] = useState(false);
  const [gmeetSyncMode, setGmeetSyncMode] = useState(false);
  const [gmeetFocus, setGmeetFocus] = useState<{
    meetingCode: string | null;
    eventStart: string | null;
  } | null>(null);
  const [textImportOpen, setTextImportOpen] = useState(false);

  // Meeting reminders (the poller's findings). The page owns the data: it
  // feeds the top banner (dismissable for good, localStorage), the header
  // badge count, and the header dropdown that the badge icon opens.
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [remindersCollapsed, setRemindersCollapsed] = useState(false);
  const [reminderMenuOpen, setReminderMenuOpen] = useState(false);
  const reminderMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setRemindersCollapsed(localStorage.getItem(REMINDERS_COLLAPSED_KEY) === '1');
  }, []);
  useEffect(() => {
    fetch('/api/gmeet/reminders')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setReminders(data?.reminders ?? []))
      .catch(() => {});
  }, [refreshTrigger]);
  const reminderCount = reminders.length;
  const actOnReminder = (r: Reminder, action: 'dismiss' | 'mute') => {
    setReminders((prev) => prev.filter((x) => x.id !== r.id));
    void fetch('/api/gmeet/reminders', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: r.id,
        action,
        meetingCode: r.meetingCode,
        title: r.title,
        eventStart: r.eventStart,
      }),
    }).catch(() => {
      // Dropped (network down) — put it back so the dismissal is not
      // silently lost.
      setReminders((prev) => (prev.some((x) => x.id === r.id) ? prev : [r, ...prev]));
    });
  };
  const dismissBanner = () => {
    setRemindersCollapsed(true);
    localStorage.setItem(REMINDERS_COLLAPSED_KEY, '1');
  };
  const openMeetingFromReminder = (r: Reminder) => {
    setReminderMenuOpen(false);
    setGmeetFocus({ meetingCode: r.meetingCode, eventStart: r.eventStart });
    setGmeetOpen(true);
  };
  // Close the reminders dropdown on outside click / Escape.
  useEffect(() => {
    if (!reminderMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (reminderMenuRef.current && !reminderMenuRef.current.contains(e.target as Node)) {
        setReminderMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setReminderMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [reminderMenuOpen]);

  // Warm the Google token cache on landing so the import dialog opens
  // straight into the calendar instead of flashing the Connect step while
  // it round-trips /api/google/token. Not-connected users just no-op here.
  useEffect(() => {
    void getGoogleAccessToken().catch(() => {});
  }, []);

  // Post-connect landing: the Google callback returns to /?meet=1|sync
  // (&google=connected) so the import dialog the user came from reopens —
  // now with silent server-minted tokens.
  const urlParamsHandledRef = useRef(false);
  useEffect(() => {
    if (urlParamsHandledRef.current) return;
    urlParamsHandledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const meet = params.get('meet');
    if (meet) {
      setGmeetSyncMode(meet === 'sync');
      setGmeetOpen(true);
    }
    // /m/<uuid> of a not-yet-imported occurrence lands here as
    // /?import=<code>&start=<iso> — open the import dialog focused on it.
    const importCode = params.get('import');
    if (importCode) {
      setGmeetFocus({ meetingCode: importCode, eventStart: params.get('start') });
      setGmeetOpen(true);
    }
    if (meet || importCode || params.get('google')) {
      params.delete('meet');
      params.delete('google');
      params.delete('reason');
      params.delete('import');
      params.delete('start');
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, []);

  const handleTranscriptCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  // Labels (docs/labels-design.md §4): the page owns the `?label=&exact=`
  // filter (URL = source of truth, shareable) and the rail's collapsed state
  // (localStorage `mw-label-rail`); the rail and the table both receive it.
  //
  // The rail starts COLLAPSED for everyone — only an explicit stored 'open'
  // reopens it (phones used to boot with a 240px column eating the
  // listing). Below Tailwind's `md` (768px) the rail is an overlay drawer
  // instead of a side column, and its open state is never persisted there:
  // a phone always starts closed, the toolbar "Labels" button opens it.
  const [labelFilter, setLabelFilterState] = useState<LabelFilter | null>(null);
  const [labelReady, setLabelReady] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [railNarrow, setRailNarrow] = useState(false);
  useEffect(() => {
    setLabelFilterState(readLabelFilterFromUrl());
    setLabelReady(true);
    const readStoredOpen = () => {
      try {
        return localStorage.getItem(LABEL_RAIL_STORAGE_KEY) === 'open';
      } catch {
        return false; // storage blocked — stays collapsed
      }
    };
    const mq = window.matchMedia('(min-width: 768px)');
    const narrow = !mq.matches;
    setRailNarrow(narrow);
    if (!narrow && readStoredOpen()) setRailCollapsed(false);
    // Rotation / window resize across the breakpoint: going narrow closes an
    // open side column (it would otherwise pop up as a drawer over the
    // table); going wide restores whatever the desktop preference is.
    const onChange = (e: MediaQueryListEvent) => {
      const nowNarrow = !e.matches;
      setRailNarrow(nowNarrow);
      setRailCollapsed(nowNarrow ? true : !readStoredOpen());
    };
    mq.addEventListener('change', onChange);
    const onPop = () => setLabelFilterState(readLabelFilterFromUrl());
    window.addEventListener('popstate', onPop);
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  const setLabelFilter = (next: LabelFilter | null) => {
    setLabelFilterState((prev) => {
      const same =
        (prev === null && next === null) ||
        (prev?.kind === 'none' && next?.kind === 'none') ||
        (prev?.kind === 'id' && next?.kind === 'id' && prev.id === next.id && prev.exact === next.exact);
      return same ? prev : next;
    });
    writeLabelFilterToUrl(next);
  };
  const toggleRail = (collapsed: boolean) => {
    setRailCollapsed(collapsed);
    if (railNarrow) return; // drawer: never persisted, a phone always starts closed
    try {
      localStorage.setItem(LABEL_RAIL_STORAGE_KEY, collapsed ? 'collapsed' : 'open');
    } catch {
      // storage blocked — state just won't persist
    }
  };
  // Darth desktop shell: the band's sidebar button toggles the labels rail
  // (a no-op subscription outside the shell).
  useShellToggleSidebar(() => toggleRail(!railCollapsed));

  return (
    <div className="min-h-screen">
      {/* Header (README "Darth desktop shell" → Layout rules): ONE import
          split button, the reminders badge; AppHeader adds the
          Recorder chip and the account menu at the far right. */}
      <AppHeader>
        <ImportSplitButton
          onAction={(a) => {
            if (a === 'import-meeting') setGmeetOpen(true);
            else if (a === 'import-file') setTextImportOpen(true);
            else requestMediaUpload();
          }}
        />
        {reminderCount > 0 && (
          <div className="relative" ref={reminderMenuRef}>
            <Button
              variant="ghost"
              size="sm"
              className="relative h-8 w-8 p-0"
              title={`${reminderCount} meeting${reminderCount === 1 ? '' : 's'} need attention`}
              aria-expanded={reminderMenuOpen}
              aria-haspopup="menu"
              onClick={() => setReminderMenuOpen((o) => !o)}
            >
              <CircleAlert className="h-4 w-4 text-primary" />
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
                {reminderCount}
              </span>
              <span className="sr-only">Meeting reminders</span>
            </Button>
            {reminderMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-[600px] max-w-[92vw]">
                <GmeetRemindersCard
                  reminders={reminders}
                  variant="popover"
                  onOpenSync={() => {
                    setReminderMenuOpen(false);
                    setGmeetSyncMode(true);
                    setGmeetOpen(true);
                  }}
                  onOpenMeeting={openMeetingFromReminder}
                  onAct={actOnReminder}
                  onClose={() => setReminderMenuOpen(false)}
                />
              </div>
            )}
          </div>
        )}
      </AppHeader>

      {/* One layout at every width: designed for the shell's 900–1300 px
          window, never wider than LISTING_MAX_CONTENT_PX. */}
      <main className="mx-auto px-6 py-4" style={{ maxWidth: LISTING_MAX_CONTENT_PX }}>
        {/* Renders the page-wide drag-drop overlay, the hidden file input the
            header button clicks, and in-flight upload progress rows. */}
        <AudioUpload onTranscriptCreated={handleTranscriptCreated} />
        {!remindersCollapsed && (
          <GmeetRemindersCard
            reminders={reminders}
            onOpenSync={() => {
              setGmeetSyncMode(true);
              setGmeetOpen(true);
            }}
            onOpenMeeting={openMeetingFromReminder}
            onAct={actOnReminder}
            onClose={dismissBanner}
          />
        )}

        {/* Missing Google / Microsoft link, or the one-time auto-sync +
            notifications review → ONE modal, snoozable 24h (replaces the old
            connect-nudge banner + announce banner; see setup-review-dialog). */}
        <SetupReviewDialog />

        <div className="flex items-start gap-4">
          {!railCollapsed && (
            <LabelRail
              filter={labelFilter}
              onFilter={setLabelFilter}
              onChanged={handleTranscriptCreated}
              onCollapse={() => toggleRail(true)}
              variant={railNarrow ? 'drawer' : 'inline'}
              className={railNarrow ? '' : 'sticky top-4 max-h-[calc(100vh-2rem)]'}
            />
          )}
          <div className="min-w-0 flex-1">
            <TranscriptTable
              refreshTrigger={refreshTrigger}
              labelFilter={labelFilter}
              labelFilterReady={labelReady}
              onLabelFilter={setLabelFilter}
              labelRailOpen={!railCollapsed}
              onToggleLabelRail={() => toggleRail(!railCollapsed)}
              onImportMeeting={(m) => {
                // Same focus mechanism as reminder rows: open the import dialog
                // scrolled to that meeting's day, highlighting the meeting.
                setGmeetFocus({ meetingCode: m.meetingCode, eventStart: m.eventStart });
                setGmeetOpen(true);
              }}
            />
          </div>
        </div>
      </main>

      <GmeetImportDialog
        open={gmeetOpen}
        onClose={() => {
          setGmeetOpen(false);
          setGmeetSyncMode(false);
          setGmeetFocus(null);
          // Re-check the nudge — a sync pass inside the dialog moves the marker.
          setRefreshTrigger((prev) => prev + 1);
        }}
        onImported={handleTranscriptCreated}
        startInSync={gmeetSyncMode}
        focusMeeting={gmeetFocus}
      />
      <TranscriptImportDialog
        open={textImportOpen}
        onClose={() => setTextImportOpen(false)}
        onImported={handleTranscriptCreated}
      />
    </div>
  );
}

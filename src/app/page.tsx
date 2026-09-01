'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload, requestMediaUpload } from '@/components/audio-upload';
import { getGoogleAccessToken } from '@/lib/google-token';
import { LogoutButton } from '@/components/logout-button';
import { GmeetImportDialog } from '@/components/gmeet-import-dialog';
import { GmeetRemindersCard, type Reminder } from '@/components/gmeet-reminders-card';
import { TranscriptImportDialog } from '@/components/transcript-import-dialog';
import { AppHeader } from '@/components/app-header';
import { SetupReviewDialog } from '@/components/setup-review-dialog';
import { LabelRail, LABEL_RAIL_STORAGE_KEY } from '@/components/label-rail';
import { Button } from '@/components/ui/button';
import {
  Settings,
  Video,
  FileText,
  FileAudio,
  ChevronDown,
  CircleAlert,
  Tag,
} from 'lucide-react';
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
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [gmeetOpen, setGmeetOpen] = useState(false);
  const [gmeetSyncMode, setGmeetSyncMode] = useState(false);
  const [gmeetFocus, setGmeetFocus] = useState<{
    meetingCode: string | null;
    eventStart: string | null;
  } | null>(null);
  const [textImportOpen, setTextImportOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);

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
    }).catch(() => {});
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
  useEffect(() => {
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
  const [labelFilter, setLabelFilterState] = useState<LabelFilter | null>(null);
  const [labelReady, setLabelReady] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  useEffect(() => {
    setLabelFilterState(readLabelFilterFromUrl());
    setLabelReady(true);
    try {
      setRailCollapsed(localStorage.getItem(LABEL_RAIL_STORAGE_KEY) === 'collapsed');
    } catch {
      // storage blocked — rail just shows
    }
    const onPop = () => setLabelFilterState(readLabelFilterFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
    try {
      localStorage.setItem(LABEL_RAIL_STORAGE_KEY, collapsed ? 'collapsed' : 'open');
    } catch {
      // storage blocked — state just won't persist
    }
  };

  // Close the hand-rolled Import popover on outside click / Escape.
  useEffect(() => {
    if (!importMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setImportMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImportMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [importMenuOpen]);

  return (
    <div className="min-h-screen">
      <AppHeader>
        <div className="relative" ref={importMenuRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportMenuOpen((o) => !o)}
            aria-expanded={importMenuOpen}
            aria-haspopup="menu"
          >
            Import
            <ChevronDown className="h-4 w-4" />
          </Button>
          {importMenuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  setImportMenuOpen(false);
                  setTextImportOpen(true);
                }}
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Transcript file</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Teams, Zoom, VTT…
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => requestMediaUpload()}>
          <FileAudio className="h-4 w-4" />
          Upload media
        </Button>
        <Button size="sm" onClick={() => setGmeetOpen(true)}>
          <Video className="h-4 w-4" />
          Import meeting
        </Button>
        <div className="h-5 w-px bg-border" />
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
        <Link href="/settings">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Settings">
            <Settings className="h-4 w-4" />
            <span className="sr-only">Settings</span>
          </Button>
        </Link>
        <LogoutButton />
      </AppHeader>

      <main className="mx-auto max-w-[1720px] px-6 py-4">
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
              className="sticky top-4 max-h-[calc(100vh-2rem)]"
            />
          )}
          <div className="min-w-0 flex-1">
            <TranscriptTable
              refreshTrigger={refreshTrigger}
              labelFilter={labelFilter}
              labelFilterReady={labelReady}
              onLabelFilter={setLabelFilter}
              toolbarExtra={
                railCollapsed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    title="Show the labels rail"
                    data-label-rail-show
                    onClick={() => toggleRail(false)}
                  >
                    <Tag className="h-3.5 w-3.5" />
                    Labels
                    {labelFilter && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                  </Button>
                ) : undefined
              }
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

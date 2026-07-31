'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload, AUDIO_UPLOAD_INPUT_ID } from '@/components/audio-upload';
import { LogoutButton } from '@/components/logout-button';
import { ImportDialog } from '@/components/import-dialog';
import { GmeetImportDialog } from '@/components/gmeet-import-dialog';
import { TranscriptImportDialog } from '@/components/transcript-import-dialog';
import { AppHeader } from '@/components/app-header';
import { AskAiPanel } from '@/components/ask-ai-panel';
import { Button } from '@/components/ui/button';
import {
  Settings,
  Video,
  FileText,
  FileAudio,
  ChevronDown,
  KeyRound,
  Sparkles,
} from 'lucide-react';

const SYNC_NUDGE_AFTER_DAYS = 5;

export default function Home() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [gmeetOpen, setGmeetOpen] = useState(false);
  const [gmeetSyncMode, setGmeetSyncMode] = useState(false);
  const [textImportOpen, setTextImportOpen] = useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);

  // "Don't forget to sync" nudge: fetched once per visit; shows when the
  // user has never run a Meet sync or their last one is getting stale.
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    fetch('/api/gmeet/sync-state')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setLastSyncedAt(data ? (data.lastSyncedAt ?? null) : undefined))
      .catch(() => {});
  }, [refreshTrigger]);
  const syncAgeDays =
    lastSyncedAt === undefined
      ? null // unknown yet — no nudge flash
      : lastSyncedAt === null
        ? Infinity
        : Math.floor((Date.now() - new Date(lastSyncedAt).getTime()) / 86_400_000);
  const showSyncNudge = syncAgeDays !== null && syncAgeDays >= SYNC_NUDGE_AFTER_DAYS;

  const handleTranscriptCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
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
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-muted"
                onClick={() => {
                  setImportMenuOpen(false);
                  setImportOpen(true);
                }}
              >
                <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">From AssemblyAI key</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Bring across transcripts you already have
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            (document.getElementById(AUDIO_UPLOAD_INPUT_ID) as HTMLInputElement | null)?.click()
          }
        >
          <FileAudio className="h-4 w-4" />
          Upload audio
        </Button>
        <Button size="sm" onClick={() => setGmeetOpen(true)}>
          <Video className="h-4 w-4" />
          Import from Meet
        </Button>
        <div className="h-5 w-px bg-border" />
        <Link href="/settings">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Settings">
            <Settings className="h-4 w-4" />
            <span className="sr-only">Settings</span>
          </Button>
        </Link>
        <LogoutButton />
      </AppHeader>

      <main className="mx-auto max-w-[1200px] px-6 py-6">
        <div className="mb-5 flex items-start gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight leading-tight">Archive</h1>
            <p className="text-sm text-muted-foreground">
              Every meeting, transcribed and searchable.
            </p>
          </div>
          {!askOpen && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto mt-1"
              onClick={() => setAskOpen(true)}
              title="Ask questions about your meetings — the AI answers with links"
            >
              <Sparkles className="h-4 w-4 text-primary" />
              Ask AI
            </Button>
          )}
        </div>

        {askOpen && (
          <div className="mb-4">
            <AskAiPanel onClose={() => setAskOpen(false)} />
          </div>
        )}

        {showSyncNudge && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-4 py-2.5 text-sm">
            <Video className="h-4 w-4 shrink-0 text-primary" />
            <span>
              {lastSyncedAt
                ? `Your Meet meetings were last synced ${syncAgeDays} days ago.`
                : 'You haven’t synced your Meet meetings yet.'}
              <span className="text-muted-foreground">
                {' '}
                Pull everything in so nothing gets forgotten.
              </span>
            </span>
            <Button
              size="sm"
              className="ml-auto h-7"
              onClick={() => {
                setGmeetSyncMode(true);
                setGmeetOpen(true);
              }}
            >
              Sync now
            </Button>
          </div>
        )}

        <div className="flex flex-col gap-5">
          <AudioUpload onTranscriptCreated={handleTranscriptCreated} />
          <TranscriptTable refreshTrigger={refreshTrigger} />
        </div>
      </main>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleTranscriptCreated}
      />
      <GmeetImportDialog
        open={gmeetOpen}
        onClose={() => {
          setGmeetOpen(false);
          setGmeetSyncMode(false);
          // Re-check the nudge — a sync pass inside the dialog moves the marker.
          setRefreshTrigger((prev) => prev + 1);
        }}
        onImported={handleTranscriptCreated}
        startInSync={gmeetSyncMode}
      />
      <TranscriptImportDialog
        open={textImportOpen}
        onClose={() => setTextImportOpen(false)}
        onImported={handleTranscriptCreated}
      />
    </div>
  );
}

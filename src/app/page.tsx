'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload } from '@/components/audio-upload';
import { LogoutButton } from '@/components/logout-button';
import { ImportDialog } from '@/components/import-dialog';
import { GmeetImportDialog } from '@/components/gmeet-import-dialog';
import { Button } from '@/components/ui/button';
import { Settings, Download, Video } from 'lucide-react';

export default function Home() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [gmeetOpen, setGmeetOpen] = useState(false);

  const handleTranscriptCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <div className="container mx-auto px-4 py-6 sm:py-8">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-6 sm:mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Meeting Whisperer</h1>
          <p className="text-sm text-muted-foreground">
            Upload meeting audio and manage your transcripts
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setGmeetOpen(true)} title="Import from Google Meet">
            <Video className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Import from Meet</span>
            <span className="sm:hidden">Meet</span>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} title="Import from AAI key">
            <Download className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">Import from AAI key</span>
            <span className="sm:hidden">Import</span>
          </Button>
          <Link href="/settings">
            <Button variant="outline" size="sm" title="Settings">
              <Settings className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">Settings</span>
            </Button>
          </Link>
          <LogoutButton />
        </div>
      </div>

      <div className="grid gap-6">
        <AudioUpload onTranscriptCreated={handleTranscriptCreated} />
        <TranscriptTable refreshTrigger={refreshTrigger} />
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleTranscriptCreated}
      />
      <GmeetImportDialog
        open={gmeetOpen}
        onClose={() => setGmeetOpen(false)}
        onImported={handleTranscriptCreated}
      />
    </div>
  );
}

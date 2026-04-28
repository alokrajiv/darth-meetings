'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload } from '@/components/audio-upload';
import { LogoutButton } from '@/components/logout-button';
import { ImportDialog } from '@/components/import-dialog';
import { Button } from '@/components/ui/button';
import { Settings, Download } from 'lucide-react';

export default function Home() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [importOpen, setImportOpen] = useState(false);

  const handleTranscriptCreated = () => {
    setRefreshTrigger((prev) => prev + 1);
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Meeting Whisperer</h1>
          <p className="text-muted-foreground">
            Upload meeting audio and manage your transcripts
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Download className="h-4 w-4" />
            Import from AAI key
          </Button>
          <Link href="/settings">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4" />
              Settings
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
    </div>
  );
}

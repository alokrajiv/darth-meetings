'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TranscriptTable } from '@/components/transcript-table';
import { AudioUpload } from '@/components/audio-upload';
import { AssemblyAIClient } from '@/lib/assemblyai';
import { db } from '@/lib/db';
import { Settings, Download, Upload } from 'lucide-react';

export default function Home() {
  const [apiKey, setApiKey] = useState('');
  const [isValidApiKey, setIsValidApiKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    // Check if API key is stored in localStorage
    const storedApiKey = localStorage.getItem('assemblyai_api_key');
    if (storedApiKey) {
      setApiKey(storedApiKey);
      setIsValidApiKey(true);
    } else {
      setShowSettings(true);
    }
  }, []);

  const handleSaveApiKey = () => {
    if (AssemblyAIClient.validateApiKey(apiKey)) {
      localStorage.setItem('assemblyai_api_key', apiKey);
      setIsValidApiKey(true);
      setShowSettings(false);
    } else {
      alert('Please enter a valid AssemblyAI API key');
    }
  };

  const handleRemoveApiKey = () => {
    localStorage.removeItem('assemblyai_api_key');
    setApiKey('');
    setIsValidApiKey(false);
    setShowSettings(true);
  };

  const handleBackupDatabase = async () => {
    try {
      // Export all data from IndexedDB
      const speakerMappings = await db.speakerMappings.toArray();
      const transcriptHistory = await db.transcriptHistory.toArray();
      
      const backupData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        data: {
          speakerMappings,
          transcriptHistory
        }
      };

      // Create downloadable file
      const dataStr = JSON.stringify(backupData, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const filename = `${dateStr}-db-backup.mw.json`;
      
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      alert(`Database backup saved as ${filename}`);
    } catch (error) {
      console.error('Backup failed:', error);
      alert('Failed to backup database. Please try again.');
    }
  };

  const handleImportDatabase = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mw.json,.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const backupData = JSON.parse(text);
        
        // Validate backup format
        if (!backupData.data || !backupData.data.speakerMappings || !backupData.data.transcriptHistory) {
          throw new Error('Invalid backup file format');
        }
        
        // Confirm import
        const confirmed = confirm(
          `This will replace all existing data with the backup from ${backupData.timestamp || 'unknown date'}. Are you sure?`
        );
        
        if (!confirmed) return;
        
        // Clear existing data and import
        await db.transaction('rw', [db.speakerMappings, db.transcriptHistory], async () => {
          await db.speakerMappings.clear();
          await db.transcriptHistory.clear();
          await db.speakerMappings.bulkAdd(backupData.data.speakerMappings);
          await db.transcriptHistory.bulkAdd(backupData.data.transcriptHistory);
        });
        
        alert('Database imported successfully! Please refresh the page.');
        window.location.reload();
      } catch (error) {
        console.error('Import failed:', error);
        alert('Failed to import database. Please check the file format.');
      }
    };
    input.click();
  };

  const handleTranscriptCreated = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  if (!isValidApiKey || showSettings) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              AssemblyAI Settings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder="Enter your AssemblyAI API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSaveApiKey} className="flex-1">
                Save API Key
              </Button>
              {isValidApiKey && (
                <Button variant="outline" onClick={() => setShowSettings(false)}>
                  Cancel
                </Button>
              )}
            </div>
            {isValidApiKey && (
              <Button 
                variant="destructive" 
                onClick={handleRemoveApiKey}
                className="w-full"
              >
                Remove API Key
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold">Meeting Whisperer</h1>
          <p className="text-muted-foreground">
            Manage your AssemblyAI transcripts and speaker labels
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleBackupDatabase}
            className="flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            Backup
          </Button>
          <Button
            variant="outline"
            onClick={handleImportDatabase}
            className="flex items-center gap-2"
          >
            <Upload className="h-4 w-4" />
            Import
          </Button>
          <Button
            variant="outline"
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-2"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Button>
        </div>
      </div>

      <div className="grid gap-6">
        <AudioUpload 
          apiKey={apiKey} 
          onTranscriptCreated={handleTranscriptCreated}
        />
        
        <TranscriptTable 
          apiKey={apiKey} 
          refreshTrigger={refreshTrigger}
        />
      </div>
    </div>
  );
}

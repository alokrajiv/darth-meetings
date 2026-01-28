'use client';

import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Upload, FileAudio, X, CheckCircle, AlertCircle } from 'lucide-react';
import { AssemblyAIClient } from '@/lib/assemblyai';
import { db } from '@/lib/db';

interface AudioUploadProps {
  apiKey: string;
  onTranscriptCreated?: () => void;
}

const LANGUAGE_OPTIONS = [
  { code: '', label: 'Auto Detect' },
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese (Mandarin)' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
];

interface UploadStatus {
  file: File;
  status: 'uploading' | 'transcribing' | 'completed' | 'error';
  progress: number;
  transcriptId?: string;
  error?: string;
}

export function AudioUpload({ apiKey, onTranscriptCreated }: AudioUploadProps) {
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const startUpload = useCallback(async (files: File[], languageCode: string) => {
    for (const file of files) {
      const uploadStatus: UploadStatus = {
        file,
        status: 'uploading',
        progress: 0
      };

      setUploads(prev => [...prev, uploadStatus]);

      try {
        await submitForTranscription(file, languageCode);
      } catch (error) {
        setUploads(prev => prev.map(upload =>
          upload.file === file
            ? { ...upload, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
            : upload
        ));
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitForTranscription = async (file: File, languageCode: string) => {
    try {
      const client = new AssemblyAIClient(apiKey);

      // Step 1: Upload file directly to AssemblyAI
      setUploads(prev => prev.map(upload =>
        upload.file === file ? { ...upload, progress: 10 } : upload
      ));

      const buffer = await file.arrayBuffer();
      const audioUrl = await client.uploadFile(Buffer.from(buffer));

      // Step 2: Submit for transcription
      setUploads(prev => prev.map(upload =>
        upload.file === file
          ? { ...upload, status: 'transcribing', progress: 30 }
          : upload
      ));

      const transcript = await client.submitTranscription(audioUrl, languageCode || undefined);

      setUploads(prev => prev.map(upload =>
        upload.file === file
          ? { ...upload, transcriptId: transcript.id, progress: 50 }
          : upload
      ));

      // Save to local database immediately
      await db.saveTranscriptHistory({
        transcriptId: transcript.id,
        originalFilename: file.name,
        status: transcript.status,
        createdAt: new Date(),
        duration: 0, // Will be updated when completed
        speakerCount: 0, // Will be updated when completed
      });

      // Step 3: Poll for completion
      await pollTranscriptionStatus(transcript.id, file);

    } catch (error) {
      console.error('Transcription error:', error);
      setUploads(prev => prev.map(upload =>
        upload.file === file
          ? {
              ...upload,
              status: 'error',
              error: error instanceof Error ? error.message : 'Transcription failed'
            }
          : upload
      ));
    }
  };

  const pollTranscriptionStatus = async (transcriptId: string, file: File) => {
    const client = new AssemblyAIClient(apiKey);

    const checkStatus = async (): Promise<void> => {
      try {
        const transcript = await client.getTranscript(transcriptId);

        // Map status to progress percentage
        let progress = 50;
        switch (transcript.status) {
          case 'queued':
            progress = 60;
            break;
          case 'processing':
            progress = 80;
            break;
          case 'completed':
            progress = 100;
            break;
          case 'error':
            progress = 0;
            break;
        }

        setUploads(prev => prev.map(upload =>
          upload.file === file
            ? { ...upload, progress: Math.max(upload.progress, progress) }
            : upload
        ));

        if (transcript.status === 'completed') {
          // Update database with final details
          const createdDate = transcript.created ? new Date(transcript.created) : new Date();
          await db.saveTranscriptHistory({
            transcriptId: transcript.id,
            originalFilename: file.name,
            status: transcript.status,
            createdAt: isNaN(createdDate.getTime()) ? new Date() : createdDate,
            duration: transcript.audio_duration,
            speakerCount: transcript.utterances ? new Set(transcript.utterances.map(u => u.speaker)).size : 0,
          });

          setUploads(prev => prev.map(upload =>
            upload.file === file
              ? { ...upload, status: 'completed', progress: 100 }
              : upload
          ));

          if (onTranscriptCreated) {
            onTranscriptCreated();
          }
        } else if (transcript.status === 'error') {
          setUploads(prev => prev.map(upload =>
            upload.file === file
              ? { ...upload, status: 'error', error: transcript.error || 'Transcription failed' }
              : upload
          ));
        } else {
          // Continue polling
          setTimeout(checkStatus, 3000);
        }
      } catch (error) {
        setUploads(prev => prev.map(upload =>
          upload.file === file
            ? {
                ...upload,
                status: 'error',
                error: error instanceof Error ? error.message : 'Status check failed'
              }
            : upload
        ));
      }
    };

    await checkStatus();
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFilesSelected = useCallback((files: FileList) => {
    const fileArray = Array.from(files);
    setPendingFiles(fileArray);
    setSelectedLanguage('');
    setIsDialogOpen(true);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFilesSelected(files);
    }
  }, [handleFilesSelected]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFilesSelected(files);
    }
    // Reset input value to allow selecting the same file again
    e.target.value = '';
  }, [handleFilesSelected]);

  const handleConfirmUpload = () => {
    setIsDialogOpen(false);
    startUpload(pendingFiles, selectedLanguage);
    setPendingFiles([]);
  };

  const handleCancelUpload = () => {
    setIsDialogOpen(false);
    setPendingFiles([]);
    setSelectedLanguage('');
  };

  const removeUpload = (file: File) => {
    setUploads(prev => prev.filter(upload => upload.file !== file));
  };

  const getStatusIcon = (status: UploadStatus['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
      default:
        return <FileAudio className="h-4 w-4 text-blue-500" />;
    }
  };

  const getStatusText = (upload: UploadStatus) => {
    switch (upload.status) {
      case 'uploading':
        return 'Uploading...';
      case 'transcribing':
        return 'Transcribing...';
      case 'completed':
        return 'Completed';
      case 'error':
        return upload.error || 'Error';
      default:
        return 'Processing...';
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload Audio Files
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Upload Area */}
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
              isDragging
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <Upload className="h-12 w-12 mx-auto text-gray-400 mb-4" />
            <p className="text-lg font-medium mb-2">
              Drop files here or click to browse
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              Upload any audio or video file - we&apos;ll handle the rest
            </p>
            <Button onClick={handleFileSelect} variant="outline">
              Select Files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileInputChange}
              className="hidden"
            />
          </div>

          {/* Upload Queue */}
          {uploads.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium">Upload Queue</h4>
              {uploads.map((upload, index) => (
                <div key={`${upload.file.name}-${index}`} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {getStatusIcon(upload.status)}
                      <span className="font-medium text-sm">{upload.file.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {formatFileSize(upload.file.size)}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        {getStatusText(upload)}
                      </span>
                      {(upload.status === 'completed' || upload.status === 'error') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeUpload(upload.file)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {(upload.status === 'uploading' || upload.status === 'transcribing') && (
                    <Progress value={upload.progress} className="h-2" />
                  )}
                  {upload.status === 'error' && upload.error && (
                    <p className="text-sm text-red-500 mt-1">{upload.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Language Selection Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {pendingFiles.length} file{pendingFiles.length > 1 ? 's' : ''} selected:
              </p>
              <ul className="text-sm space-y-1">
                {pendingFiles.map((file, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <FileAudio className="h-4 w-4 text-muted-foreground" />
                    <span>{file.name}</span>
                    <Badge variant="outline" className="text-xs">
                      {formatFileSize(file.size)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <Label htmlFor="language-select">Language</Label>
              <select
                id="language-select"
                value={selectedLanguage}
                onChange={(e) => setSelectedLanguage(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {LANGUAGE_OPTIONS.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Select the primary language spoken in the audio, or use Auto Detect.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelUpload}>
              Cancel
            </Button>
            <Button onClick={handleConfirmUpload}>
              Start Transcription
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

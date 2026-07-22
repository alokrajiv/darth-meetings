'use client';

import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Upload, FileAudio, X, CheckCircle, AlertCircle } from 'lucide-react';
import type { StoredTranscript } from '@/lib/format';

interface AudioUploadProps {
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

const POLL_INTERVAL_MS = 3000;

// Keep in sync with `proxyClientMaxBodySize` in next.config.ts.
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4GB

export function AudioUpload({ onTranscriptCreated }: AudioUploadProps) {
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

  const updateUpload = (file: File, patch: Partial<UploadStatus>) => {
    setUploads((prev) =>
      prev.map((u) => (u.file === file ? { ...u, ...patch } : u))
    );
  };

  const pollUntilDone = async (file: File, transcriptId: string) => {
    // Poll /api/transcripts/:id until status is final. The server refreshes
    // against AssemblyAI on each GET.
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(`/api/transcripts/${transcriptId}`);
      if (!res.ok) {
        throw new Error(`Status check failed: ${res.status}`);
      }
      const { transcript } = (await res.json()) as { transcript: StoredTranscript };

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
      updateUpload(file, { progress });

      if (transcript.status === 'completed') {
        updateUpload(file, { status: 'completed', progress: 100 });
        onTranscriptCreated?.();
        return;
      }
      if (transcript.status === 'error') {
        updateUpload(file, { status: 'error', error: 'Transcription failed' });
        return;
      }
    }
  };

  // Raw-body upload via XHR: the file IS the request body (the server
  // streams it to disk — no multipart, no server-side buffering), and
  // xhr.upload.onprogress gives real progress, which matters when a
  // multi-GB file takes minutes to send.
  const uploadFile = (file: File, languageCode: string): Promise<StoredTranscript> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const qs = languageCode
        ? `?${new URLSearchParams({ language_code: languageCode })}`
        : '';
      xhr.open('POST', `/api/transcripts${qs}`);
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          // Upload owns the 0–50% band; transcription polling owns the rest.
          updateUpload(file, { progress: Math.round((e.loaded / e.total) * 50) });
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(
              (JSON.parse(xhr.responseText) as { transcript: StoredTranscript })
                .transcript
            );
          } catch {
            reject(new Error('Upload failed: invalid server response'));
          }
        } else {
          let detail: string = xhr.responseText || String(xhr.status);
          try {
            detail = (JSON.parse(xhr.responseText) as { error?: string }).error ?? detail;
          } catch {
            // keep raw text
          }
          reject(new Error(`Upload failed: ${detail}`));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(file);
    });

  const submitForTranscription = async (file: File, languageCode: string) => {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is ${formatFileSize(file.size)} — the upload limit is ${formatFileSize(MAX_FILE_BYTES)}`
      );
    }

    updateUpload(file, { status: 'uploading', progress: 0 });

    const transcript = await uploadFile(file, languageCode);

    updateUpload(file, {
      status: 'transcribing',
      progress: 50,
      transcriptId: transcript.assemblyai_id,
    });
    // Surface to the parent right away so the newly queued row shows up in
    // the list, even before it finishes transcribing.
    onTranscriptCreated?.();

    await pollUntilDone(file, transcript.assemblyai_id);
  };

  const startUpload = useCallback(
    async (files: File[], languageCode: string) => {
      for (const file of files) {
        const uploadStatus: UploadStatus = {
          file,
          status: 'uploading',
          progress: 0,
        };
        setUploads((prev) => [...prev, uploadStatus]);

        try {
          await submitForTranscription(file, languageCode);
        } catch (error) {
          updateUpload(file, {
            status: 'error',
            error: error instanceof Error ? error.message : 'Upload failed',
          });
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFilesSelected = useCallback((files: FileList) => {
    setPendingFiles(Array.from(files));
    setSelectedLanguage('');
    setIsDialogOpen(true);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFilesSelected(e.dataTransfer.files);
      }
    },
    [handleFilesSelected]
  );

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(e.target.files);
      }
      e.target.value = '';
    },
    [handleFilesSelected]
  );

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
    setUploads((prev) => prev.filter((u) => u.file !== file));
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
          <div
            className={`border-2 border-dashed rounded-lg p-4 sm:p-8 text-center transition-colors ${
              isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <Upload className="h-8 w-8 sm:h-12 sm:w-12 mx-auto text-gray-400 mb-2 sm:mb-4" />
            <p className="text-sm sm:text-lg font-medium mb-1 sm:mb-2">
              Drop files here or click to browse
            </p>
            <p className="text-xs sm:text-sm text-muted-foreground mb-3 sm:mb-4">
              Upload any audio or video file — we&apos;ll handle the rest
            </p>
            <Button onClick={handleFileSelect} variant="outline" size="sm">
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
                      <span className="text-sm text-muted-foreground">{getStatusText(upload)}</span>
                      {(upload.status === 'completed' || upload.status === 'error') && (
                        <Button variant="ghost" size="sm" onClick={() => removeUpload(upload.file)}>
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
            <Button onClick={handleConfirmUpload}>Start Transcription</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

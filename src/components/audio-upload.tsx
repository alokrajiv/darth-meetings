'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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

/** DOM id of the hidden file input — lets the page header's "Upload audio"
 * button trigger the picker without threading refs across components. */
export const AUDIO_UPLOAD_INPUT_ID = 'audio-upload-file-input';

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

  const handleFilesSelected = useCallback((files: FileList) => {
    setPendingFiles(Array.from(files));
    setSelectedLanguage('');
    setIsDialogOpen(true);
  }, []);

  // Page-wide drag & drop: the visible dropzone strip is gone (it cost a
  // full row of chrome) — instead, dragging files anywhere over the window
  // raises a fixed overlay, and dropping anywhere uploads. Depth counter
  // because dragenter/dragleave fire for every child element crossed.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setIsDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setIsDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleFilesSelected(e.dataTransfer.files);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFilesSelected]);

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
        return <CheckCircle className="h-4 w-4 text-status-ok" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      default:
        return <FileAudio className="h-4 w-4 text-primary" />;
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
      <div className={uploads.length > 0 ? 'mb-3 space-y-3' : ''}>
        <input
          id={AUDIO_UPLOAD_INPUT_ID}
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
        {isDragging && (
          <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary bg-card px-10 py-8 text-center shadow-lg">
              <Upload className="mx-auto h-6 w-6 text-primary" />
              <p className="mt-3 text-sm font-medium">Drop audio or video to upload</p>
              <p className="mt-1 text-xs text-muted-foreground">
                up to 4 GB · mp3 · m4a · mp4 · wav
              </p>
            </div>
          </div>
        )}

        {uploads.length > 0 && (
          <div className="space-y-2">
            {uploads.map((upload, index) => (
              <div
                key={`${upload.file.name}-${index}`}
                className="rounded-md border bg-card px-3 py-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {getStatusIcon(upload.status)}
                    <span className="truncate text-sm font-medium">{upload.file.name}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                      {formatFileSize(upload.file.size)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">{getStatusText(upload)}</span>
                    {(upload.status === 'completed' || upload.status === 'error') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => removeUpload(upload.file)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
                {(upload.status === 'uploading' || upload.status === 'transcribing') && (
                  <Progress value={upload.progress} className="mt-2 h-1" />
                )}
                {upload.status === 'error' && upload.error && (
                  <p className="mt-1 text-xs text-destructive">{upload.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="rounded-xl shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Upload Settings</DialogTitle>
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
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
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
            <Button variant="ghost" onClick={handleCancelUpload}>
              Cancel
            </Button>
            <Button onClick={handleConfirmUpload}>Start Transcription</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

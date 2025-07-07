'use client';

import { useState, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Upload, FileAudio, X, CheckCircle, AlertCircle } from 'lucide-react';
import { AssemblyAIClient } from '@/lib/assemblyai';
import { db } from '@/lib/db';

interface AudioUploadProps {
  apiKey: string;
  onTranscriptCreated?: () => void;
}

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportedFormats = [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/aac',
    'audio/ogg', 'audio/webm', 'video/mp4', 'video/avi', 'video/mov',
    'video/wmv', 'video/flv', 'video/webm'
  ];

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const isValidFile = (file: File): boolean => {
    return supportedFormats.some(format => 
      file.type.startsWith(format.split('/')[0]) || 
      supportedFormats.includes(file.type)
    );
  };

  const handleFiles = useCallback(async (files: FileList) => {
    const validFiles = Array.from(files).filter(isValidFile);
    
    if (validFiles.length === 0) {
      alert('Please select valid audio or video files');
      return;
    }

    for (const file of validFiles) {
      const uploadStatus: UploadStatus = {
        file,
        status: 'uploading',
        progress: 0
      };

      setUploads(prev => [...prev, uploadStatus]);
      
      try {
        await submitForTranscription(file);
      } catch (error) {
        setUploads(prev => prev.map(upload => 
          upload.file === file 
            ? { ...upload, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' }
            : upload
        ));
      }
    }
  }, [isValidFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitForTranscription = async (file: File) => {
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

      const transcript = await client.submitTranscription(audioUrl);

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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  }, [handleFiles]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFiles(files);
    }
    // Reset input value to allow selecting the same file again
    e.target.value = '';
  }, [handleFiles]);

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
            Drop audio files here or click to browse
          </p>
          <p className="text-sm text-muted-foreground mb-4">
            Supports MP3, WAV, M4A, MP4, AVI, MOV and more
          </p>
          <Button onClick={handleFileSelect} variant="outline">
            Select Files
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="audio/*,video/*"
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
  );
} 
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AssemblyAIClient, TranscriptResponse } from '@/lib/assemblyai';
import { formatDuration } from '@/lib/assemblyai';
import { db } from '@/lib/db';
import { Eye, Trash2, RefreshCw } from 'lucide-react';

interface TranscriptTableProps {
  apiKey: string;
  refreshTrigger?: number;
}

export function TranscriptTable({ apiKey, refreshTrigger }: TranscriptTableProps) {
  const router = useRouter();
  const [transcripts, setTranscripts] = useState<TranscriptResponse[]>([]);
  const [transcriptMeta, setTranscriptMeta] = useState<{[key: string]: {title?: string, description?: string}}>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTranscripts = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const client = new AssemblyAIClient(apiKey);
      const response = await client.listTranscripts(20);
      
      setTranscripts(response.transcripts);
      
      // Save to local database for history and load metadata
      const metaMap: {[key: string]: {title?: string, description?: string}} = {};
      for (const transcript of response.transcripts) {
        const createdDate = transcript.created ? new Date(transcript.created) : new Date();
        await db.saveTranscriptHistory({
          transcriptId: transcript.id,
          originalFilename: transcript.audio_url ? new URL(transcript.audio_url).pathname.split('/').pop() || 'unknown' : 'unknown',
          status: transcript.status,
          createdAt: isNaN(createdDate.getTime()) ? new Date() : createdDate,
          duration: transcript.audio_duration,
          speakerCount: transcript.utterances ? new Set(transcript.utterances.map(u => u.speaker)).size : 0,
        });
        
        // Load metadata for this transcript
        const meta = await db.getTranscriptMeta(transcript.id);
        if (meta) {
          metaMap[transcript.id] = meta;
        }
      }
      setTranscriptMeta(metaMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcripts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTranscripts();
  }, [apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      loadTranscripts();
    }
  }, [refreshTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewTranscript = (transcriptId: string) => {
    router.push(`/transcript/${transcriptId}`);
  };

  const handleDeleteTranscript = async (transcriptId: string) => {
    if (!confirm('Are you sure you want to delete this transcript?')) return;
    
    try {
      const client = new AssemblyAIClient(apiKey);
      await client.deleteTranscript(transcriptId);
      await db.deleteTranscriptData(transcriptId);
      
      // Remove from local state
      setTranscripts(prev => prev.filter(t => t.id !== transcriptId));
    } catch (err) {
      alert('Failed to delete transcript: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="default" className="bg-green-100 text-green-800">Completed</Badge>;
      case 'processing':
        return <Badge variant="secondary">Processing</Badge>;
      case 'queued':
        return <Badge variant="outline">Queued</Badge>;
      case 'error':
        return <Badge variant="destructive">Error</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Loading Transcripts...</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Error Loading Transcripts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-red-500 mb-4">{error}</p>
          <Button onClick={loadTranscripts} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (transcripts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Transcripts Found</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">
            You don&apos;t have any transcripts yet. Create one using the CLI tool or AssemblyAI API.
          </p>
          <Button onClick={loadTranscripts} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Your Transcripts</CardTitle>
          <Button onClick={loadTranscripts} variant="outline" size="sm">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title / ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Speakers</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transcripts.map((transcript) => {
              const meta = transcriptMeta[transcript.id];
              return (
                <TableRow key={transcript.id}>
                  <TableCell>
                    {meta?.title ? (
                      <div>
                        <div className="font-medium">{meta.title}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {transcript.id.substring(0, 8)}...
                        </div>
                      </div>
                    ) : (
                      <div className="font-mono text-sm">
                        {transcript.id.substring(0, 8)}...
                      </div>
                    )}
                  </TableCell>
                <TableCell>
                  {getStatusBadge(transcript.status)}
                </TableCell>
                <TableCell>
                  {(() => {
                    try {
                      const date = new Date(transcript.created);
                      if (isNaN(date.getTime())) {
                        return 'Unknown date';
                      }
                      return formatDistanceToNow(date, { addSuffix: true });
                    } catch {
                      return 'Unknown date';
                    }
                  })()}
                </TableCell>
                <TableCell>
                  {transcript.audio_duration 
                    ? formatDuration(transcript.audio_duration)
                    : 'N/A'
                  }
                </TableCell>
                <TableCell>
                  {transcript.utterances 
                    ? new Set(transcript.utterances.map(u => u.speaker)).size
                    : 'N/A'
                  }
                </TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleViewTranscript(transcript.id)}
                      disabled={transcript.status !== 'completed'}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDeleteTranscript(transcript.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
} 
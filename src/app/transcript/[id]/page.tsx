'use client';

import { useState, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { AssemblyAIClient, TranscriptResponse } from '@/lib/assemblyai';
import { formatDuration, formatTime } from '@/lib/assemblyai';
import { db } from '@/lib/db';
import { SpeakerEditor } from '@/components/speaker-editor';
import { ArrowLeft, RefreshCw, Download, Edit, Save, X } from 'lucide-react';

interface TranscriptDetailPageProps {
  params: Promise<{
    id: string;
  }>;
}

export default function TranscriptDetailPage({ params }: TranscriptDetailPageProps) {
  const router = useRouter();
  const resolvedParams = use(params);
  const [transcript, setTranscript] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string>('');
  const [speakerMappings, setSpeakerMappings] = useState<{[key: string]: string}>({});
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);

  useEffect(() => {
    // Get API key from localStorage
    const storedApiKey = localStorage.getItem('assemblyai_api_key');
    if (!storedApiKey) {
      router.push('/');
      return;
    }
    setApiKey(storedApiKey);
  }, [router]);

  const loadTranscript = async () => {
    if (!apiKey) return;
    
    try {
      setLoading(true);
      setError(null);
      
      const client = new AssemblyAIClient(apiKey);
      const response = await client.getTranscript(resolvedParams.id);
      
      setTranscript(response);
      
      // Debug: Log the date format from AssemblyAI
      console.log('Raw transcript.created:', response.created, 'Type:', typeof response.created);
      
      // Load speaker mappings from database
      const mappings = await db.getSpeakerMappings(resolvedParams.id);
      if (mappings) {
        const speakerMap: {[key: string]: string} = {};
        mappings.speakerLabels.forEach(mapping => {
          if (mapping.customName && !mapping.isSkipped) {
            speakerMap[mapping.originalSpeaker] = mapping.customName;
          } else if (mapping.isSkipped) {
            speakerMap[mapping.originalSpeaker] = `${mapping.originalSpeaker} (Skipped)`;
          } else {
            speakerMap[mapping.originalSpeaker] = mapping.originalSpeaker;
          }
        });
        setSpeakerMappings(speakerMap);
      }
      
      // Load title and description from database
      const meta = await db.getTranscriptMeta(resolvedParams.id);
      if (meta) {
        setTitle(meta.title || '');
        setDescription(meta.description || '');
      }
      
      // Update last accessed time
      await db.updateLastAccessed(resolvedParams.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load transcript');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (apiKey) {
      loadTranscript();
    }
  }, [apiKey, resolvedParams.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownloadMarkdown = () => {
    if (!transcript) return;
    
    const markdown = generateMarkdown(transcript);
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${resolvedParams.id}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const safeFormatDate = (dateString: string | Date): string => {
    try {
      let date: Date;
      if (typeof dateString === 'string') {
        // AssemblyAI returns ISO string format
        date = new Date(dateString);
      } else {
        date = dateString;
      }
      
      if (isNaN(date.getTime())) {
        return 'Unknown date';
      }
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return 'Unknown date';
    }
  };

  const formatFullDate = (dateString: string | Date): string => {
    try {
      let date: Date;
      if (typeof dateString === 'string') {
        date = new Date(dateString);
      } else {
        date = dateString;
      }
      
      if (isNaN(date.getTime())) {
        return 'Unknown date';
      }
      
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return 'Unknown date';
    }
  };

  const getSpeakerDisplayName = (originalSpeaker: string): string => {
    return speakerMappings[originalSpeaker] || originalSpeaker;
  };

  const handleSaveMeta = async () => {
    try {
      setSavingMeta(true);
      await db.updateTranscriptMeta(resolvedParams.id, title, description);
      setIsEditingMeta(false);
    } catch (error) {
      console.error('Error saving metadata:', error);
      alert('Failed to save title and description. Please try again.');
    } finally {
      setSavingMeta(false);
    }
  };

  const handleCancelEditMeta = () => {
    // Reset to original values
    loadTranscript();
    setIsEditingMeta(false);
  };

  const generateMarkdown = (transcript: TranscriptResponse): string => {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0]?.substring(0, 5) || '00:00';
    
    let markdown = `# ${title || 'Meeting Transcript'}\n\n`;
    if (description) {
      markdown += `${description}\n\n`;
    }
    markdown += `*Transcript ID: ${transcript.id}*\n`;
    markdown += `*Duration: ${transcript.audio_duration ? formatDuration(transcript.audio_duration) : 'N/A'}*\n`;
    markdown += `*Created: ${formatFullDate(transcript.created)}*\n`;
    markdown += `*Downloaded: ${dateStr} at ${timeStr}*\n\n`;

    if (transcript.utterances && transcript.utterances.length > 0) {
      markdown += `## Speakers\n`;
      const speakers = new Set(transcript.utterances.map(u => u.speaker));
      speakers.forEach(speaker => {
        const displayName = getSpeakerDisplayName(speaker);
        if (displayName !== speaker) {
          markdown += `- **${displayName}** (${speaker})\n`;
        } else {
          markdown += `- **${speaker}**\n`;
        }
      });
      
      markdown += `\n## Transcript\n\n`;
      
      transcript.utterances.forEach(utterance => {
        const timeStr = formatTime(utterance.start); // AssemblyAI returns seconds
        const speakerName = getSpeakerDisplayName(utterance.speaker);
        markdown += `[${timeStr}] **${speakerName}**: ${utterance.text}\n\n`;
      });
    } else if (transcript.text) {
      markdown += `## Transcript\n\n`;
      markdown += `${transcript.text}\n\n`;
    }

    return markdown;
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
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Loading Transcript...</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Error Loading Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-500 mb-4">{error}</p>
            <div className="flex gap-2">
              <Button onClick={loadTranscript} variant="outline">
                <RefreshCw className="h-4 w-4 mr-2" />
                Retry
              </Button>
              <Button onClick={() => router.push('/')} variant="outline">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to List
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!transcript) {
    return (
      <div className="container mx-auto px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Transcript Not Found</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              The transcript you&apos;re looking for doesn&apos;t exist or couldn&apos;t be loaded.
            </p>
            <Button onClick={() => router.push('/')} variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to List
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <Button
            variant="outline"
            onClick={() => router.push('/')}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Transcripts
          </Button>
          <h1 className="text-3xl font-bold">Transcript Details</h1>
          <p className="text-muted-foreground">
            ID: {transcript.id}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleDownloadMarkdown} variant="outline">
            <Download className="h-4 w-4 mr-2" />
            Download Markdown
          </Button>
          <Button onClick={loadTranscript} variant="outline">
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6">
        {/* Title and Description */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Title & Description</CardTitle>
              {!isEditingMeta ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsEditingMeta(true)}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancelEditMeta}
                    disabled={savingMeta}
                  >
                    <X className="h-4 w-4 mr-2" />
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveMeta}
                    disabled={savingMeta}
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {savingMeta ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isEditingMeta ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    placeholder="Enter a title for this transcript"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    placeholder="Enter a description (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {title ? (
                  <div>
                    <p className="text-sm text-muted-foreground">Title</p>
                    <h3 className="text-lg font-medium">{title}</h3>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">No title set</p>
                )}
                {description && (
                  <div>
                    <p className="text-sm text-muted-foreground">Description</p>
                    <p className="text-sm">{description}</p>
                  </div>
                )}
                {!title && !description && (
                  <p className="text-muted-foreground text-sm">
                    Click Edit to add a title and description for this transcript.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Transcript Info */}
        <Card>
          <CardHeader>
            <CardTitle>Transcript Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <div className="mt-1">{getStatusBadge(transcript.status)}</div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Created</p>
                <p className="mt-1">{safeFormatDate(transcript.created)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Duration</p>
                <p className="mt-1">{transcript.audio_duration ? formatDuration(transcript.audio_duration) : 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Speakers</p>
                <p className="mt-1">
                  {transcript.utterances 
                    ? new Set(transcript.utterances.map(u => u.speaker)).size
                    : 'N/A'
                  }
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Speaker Editor */}
        {transcript.utterances && transcript.utterances.length > 0 && (
          <SpeakerEditor
            transcriptId={transcript.id}
            utterances={transcript.utterances}
            onMappingsUpdate={async () => {
              // Only refresh speaker mappings, not the entire transcript
              const mappings = await db.getSpeakerMappings(resolvedParams.id);
              if (mappings) {
                const speakerMap: {[key: string]: string} = {};
                mappings.speakerLabels.forEach(mapping => {
                  if (mapping.customName && !mapping.isSkipped) {
                    speakerMap[mapping.originalSpeaker] = mapping.customName;
                  } else if (mapping.isSkipped) {
                    speakerMap[mapping.originalSpeaker] = `${mapping.originalSpeaker} (Skipped)`;
                  } else {
                    speakerMap[mapping.originalSpeaker] = mapping.originalSpeaker;
                  }
                });
                setSpeakerMappings(speakerMap);
              }
            }}
          />
        )}

        {/* Transcript Content */}
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
          </CardHeader>
          <CardContent>
            {transcript.status === 'completed' ? (
              <div className="space-y-4">
                                 {transcript.utterances && transcript.utterances.length > 0 ? (
                   transcript.utterances.map((utterance, index) => (
                     <div key={index} className="border-l-4 border-blue-200 pl-4 py-2">
                       <div className="flex items-center gap-2 mb-1">
                         <Badge variant="outline">{getSpeakerDisplayName(utterance.speaker)}</Badge>
                         {getSpeakerDisplayName(utterance.speaker) !== utterance.speaker && (
                           <span className="text-xs text-muted-foreground">({utterance.speaker})</span>
                         )}
                         <span className="text-sm text-muted-foreground">
                           {formatTime(utterance.start)}
                         </span>
                       </div>
                       <p className="text-sm">{utterance.text}</p>
                     </div>
                   ))
                ) : (
                  <p className="text-muted-foreground">
                    {transcript.text || 'No transcript content available'}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Transcript is {transcript.status}. Content will be available when processing is complete.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
} 
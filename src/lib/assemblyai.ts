import { AssemblyAI } from 'assemblyai';

export interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  audio_url?: string;
  created: string;
  completed?: string;
  audio_duration?: number;
  utterances?: Array<{
    text: string;
    start: number;
    end: number;
    speaker: string;
  }>;
  error?: string;
  audio_start_from?: number;
  audio_end_at?: number;
  language_code?: string;
  confidence?: number;
  words?: Array<{
    text: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: string;
  }>;
}

export interface TranscriptListResponse {
  transcripts: TranscriptResponse[];
  page_details: {
    limit: number;
    result_count: number;
    current_url: string;
    prev_url?: string;
    next_url?: string;
  };
}

export class AssemblyAIClient {
  private client: AssemblyAI;

  constructor(apiKey: string) {
    this.client = new AssemblyAI({ apiKey });
  }

  async uploadFile(buffer: Buffer): Promise<string> {
    return await this.client.files.upload(buffer);
  }

  async submitTranscription(audioUrl: string): Promise<{ id: string; status: string }> {
    const params = {
      audio: audioUrl,
      speaker_labels: true,
    };
    const transcript = await this.client.transcripts.submit(params);
    return { id: transcript.id, status: transcript.status };
  }

  async listTranscripts(limit: number = 10, beforeId?: string): Promise<TranscriptListResponse> {
    const options: { limit: number; before_id?: string } = { limit };
    if (beforeId) {
      options.before_id = beforeId;
    }
    
    const response = await this.client.transcripts.list(options);
    return response as unknown as TranscriptListResponse;
  }

  async getTranscript(id: string): Promise<TranscriptResponse> {
    const response = await this.client.transcripts.get(id);
    return response as unknown as TranscriptResponse;
  }

  async deleteTranscript(id: string): Promise<void> {
    await this.client.transcripts.delete(id);
  }

  static validateApiKey(apiKey: string): boolean {
    return Boolean(apiKey && apiKey.length > 0);
  }
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  } else if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
}

export function formatTime(seconds: number): string {
  // AssemblyAI returns time in seconds, not milliseconds
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
} 
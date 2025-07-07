import Dexie, { type EntityTable } from 'dexie';

export interface SpeakerMapping {
  id?: number;
  transcriptId: string;
  speakerLabels: {
    originalSpeaker: string;
    customName: string;
    isSkipped: boolean;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TranscriptHistory {
  id?: number;
  transcriptId: string;
  originalFilename: string;
  status: string;
  createdAt: Date;
  duration?: number;
  speakerCount?: number;
  lastAccessed: Date;
  title?: string;
  description?: string;
}

export class MeetingWhispererDB extends Dexie {
  speakerMappings!: EntityTable<SpeakerMapping, 'id'>;
  transcriptHistory!: EntityTable<TranscriptHistory, 'id'>;

  constructor() {
    super('MeetingWhispererDB');
    this.version(1).stores({
      speakerMappings: '++id, transcriptId, createdAt, updatedAt',
      transcriptHistory: '++id, transcriptId, originalFilename, status, createdAt, lastAccessed'
    });
  }

  async getSpeakerMappings(transcriptId: string): Promise<SpeakerMapping | undefined> {
    return await this.speakerMappings.where('transcriptId').equals(transcriptId).first();
  }

  async saveSpeakerMappings(transcriptId: string, speakerLabels: SpeakerMapping['speakerLabels']): Promise<void> {
    const now = new Date();
    const existing = await this.getSpeakerMappings(transcriptId);
    
    if (existing) {
      await this.speakerMappings.update(existing.id!, {
        speakerLabels,
        updatedAt: now
      });
    } else {
      await this.speakerMappings.add({
        transcriptId,
        speakerLabels,
        createdAt: now,
        updatedAt: now
      });
    }
  }

  async saveTranscriptHistory(transcript: Omit<TranscriptHistory, 'id' | 'lastAccessed'>): Promise<void> {
    const now = new Date();
    const existing = await this.transcriptHistory.where('transcriptId').equals(transcript.transcriptId).first();
    
    if (existing) {
      await this.transcriptHistory.update(existing.id!, {
        ...transcript,
        lastAccessed: now
      });
    } else {
      await this.transcriptHistory.add({
        ...transcript,
        lastAccessed: now
      });
    }
  }

  async getTranscriptHistory(): Promise<TranscriptHistory[]> {
    return await this.transcriptHistory.orderBy('lastAccessed').reverse().toArray();
  }

  async updateLastAccessed(transcriptId: string): Promise<void> {
    const existing = await this.transcriptHistory.where('transcriptId').equals(transcriptId).first();
    if (existing) {
      await this.transcriptHistory.update(existing.id!, {
        lastAccessed: new Date()
      });
    }
  }

  async deleteTranscriptData(transcriptId: string): Promise<void> {
    await this.speakerMappings.where('transcriptId').equals(transcriptId).delete();
    await this.transcriptHistory.where('transcriptId').equals(transcriptId).delete();
  }

  async updateTranscriptMeta(transcriptId: string, title: string, description: string): Promise<void> {
    const existing = await this.transcriptHistory.where('transcriptId').equals(transcriptId).first();
    if (existing) {
      await this.transcriptHistory.update(existing.id!, {
        title,
        description,
        lastAccessed: new Date()
      });
    }
  }

  async getTranscriptMeta(transcriptId: string): Promise<{title?: string, description?: string} | null> {
    const existing = await this.transcriptHistory.where('transcriptId').equals(transcriptId).first();
    return existing ? { title: existing.title, description: existing.description } : null;
  }
}

export const db = new MeetingWhispererDB(); 
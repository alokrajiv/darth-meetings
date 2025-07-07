#!/usr/bin/env node

import { AssemblyAI } from 'assemblyai';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

// Types
interface Segment {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

interface SpeakerMappings {
  [key: string]: string | null;
}

type DraftStage = 'submitted' | 'waiting' | 'got_transcript' | 'user_finished_labelling';

interface Draft {
  inputFile: string;
  stage: DraftStage;
  jobId?: string;
  transcript?: {
    segments: Segment[];
    speakers: string[];
  };
  speakerMappings: SpeakerMappings;
  completedSpeakers: Set<string>; // Track which speakers have been processed (identified or permanently skipped)
}

interface Config {
  assemblyai_key?: string;
}

// Constants
const CONFIG_DIR = path.join(os.homedir(), '.assembly-whisperer');
const CONFIG_FILE = path.join(CONFIG_DIR, 'keys.json');
const TMP_DIR = path.join(CONFIG_DIR, 'tmp');
const DRAFT_FILE = path.join(TMP_DIR, 'draft.json');

export class AssemblyWhisperer {
  private client: AssemblyAI | null = null;
  private spinner = ora();
  private isInterrupted = false;

  constructor() {
    // Handle Ctrl+C gracefully
    process.on('SIGINT', this.handleInterrupt.bind(this));
    process.on('SIGTERM', this.handleInterrupt.bind(this));
  }

  private async handleInterrupt() {
    if (this.isInterrupted) {
      // Force exit if already interrupted once
      console.log(chalk.red('\n🛑 Force closing...'));
      process.exit(1);
    }

    this.isInterrupted = true;
    this.spinner.stop();
    console.log(chalk.yellow('\n⏸️  Gracefully stopping... (Press Ctrl+C again to force quit)'));
    console.log(chalk.blue('💾 Your progress has been saved. Run the same command to resume.'));
    
    // Give a moment for any pending saves
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }

  async run(inputFile?: string) {
    try {
      if (!inputFile) {
        inputFile = process.argv[2];
        if (!inputFile) {
          console.error(chalk.red('Error: Please provide an audio file path'));
          console.log(chalk.yellow('Usage: npx tsx assembly-whisperer.ts /path/to/audio.mp4'));
          process.exit(1);
        }
      }

      // Check if file exists
      if (!fsSync.existsSync(inputFile)) {
        console.error(chalk.red('Error: Audio file does not exist'));
        process.exit(1);
      }

      // Setup configuration
      await this.setupConfig();
      
      // Check for existing draft
      const shouldResume = await this.checkForDraft(inputFile);
      let draft: Draft;

      if (shouldResume) {
        draft = await this.loadDraft();
        console.log(chalk.green('Resuming from previous session...'));
        
        // Handle different resume scenarios
        if (draft.stage === 'submitted' || draft.stage === 'waiting') {
          console.log(chalk.blue('Checking transcription status...'));
          draft = await this.waitForTranscription(draft);
        }
      } else {
        // Delete any existing draft
        await this.deleteDraft();
        
        // Process new transcription
        draft = await this.processTranscription(inputFile);
      }

      // Interactive speaker identification
      if (draft.stage === 'got_transcript') {
        await this.identifySpeakers(draft);
      }

      // Generate markdown
      await this.generateMarkdown(draft);

      // Cleanup
      await this.deleteDraft();

      console.log(chalk.green('✅ Transcript saved to:'), this.getOutputPath(draft.inputFile));

    } catch (error) {
      this.spinner.stop();
      if (error instanceof Error) {
        console.error(chalk.red('Error:'), error.message);
      } else {
        console.error(chalk.red('An unexpected error occurred'));
      }
      process.exit(1);
    }
  }

  private async setupConfig(): Promise<void> {
    // Ensure directories exist
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(TMP_DIR, { recursive: true });

    let config: Config = {};

    // Try to load existing config
    if (fsSync.existsSync(CONFIG_FILE)) {
      try {
        const configData = await fs.readFile(CONFIG_FILE, 'utf-8');
        config = JSON.parse(configData);
      } catch (error) {
        console.log(chalk.yellow('Warning: Could not parse existing config file'));
      }
    }

    // Check if API key exists
    if (!config.assemblyai_key) {
      console.log(chalk.yellow('AssemblyAI API key not found.'));
      const { apiKey } = await inquirer.prompt([
        {
          type: 'password',
          name: 'apiKey',
          message: 'Please enter your AssemblyAI API key:',
          mask: '*'
        }
      ]);

      // Validate API key
      await this.validateApiKey(apiKey);
      
      config.assemblyai_key = apiKey;
      await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
      console.log(chalk.green('✅ API key saved successfully'));
    }

    this.client = new AssemblyAI({ apiKey: config.assemblyai_key! });
  }

  private async validateApiKey(apiKey: string): Promise<void> {
    this.spinner.start('Validating API key...');
    try {
      const testClient = new AssemblyAI({ apiKey });
      // Make a simple API call to validate
      await testClient.transcripts.list({ limit: 1 });
      this.spinner.stop();
    } catch (error) {
      this.spinner.stop();
      throw new Error('Invalid AssemblyAI API key');
    }
  }

  private async checkForDraft(inputFile: string): Promise<boolean> {
    if (!fsSync.existsSync(DRAFT_FILE)) {
      return false;
    }

    try {
      const draftData = await fs.readFile(DRAFT_FILE, 'utf-8');
      const draft: Draft = JSON.parse(draftData);
      
      if (path.resolve(draft.inputFile) === path.resolve(inputFile)) {
        const { resume } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'resume',
            message: 'Resume previous session?',
            default: true
          }
        ]);
        return resume;
      }
    } catch (error) {
      console.log(chalk.yellow('Warning: Could not parse existing draft file'));
    }

    return false;
  }

  private async loadDraft(): Promise<Draft> {
    const draftData = await fs.readFile(DRAFT_FILE, 'utf-8');
    const draft = JSON.parse(draftData);
    
    // Convert completedSpeakers back to Set (it's saved as array in JSON)
    if (draft.completedSpeakers) {
      draft.completedSpeakers = new Set(draft.completedSpeakers);
    } else {
      draft.completedSpeakers = new Set<string>();
    }
    
    return draft;
  }

  private async saveDraft(draft: Draft): Promise<void> {
    // Convert Set to Array for JSON serialization
    const draftForSave = {
      ...draft,
      completedSpeakers: Array.from(draft.completedSpeakers)
    };
    await fs.writeFile(DRAFT_FILE, JSON.stringify(draftForSave, null, 2));
  }

  private async deleteDraft(): Promise<void> {
    if (fsSync.existsSync(DRAFT_FILE)) {
      await fs.unlink(DRAFT_FILE);
    }
  }

  private async processTranscription(inputFile: string): Promise<Draft> {
    if (!this.client) throw new Error('AssemblyAI client not initialized');

    // Check if we have a submitted job that's still processing
    const existingDraft = await this.loadDraftIfExists();
    if (existingDraft && existingDraft.stage === 'submitted' && existingDraft.jobId) {
      console.log(chalk.blue('Found existing transcription job, checking status...'));
      return await this.waitForTranscription(existingDraft);
    }

    this.spinner.start('Submitting transcription job...');
    
    try {
      const params = {
        audio: inputFile,
        speaker_labels: true
      };

      // Submit the job (non-blocking)
      const job = await this.interruptibleOperation(
        () => this.client!.transcripts.submit(params),
        'Submitting job...'
      );
      
      if (this.isInterrupted) return this.createInterruptedDraft(inputFile);
      
      console.log(chalk.green(`✅ Job submitted with ID: ${job.id}`));
      
      // Create initial draft
      const draft: Draft = {
        inputFile,
        stage: 'submitted',
        jobId: job.id,
        speakerMappings: {},
        completedSpeakers: new Set<string>()
      };

      await this.saveDraft(draft);
      this.spinner.stop();

      // Now wait for completion
      return await this.waitForTranscription(draft);

    } catch (error) {
      this.spinner.stop();
      if (error instanceof Error) {
        if (error.message.includes('network') || error.message.includes('fetch')) {
          throw new Error('Failed to connect to AssemblyAI');
        }
        throw error;
      }
      throw new Error('Failed to submit transcription job');
    }
  }

  private async waitForTranscription(draft: Draft): Promise<Draft> {
    if (!this.client || !draft.jobId) {
      throw new Error('Missing client or job ID');
    }

    draft.stage = 'waiting';
    await this.saveDraft(draft);

    this.spinner.start('Waiting for transcription to complete...');
    
    try {
      // Custom polling with interruption checks
      let transcript = await this.client.transcripts.get(draft.jobId);
      
      while (transcript.status !== 'completed' && transcript.status !== 'error' && !this.isInterrupted) {
        await this.sleep(3000); // Wait 3 seconds
        
        if (this.isInterrupted) {
          console.log(chalk.blue('\n💾 Transcription will continue in background. Resume later with the same command.'));
          return draft;
        }
        
        this.spinner.text = `Waiting for transcription... Status: ${transcript.status}`;
        transcript = await this.client.transcripts.get(draft.jobId);
      }

      if (this.isInterrupted) return draft;

      if (transcript.status === 'error') {
        const errorMessage = transcript.error || 'Unknown error';
        throw new Error(`Transcription failed: ${errorMessage}`);
      }

      this.spinner.stop();

      // Process segments
      const segments: Segment[] = [];
      const speakers = new Set<string>();

      if (transcript.utterances) {
        for (const utterance of transcript.utterances) {
          segments.push({
            text: utterance.text,
            start: utterance.start,
            end: utterance.end,
            speaker: utterance.speaker || 'Unknown'
          });
          speakers.add(utterance.speaker || 'Unknown');
        }
      }

      const speakerArray = Array.from(speakers).sort();
      const speakerMappings: SpeakerMappings = {};
      speakerArray.forEach(speaker => {
        speakerMappings[speaker] = null;
      });

      const duration = Math.round(transcript.audio_duration || 0);
      console.log(chalk.green(`✅ Found ${speakerArray.length} speakers in ${this.formatDuration(duration * 1000)} of audio`));

      // Update draft with transcript data
      draft.stage = 'got_transcript';
      draft.transcript = {
        segments,
        speakers: speakerArray
      };
      draft.speakerMappings = speakerMappings;

      await this.saveDraft(draft);
      return draft;

    } catch (error) {
      this.spinner.stop();
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to complete transcription');
    }
  }

  private async loadDraftIfExists(): Promise<Draft | null> {
    if (!fsSync.existsSync(DRAFT_FILE)) {
      return null;
    }

    try {
      const draftData = await fs.readFile(DRAFT_FILE, 'utf-8');
      const draft = JSON.parse(draftData);
      // Convert completedSpeakers back to Set
      if (draft.completedSpeakers) {
        draft.completedSpeakers = new Set(draft.completedSpeakers);
      }
      return draft;
    } catch (error) {
      return null;
    }
  }

  private async identifySpeakers(draft: Draft): Promise<void> {
    if (!draft.transcript) {
      throw new Error('No transcript data available');
    }

    const allSpeakers = draft.transcript.speakers;
    let currentRound = 0;
    const maxRounds = 3; // Prevent infinite cycling

    while (draft.completedSpeakers.size < allSpeakers.length && currentRound < maxRounds) {
      currentRound++;
      console.log(chalk.blue(`\n=== Round ${currentRound} of Speaker Identification ===`));
      
      const remainingSpeakers = allSpeakers.filter(speaker => !draft.completedSpeakers.has(speaker));
      
      if (remainingSpeakers.length === 0) break;

      console.log(chalk.yellow(`Remaining speakers: ${remainingSpeakers.join(', ')}`));
      
      for (const speaker of remainingSpeakers) {
        console.log(chalk.blue(`\nIdentifying ${speaker}`));
        
        if (draft.completedSpeakers.size > 0) {
          console.log(chalk.gray('Already completed:'));
          allSpeakers.forEach(spk => {
            if (draft.completedSpeakers.has(spk)) {
              const name = draft.speakerMappings[spk];
              if (name) {
                console.log(chalk.gray(`  ${spk} → ${name}`));
              } else {
                console.log(chalk.gray(`  ${spk} → (skipped)`));
              }
            }
          });
        }

        const action = await this.identifySingleSpeaker(draft, speaker);
        if (action === 'identify' || action === 'skip') {
          draft.completedSpeakers.add(speaker);
        }
        // If action is 'skip_for_now', we don't add to completedSpeakers
        
        await this.saveDraft(draft);
      }
    }

    // Final check - ask about any remaining unidentified speakers
    const unidentified = allSpeakers.filter(speaker => 
      !draft.completedSpeakers.has(speaker) || !draft.speakerMappings[speaker]
    );
    
    if (unidentified.length > 0) {
      console.log(chalk.yellow(`\nStill have ${unidentified.length} unidentified speakers: ${unidentified.join(', ')}`));
      console.log(chalk.gray('These will appear as generic speaker names in the transcript.'));
    }

    draft.stage = 'user_finished_labelling';
    await this.saveDraft(draft);
  }

  private async identifySingleSpeaker(draft: Draft, speaker: string): Promise<'identify' | 'skip' | 'skip_for_now'> {
    if (!draft.transcript) {
      throw new Error('No transcript data available');
    }

    const speakerSegments = draft.transcript.segments
      .filter(seg => seg.speaker === speaker)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start)); // Sort by length, longest first

    let exampleOffset = 0;
    const examplesPerPage = 3;

    while (true) {
      // Show examples
      const examples = speakerSegments.slice(exampleOffset, exampleOffset + examplesPerPage);
      
      if (examples.length === 0) {
        console.log(chalk.yellow('No more examples available.'));
        exampleOffset = 0; // Reset to beginning
        continue;
      }

      console.log(); // Empty line
      examples.forEach((segment, idx) => {
        console.log(chalk.cyan(`Example ${exampleOffset + idx + 1} of ${speakerSegments.length}:\n`));
        
        const context = this.getContextForSegment(draft, segment);
        context.forEach(line => console.log(line));
        console.log(); // Empty line
      });

      const choices = [
        { name: '👤 Identify this speaker', value: 'identify' },
        { name: '🔄 Show more examples', value: 'more' },
        { name: '⏸️  Skip for now (try again later)', value: 'skip_for_now' },
        { name: '⏭️  Skip this speaker (permanently)', value: 'skip' }
      ];

      const { action } = await inquirer.prompt({
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices
      });

      if (action === 'more') {
        exampleOffset += examplesPerPage;
        if (exampleOffset >= speakerSegments.length) {
          exampleOffset = 0; // Wrap around
        }
      } else if (action === 'skip') {
        console.log(chalk.yellow(`⏭️  Permanently skipped ${speaker}`));
        return 'skip';
      } else if (action === 'skip_for_now') {
        console.log(chalk.blue(`⏸️  Will try ${speaker} again later`));
        return 'skip_for_now';
      } else if (action === 'identify') {
        const { name } = await inquirer.prompt({
          type: 'input',
          name: 'name',
          message: `Enter the name for ${speaker}:`,
          validate: (input: string) => {
            if (input.trim().length === 0) {
              return 'Please enter a valid name';
            }
            return true;
          }
        });

        draft.speakerMappings[speaker] = name.trim();
        console.log(chalk.green(`✅ ${speaker} identified as: ${name.trim()}`));
        return 'identify';
      }
    }
  }

  private getContextForSegment(draft: Draft, targetSegment: Segment): string[] {
    if (!draft.transcript) {
      return [`→ [${targetSegment.speaker}]: "${targetSegment.text}" ← IDENTIFY THIS`];
    }

    const allSegments = draft.transcript.segments.sort((a, b) => a.start - b.start);
    const targetIndex = allSegments.findIndex(seg => 
      seg.start === targetSegment.start && seg.speaker === targetSegment.speaker
    );

    const lines: string[] = [];

    // Previous speaker
    if (targetIndex > 0) {
      const prevSegment = allSegments[targetIndex - 1];
      if (prevSegment) {
        const prevSpeaker = this.getSpeakerDisplayName(draft, prevSegment.speaker);
        lines.push(chalk.gray(`[${prevSpeaker}]: "${prevSegment.text}"`));
      }
    }

    // Current speaker (highlighted)
    const currentSpeaker = this.getSpeakerDisplayName(draft, targetSegment.speaker);
    lines.push(chalk.yellow(`→ [${currentSpeaker}]: "${targetSegment.text}"`) + chalk.red(' ← IDENTIFY THIS'));

    // Next speaker
    if (targetIndex < allSegments.length - 1) {
      const nextSegment = allSegments[targetIndex + 1];
      if (nextSegment) {
        const nextSpeaker = this.getSpeakerDisplayName(draft, nextSegment.speaker);
        lines.push(chalk.gray(`[${nextSpeaker}]: "${nextSegment.text}"`));
      }
    }

    return lines;
  }

  private getSpeakerDisplayName(draft: Draft, speaker: string): string {
    return draft.speakerMappings[speaker] || speaker;
  }

  private async generateMarkdown(draft: Draft): Promise<void> {
    if (!draft.transcript) {
      throw new Error('No transcript data available');
    }

    this.spinner.start('Generating transcript...');

    try {
      const outputPath = this.getOutputPath(draft.inputFile);
      const fileName = path.basename(draft.inputFile);
      
      // Calculate duration
      const segments = draft.transcript.segments || [];
      const totalDuration = segments.length > 0 
        ? Math.max(...segments.map(s => s.end))
        : 0;
      const durationStr = this.formatDuration(totalDuration);
      
      // Get current date
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = now.toTimeString().split(' ')[0]?.substring(0, 5) || '00:00';

      let markdown = `# Meeting Transcript\n\n`;
      markdown += `*File: ${fileName}*\n`;
      markdown += `*Duration: ${durationStr}*\n`;
      markdown += `*Processed: ${dateStr} at ${timeStr}*\n\n`;

      // Speakers section
      markdown += `## Speakers\n`;
      draft.transcript.speakers.forEach(speaker => {
        const name = draft.speakerMappings[speaker];
        if (name) {
          markdown += `- **${name}**\n`;
        } else {
          markdown += `- **${speaker}** (unidentified)\n`;
        }
      });

      markdown += `\n## Transcript\n\n`;

      // Sort segments by start time
      const sortedSegments = [...draft.transcript.segments].sort((a, b) => a.start - b.start);
      
      sortedSegments.forEach(segment => {
        const timeStr = this.formatTime(segment.start);
        const speakerName = this.getSpeakerDisplayName(draft, segment.speaker);
        markdown += `[${timeStr}] **${speakerName}**: ${segment.text}\n\n`;
      });

      await fs.writeFile(outputPath, markdown);
      this.spinner.stop();

    } catch (error) {
      this.spinner.stop();
      throw new Error('Failed to generate markdown file');
    }
  }

  private getOutputPath(inputFile: string): string {
    const dir = path.dirname(inputFile);
    const name = path.basename(inputFile, path.extname(inputFile));
    return path.join(dir, `${name}-transcript.md`);
  }

  private formatTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    
    if (minutes === 1) {
      return '1 minute';
    } else {
      return `${minutes} minutes`;
    }
  }

  private async interruptibleOperation<T>(operation: () => Promise<T>, description: string): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.isInterrupted) {
        reject(new Error('Operation interrupted'));
        return;
      }

      const timeoutId = setTimeout(() => {
        if (this.isInterrupted) {
          reject(new Error('Operation interrupted'));
        }
      }, 100);

      operation()
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private createInterruptedDraft(inputFile: string): Draft {
    return {
      inputFile,
      stage: 'submitted',
      speakerMappings: {},
      completedSpeakers: new Set<string>()
    };
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, ms);
      
      // Check for interruption every 100ms
      const checkInterval = setInterval(() => {
        if (this.isInterrupted) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
      }, ms);
    });
  }
}

// Run the CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const whisperer = new AssemblyWhisperer();
  whisperer.run();
} 
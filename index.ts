#!/usr/bin/env node

import { Command } from 'commander';
import { AssemblyWhisperer } from './assembly-whisperer.js';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.assembly-whisperer');
const CONFIG_FILE = path.join(CONFIG_DIR, 'keys.json');

const program = new Command();

program
  .name('meeting-whisperer')
  .description('CLI tool that transcribes audio/video files using AssemblyAI\'s API and outputs formatted markdown transcripts')
  .version('1.0.0');

program
  .command('transcribe')
  .description('Transcribe an audio or video file')
  .argument('<file>', 'path to the audio/video file to transcribe')
  .action(async (file: string) => {
    try {
      // Check if file exists
      if (!fsSync.existsSync(file)) {
        console.error(chalk.red('Error: Audio file does not exist'));
        process.exit(1);
      }

      const whisperer = new AssemblyWhisperer();
      await whisperer.run(file);
    } catch (error) {
      if (error instanceof Error) {
        console.error(chalk.red('Error:'), error.message);
      } else {
        console.error(chalk.red('An unexpected error occurred'));
      }
      process.exit(1);
    }
  });

program
  .command('remove-api-key')
  .description('Remove the stored AssemblyAI API key')
  .action(async () => {
    try {
      if (fsSync.existsSync(CONFIG_FILE)) {
        await fs.unlink(CONFIG_FILE);
        console.log(chalk.green('✅ API key removed successfully'));
        console.log(chalk.blue('You will be prompted for a new API key on next use'));
      } else {
        console.log(chalk.yellow('No API key found to remove'));
      }
    } catch (error) {
      console.error(chalk.red('Error removing API key:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
  });

program.parse(); 
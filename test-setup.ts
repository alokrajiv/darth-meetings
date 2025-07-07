#!/usr/bin/env node

// Simple test to verify Assembly Whisperer setup
import { execSync } from 'child_process';
import * as fs from 'fs';
import chalk from 'chalk';

console.log(chalk.blue('🧪 Assembly Whisperer Setup Test\n'));

// Check if main file exists
if (!fs.existsSync('assembly-whisperer.ts')) {
  console.log(chalk.red('❌ assembly-whisperer.ts not found'));
  process.exit(1);
}

console.log(chalk.green('✅ assembly-whisperer.ts found'));

// Check dependencies
try {
  console.log(chalk.yellow('📦 Checking dependencies...'));
  
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const requiredDeps = ['assemblyai', 'inquirer', 'chalk', 'ora'];
  
  const missingDeps = requiredDeps.filter(dep => !packageJson.dependencies[dep]);
  
  if (missingDeps.length > 0) {
    console.log(chalk.red('❌ Missing dependencies:'), missingDeps.join(', '));
    console.log(chalk.yellow('Run: npm install'));
    process.exit(1);
  }
  
  console.log(chalk.green('✅ All required dependencies found'));
  
} catch (error) {
  console.log(chalk.red('❌ Error checking dependencies:', error));
  process.exit(1);
}

console.log(chalk.blue('\n🚀 Ready to use Assembly Whisperer!'));
console.log(chalk.yellow('Usage examples:'));
console.log(chalk.gray('  npm run transcribe /path/to/audio.mp4'));
console.log(chalk.gray('  npx tsx assembly-whisperer.ts /path/to/video.mp3'));

console.log(chalk.blue('\n📝 Next steps:'));
console.log(chalk.gray('1. Get your AssemblyAI API key from https://www.assemblyai.com/'));
console.log(chalk.gray('2. Run the tool with an audio/video file'));
console.log(chalk.gray('3. Follow the interactive prompts'));

console.log(chalk.green('\n✨ Setup verification complete!')); 
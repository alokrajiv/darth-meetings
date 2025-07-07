# Meeting Whisperer

A powerful CLI tool that transcribes audio and video files using AssemblyAI's API and outputs beautifully formatted markdown transcripts with speaker identification.

## Features

- 🎯 **Speaker Diarization**: Automatically detects and separates different speakers
- 🏷️ **Interactive Speaker Labeling**: Identify speakers with contextual examples
- 📝 **Markdown Output**: Clean, formatted transcripts ready for documentation
- 💾 **Resume Capability**: Gracefully handle interruptions and resume processing
- 🔄 **Progress Tracking**: Visual feedback during transcription process
- 🔐 **Secure API Key Storage**: Safely store your AssemblyAI credentials

## Installation

### From npm (when published)

```bash
npm install -g meeting-whisperer
```

### From source

```bash
git clone <repository-url>
cd meeting-whisperer
npm install
npm run build
npm link
```

## Usage

### Transcribe an audio/video file

```bash
meeting-whisperer transcribe /path/to/your/audio-file.mp4
```

Supported formats: MP3, MP4, WAV, M4A, FLAC, and many more.

### View help

```bash
meeting-whisperer --help
```

```bash
meeting-whisperer help transcribe
```

### Remove stored API key

```bash
meeting-whisperer remove-api-key
```

## Getting Started

1. **Get an AssemblyAI API Key**
   - Sign up at [AssemblyAI](https://www.assemblyai.com/)
   - Get your API key from the dashboard

2. **First Run**
   - Run any transcribe command
   - You'll be prompted to enter your API key
   - The key is securely stored for future use

3. **Transcribe Your File**
   ```bash
   meeting-whisperer transcribe my-meeting.mp4
   ```

4. **Speaker Identification**
   - The tool will show you examples of each detected speaker
   - You can identify speakers, skip them, or try again later
   - Context is provided to help you identify who's speaking

5. **Get Your Transcript**
   - A markdown file will be created in the same directory as your audio file
   - Format: `original-filename-transcript.md`

## Example Output

```markdown
# Meeting Transcript

*File: team-meeting.mp4*
*Duration: 45 minutes*
*Processed: 2024-01-15 at 14:30*

## Speakers
- **Alice Johnson**
- **Bob Smith**
- **Speaker C** (unidentified)

## Transcript

[0:15] **Alice Johnson**: Welcome everyone to today's team meeting...

[2:45] **Bob Smith**: Thanks Alice. I wanted to start by discussing...
```

## Development

### Prerequisites

- Node.js (v18 or higher)
- TypeScript
- npm

### Setup

```bash
git clone <repository-url>
cd meeting-whisperer
npm install
```

### Development Scripts

```bash
# Run in development mode
npm run dev /path/to/audio-file.mp4

# Build the project
npm run build

# Test the built version
node dist/index.js transcribe /path/to/audio-file.mp4
```

### Building

The project uses TypeScript and compiles to JavaScript in the `dist/` folder:

```bash
npm run build
```

This creates:
- `dist/index.js` - Main CLI entry point
- `dist/assembly-whisperer.js` - Core functionality
- Type definitions and source maps

## Publishing

### Prepare for Publishing

1. **Update version** in `package.json`
2. **Build the project**:
   ```bash
   npm run build
   ```
3. **Test the build**:
   ```bash
   node dist/index.js --help
   ```

### Publish to npm

```bash
# Login to npm (first time only)
npm login

# Publish (will run prepublishOnly script automatically)
npm publish
```

The `prepublishOnly` script automatically runs `npm run build` before publishing.

### Verify Publication

```bash
# Check if published successfully
npm view meeting-whisperer

# Test global installation
npm install -g meeting-whisperer
meeting-whisperer --help
```

## Configuration

Configuration files are stored in `~/.assembly-whisperer/`:
- `keys.json` - API credentials
- `tmp/draft.json` - Resume data for interrupted sessions

## Troubleshooting

### "Invalid AssemblyAI API key"
- Verify your API key is correct
- Remove and re-enter: `meeting-whisperer remove-api-key`

### "Audio file does not exist"
- Check the file path is correct
- Ensure the file exists and is readable

### "Failed to connect to AssemblyAI"
- Check your internet connection
- Verify AssemblyAI service status

### Resume Interrupted Sessions
If the process is interrupted:
1. Run the same command again
2. Choose "Resume previous session?" when prompted
3. The tool will continue where it left off

## API Reference

### AssemblyWhisperer Class

The main class exported from `assembly-whisperer.js`:

```typescript
import { AssemblyWhisperer } from 'meeting-whisperer';

const whisperer = new AssemblyWhisperer();
await whisperer.run('/path/to/audio-file.mp4');
```

## How it works with npx

When you publish to npm, users can run your tool in several ways:

1. **Global installation:**
   ```bash
   npm install -g meeting-whisperer
   meeting-whisperer transcribe audio.mp4
   ```

2. **Using npx (recommended):**
   ```bash
   npx meeting-whisperer transcribe audio.mp4
   ```

3. **Local installation:**
   ```bash
   npm install meeting-whisperer
   npx meeting-whisperer transcribe audio.mp4
   ```

The `bin` field in `package.json` tells npm to create a `meeting-whisperer` command that points to `dist/index.js`. The shebang `#!/usr/bin/env node` at the top of `index.js` tells the system to run it with Node.js.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC

## Credits

Built with:
- [AssemblyAI](https://www.assemblyai.com/) - Speech-to-text API
- [Commander.js](https://github.com/tj/commander.js) - CLI framework
- [Inquirer](https://github.com/SBoudrias/Inquirer.js) - Interactive prompts
- [Chalk](https://github.com/chalk/chalk) - Terminal colors
- [Ora](https://github.com/sindresorhus/ora) - Loading spinners

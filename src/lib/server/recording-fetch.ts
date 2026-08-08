import { setLocalAudioPathForUser } from '@/db-ops/transcripts';
import {
  downloadDriveFileToTemp,
  getDriveFileMeta,
} from '@/lib/server/gmeet';
import {
  audioFilename,
  deleteAudioFile,
  renameAudioFile,
} from '@/lib/server/audio-storage';
import { sniffMediaExtension } from '@/lib/server/video-frames';

/** Drive-side refusal with an HTTP status the API route can pass through. */
export class RecordingFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'RecordingFetchError';
  }
}

/** One Drive pull per transcript at a time — concurrent callers (double-click,
 * two viewers, a report run racing a manual fetch) all await the SAME
 * download instead of pulling the multi-hundred-MB file twice. */
const inFlight = new Map<string, Promise<{ bytes: number }>>();

/**
 * Download the transcript's known Drive recording and store it as the row's
 * local audio (no re-transcription — playback + video frames just start
 * working). Shared by the fetch-audio route and the detailed-report
 * generator's fetch-before-run step.
 */
export function fetchRecordingFromDrive(opts: {
  ownerUserId: string;
  assemblyaiId: string;
  fileId: string;
  accessToken: string;
}): Promise<{ bytes: number }> {
  const existing = inFlight.get(opts.assemblyaiId);
  if (existing) return existing;
  const run = doFetch(opts).finally(() => inFlight.delete(opts.assemblyaiId));
  inFlight.set(opts.assemblyaiId, run);
  return run;
}

async function doFetch({
  ownerUserId,
  assemblyaiId,
  fileId,
  accessToken,
}: {
  ownerUserId: string;
  assemblyaiId: string;
  fileId: string;
  accessToken: string;
}): Promise<{ bytes: number }> {
  const meta = await getDriveFileMeta(accessToken, fileId);
  if (!meta.canDownload) {
    throw new RecordingFetchError(
      'The owner has disabled downloads for viewers on this recording. Ask them for edit access or to lift the restriction (Share → gear icon).',
      403
    );
  }
  const dl = await downloadDriveFileToTemp(accessToken, fileId);
  if (dl.bytes === 0) {
    await deleteAudioFile(dl.tempFilename);
    throw new RecordingFetchError('Drive returned an empty file', 502);
  }
  let filename = audioFilename(assemblyaiId, meta.name);
  if (filename.endsWith('.bin')) {
    // Drive names Meet recordings without an extension — sniff the container
    // so video detection and playback Content-Type work.
    const sniffed = await sniffMediaExtension(dl.tempFilename);
    if (sniffed) filename = `${assemblyaiId}${sniffed}`;
  }
  await renameAudioFile(dl.tempFilename, filename);
  await setLocalAudioPathForUser(ownerUserId, assemblyaiId, filename);
  return { bytes: dl.bytes };
}

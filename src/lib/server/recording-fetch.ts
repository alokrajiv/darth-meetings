import { setLocalAudioPathForUser, setVideoPartStoredForUser } from '@/db-ops/transcripts';
import {
  downloadDriveFileToTemp,
  getDriveFileMeta,
} from '@/lib/server/gmeet';
import { getRecordingStream } from '@/lib/server/ms-graph';
import {
  audioFilename,
  deleteAudioFile,
  renameAudioFile,
  saveAudioStreamToTemp,
} from '@/lib/server/audio-storage';
import { sniffMediaExtension } from '@/lib/server/video-frames';
import { prepareMediaForPlayback } from '@/lib/server/media-sweeper';

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

/**
 * Teams twin of fetchRecordingFromDrive: pull the meeting's MP4 from Graph
 * (app-only — no user token) and store it as the row's local audio. Shares
 * the same in-flight map, so a sweeper run and a page-load fetch of the same
 * row join one download.
 */
export function fetchRecordingFromTeams(opts: {
  ownerUserId: string;
  assemblyaiId: string;
  organizerOid: string;
  graphMeetingId: string;
  recordingId: string;
}): Promise<{ bytes: number }> {
  const existing = inFlight.get(opts.assemblyaiId);
  if (existing) return existing;
  const run = doFetchTeams(opts).finally(() => inFlight.delete(opts.assemblyaiId));
  inFlight.set(opts.assemblyaiId, run);
  return run;
}

/**
 * Pull an EXTRA recording segment (gmeet_context.videoParts entry) from
 * Drive and store it as `<assemblyaiId>.part<N>.<ext>` beside the primary
 * media — multi-video meetings (stop-restart recordings) keep every segment
 * playable. Stamps the part's filename/bytes into the context on success.
 * In-flight keyed per part so the poller and the sweeper join one download.
 */
export function fetchVideoPartFromDrive(opts: {
  ownerUserId: string;
  assemblyaiId: string;
  fileId: string;
  /** Display part number — the primary video is 1, so parts start at 2. */
  partNo: number;
  accessToken: string;
}): Promise<{ bytes: number }> {
  const key = `${opts.assemblyaiId}#${opts.fileId}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = doFetchPart(opts).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function doFetchPart({
  ownerUserId,
  assemblyaiId,
  fileId,
  partNo,
  accessToken,
}: {
  ownerUserId: string;
  assemblyaiId: string;
  fileId: string;
  partNo: number;
  accessToken: string;
}): Promise<{ bytes: number }> {
  const meta = await getDriveFileMeta(accessToken, fileId);
  if (!meta.canDownload) {
    throw new RecordingFetchError(
      'The owner has disabled downloads for viewers on this recording.',
      403
    );
  }
  const dl = await downloadDriveFileToTemp(accessToken, fileId);
  if (dl.bytes === 0) {
    await deleteAudioFile(dl.tempFilename);
    throw new RecordingFetchError('Drive returned an empty file', 502);
  }
  // Meet recordings usually have no extension in their Drive name — sniff.
  const sniffed = await sniffMediaExtension(dl.tempFilename);
  const filename = `${assemblyaiId}.part${partNo}${sniffed ?? '.mp4'}`;
  await renameAudioFile(dl.tempFilename, filename);
  await setVideoPartStoredForUser(ownerUserId, assemblyaiId, fileId, {
    filename,
    bytes: dl.bytes,
  });
  prepareMediaForPlayback(ownerUserId, assemblyaiId);
  return { bytes: dl.bytes };
}

async function doFetchTeams({
  ownerUserId,
  assemblyaiId,
  organizerOid,
  graphMeetingId,
  recordingId,
}: {
  ownerUserId: string;
  assemblyaiId: string;
  organizerOid: string;
  graphMeetingId: string;
  recordingId: string;
}): Promise<{ bytes: number }> {
  const res = await getRecordingStream(organizerOid, graphMeetingId, recordingId);
  if (!res.body) {
    throw new RecordingFetchError('Graph returned an empty recording body', 502);
  }
  const dl = await saveAudioStreamToTemp(res.body as ReadableStream<Uint8Array>);
  if (dl.bytes === 0) {
    await deleteAudioFile(dl.tempFilename);
    throw new RecordingFetchError('Graph returned an empty recording', 502);
  }
  // Teams recordings are MP4, but sniff anyway — same belt as the Drive path.
  const sniffed = await sniffMediaExtension(dl.tempFilename);
  const filename = `${assemblyaiId}${sniffed ?? '.mp4'}`;
  await renameAudioFile(dl.tempFilename, filename);
  await setLocalAudioPathForUser(ownerUserId, assemblyaiId, filename);
  prepareMediaForPlayback(ownerUserId, assemblyaiId);
  return { bytes: dl.bytes };
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
  // Meet recordings are the moov-last case (tech-debt A1) — remux + extract now.
  prepareMediaForPlayback(ownerUserId, assemblyaiId);
  return { bytes: dl.bytes };
}

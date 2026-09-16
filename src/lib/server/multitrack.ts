import 'server-only';
import { promises as fsp } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveAudioPath } from '@/lib/server/audio-storage';

const execFileP = promisify(execFile);
const EXEC_OPTS = { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 };

/**
 * Multi-track recordings.
 *
 * Darth Recorder writes one mp4 per segment with THREE tracks: video, the
 * system audio (what the other participants said, stereo, lang `mul`) and the
 * microphone (the recording user, mono, lang `eng`) — deliberately never mixed
 * at capture so either can be used on its own later.
 *
 * Every consumer downstream reads exactly ONE audio stream: AssemblyAI takes
 * the file's default track, the browser <video> plays the default track,
 * ffmpeg's automatic selection picks the stream with the most channels, and
 * the audio-only extract inherits that. Result before this module (proved
 * 2026-09-16 on a real Slack huddle): the transcript carried only the other
 * side — 484 words instead of 1429 — and the recording user was silent on
 * playback too.
 *
 * `normalizeMultiTrack` fixes that once, at ingest, for any file with two or
 * more audio streams:
 *   1. renders a MIX of every audio stream to a small stereo m4a — the file
 *      that is sent to AssemblyAI (also a much smaller upload than the video);
 *   2. re-muxes the stored file so the mix is the FIRST audio track and the
 *      only one flagged `default`, with the raw tracks kept after it in their
 *      original order. Video is stream-copied; nothing is re-encoded except the
 *      mix itself, which is why this is fine on a small VM (~40 s per hour).
 *
 * The mix is stereo on purpose: ffmpeg's automatic selection prefers the
 * highest channel count and breaks ties by lowest index, so a mono mix would
 * lose to the stereo system track in every tool that does not honour the
 * default flag. Files with a single audio stream are returned untouched.
 */

export interface AudioStreamInfo {
  index: number;
  channels: number;
  sampleRate: number;
  language: string | null;
  title: string | null;
  handler: string | null;
}

/** Stamped on the mix track (as the MP4 handler name — the mov muxer drops a
 * per-stream `title`, verified 2026-09-16) so a second pass (ingest retry of
 * a kept-failure row) recognises an already-normalised file instead of mixing
 * the mix back in with the raw tracks. */
export const MIX_TRACK_TITLE = 'darth-mix';

export function isMixTrack(s: AudioStreamInfo): boolean {
  return s.handler === MIX_TRACK_TITLE || s.title === MIX_TRACK_TITLE;
}

export async function probeAudioStreams(filename: string): Promise<AudioStreamInfo[]> {
  const { stdout } = await execFileP(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=index,channels,sample_rate:stream_tags=language,title,handler_name',
      '-of', 'json',
      resolveAudioPath(filename),
    ],
    EXEC_OPTS
  );
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      index?: number;
      channels?: number;
      sample_rate?: string;
      tags?: { language?: string; title?: string; handler_name?: string };
    }>;
  };
  return (parsed.streams ?? []).map((s, i) => ({
    index: s.index ?? i,
    channels: s.channels ?? 1,
    sampleRate: Number(s.sample_rate ?? 48000) || 48000,
    language: s.tags?.language ?? null,
    title: s.tags?.title ?? null,
    handler: s.tags?.handler_name ?? null,
  }));
}

export interface MultiTrackResult {
  /** True when the file had ≥2 audio streams and was normalised. */
  mixed: boolean;
  /** Audio stream count found in the input. */
  tracks: number;
  /**
   * The filename (in the audio dir) to send to AssemblyAI. The mix m4a when
   * `mixed`, else the input itself. The caller deletes the mix once uploaded.
   */
  aaiSource: string;
}

/**
 * See the module comment. Mutates `tempFilename` in place (atomic rename of a
 * re-muxed copy over it) when the file has ≥2 audio streams. Throws on ffmpeg
 * failure — callers should treat that as non-fatal and fall back to the raw
 * file, which is exactly the pre-existing behaviour.
 */
export async function normalizeMultiTrack(tempFilename: string): Promise<MultiTrackResult> {
  const streams = await probeAudioStreams(tempFilename);
  if (streams.length < 2) {
    return { mixed: false, tracks: streams.length, aaiSource: tempFilename };
  }

  const src = resolveAudioPath(tempFilename);
  const mixName = `mix-${randomUUID()}.m4a`;
  const mixAbs = resolveAudioPath(mixName);
  const remuxTmp = `${src}.remux.tmp`;

  // Already normalised (ingest retry of a kept-failure row): the mix is
  // track 0 — just pull it out for AssemblyAI, never mix again.
  if (isMixTrack(streams[0])) {
    try {
      await execFileP(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a:0', '-c', 'copy',
         '-movflags', '+faststart', '-f', 'mp4', mixAbs],
        EXEC_OPTS
      );
    } catch (err) {
      await fsp.unlink(mixAbs).catch(() => {});
      throw new Error(`multitrack mix extract failed: ${describe(err)}`);
    }
    return { mixed: true, tracks: streams.length, aaiSource: mixName };
  }

  // 1. Mix: every audio stream → mono 48 kHz → summed (normalize=0 keeps
  //    each voice at its recorded level; the limiter catches the rare overlap
  //    peak) → stereo (see module comment for why).
  const inputs = streams.map((_, i) => `[0:a:${i}]aformat=sample_rates=48000:channel_layouts=mono[a${i}]`);
  const filter =
    inputs.join(';') +
    ';' +
    streams.map((_, i) => `[a${i}]`).join('') +
    `amix=inputs=${streams.length}:duration=longest:normalize=0,alimiter=limit=0.95,aformat=channel_layouts=stereo[mix]`;
  try {
    await execFileP(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        '-filter_complex', filter,
        '-map', '[mix]',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        '-f', 'mp4',
        mixAbs,
      ],
      EXEC_OPTS
    );
  } catch (err) {
    await fsp.unlink(mixAbs).catch(() => {});
    throw new Error(`multitrack mix failed: ${describe(err)}`);
  }

  // 2. Re-mux: video (if any) + mix as audio #0 (default) + the raw tracks.
  //    `-disposition:a:N 0` clears the default flag the raw tracks carried.
  const clearDispositions = streams.flatMap((_, i) => [`-disposition:a:${i + 1}`, '0']);
  try {
    await execFileP(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        '-i', mixAbs,
        '-map', '0:v?',
        '-map', '1:a',
        '-map', '0:a',
        '-c', 'copy',
        '-disposition:a:0', 'default',
        '-metadata:s:a:0', `handler_name=${MIX_TRACK_TITLE}`,
        '-metadata:s:a:0', `title=${MIX_TRACK_TITLE}`,
        ...clearDispositions,
        '-movflags', '+faststart',
        '-f', 'mp4',
        remuxTmp,
      ],
      EXEC_OPTS
    );
    await fsp.rename(remuxTmp, src);
  } catch (err) {
    await fsp.unlink(remuxTmp).catch(() => {});
    await fsp.unlink(mixAbs).catch(() => {});
    throw new Error(`multitrack remux failed: ${describe(err)}`);
  }

  return { mixed: true, tracks: streams.length, aaiSource: mixName };
}

function describe(err: unknown): string {
  const stderr =
    err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr).slice(-400) : '';
  return stderr || (err instanceof Error ? err.message : String(err));
}

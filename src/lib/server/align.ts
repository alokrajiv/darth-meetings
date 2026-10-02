import 'server-only';
import { promises as fsp } from 'node:fs';
import {
  alignAdvice,
  ALIGN_WIDE_WINDOW_MS,
  ALIGN_WINDOW_MS,
  nominalOffsetMsBetween,
  type AlignOk,
} from '@/lib/clips';
import { listAddableRecordings } from '@/db-ops/clips';
import { getRecording, listRecordingMedia } from '@/db-ops/recordings';
import { buildAudioOnly, getAudioOnlyPath } from '@/lib/server/audio-only';
import { resolveAudioPath } from '@/lib/server/audio-storage';

/**
 * "Line them up" — the offset between two recordings of one meeting
 * (docs/recordings-phase3b-combine-spec.md §"The offset — never guessed
 * silently").
 *
 * The arithmetic is the envelope cross-correlation that was run by hand for
 * the SI-BL merge and now lives in the python sidecar next to the voiceprint
 * embedder (`voiceprint/server.py`, `POST /align`, port 3004): 100 Hz log-RMS
 * envelopes of the two files, FFT cross-correlated, searched ±120 s around a
 * nominal taken from the two `started_at`. It runs on the AUDIO-ONLY
 * derivatives — a 5-hour 1080p video decoded for its loudness pattern is
 * minutes of ffmpeg for nothing — and builds them when they are missing.
 *
 * THE RESULT IS NEVER APPLIED. It comes back as a number with a confidence
 * and the UI draws the two envelopes at the proposed offset with a nudge
 * control; "Use this offset" is the person's click. Below 0.4 the answer is
 * "could not line these up — set the offset by ear" (`alignAdvice`).
 *
 * PRIVACY: both recordings must be reachable by the caller — owned, or
 * reached through a meeting they can EDIT. That is exactly what
 * `listAddableRecordings` scopes on in SQL, so this route reuses it rather
 * than inventing a second predicate (feedback_privacy_caller_scoping_gate).
 * Alignment reveals when two recordings overlap, which is a fact about both.
 */

const SIDECAR_URL = process.env.MW_VOICEPRINT_URL || 'http://127.0.0.1:3004';
/** Envelopes of two multi-hour files, decoded and correlated. Minutes, not
 * seconds — but bounded, because a request is holding it. */
const ALIGN_TIMEOUT_MS = 10 * 60_000;

export type AlignResult =
  | { ok: true; body: AlignOk }
  | { ok: false; status: number; body: { error: string; code?: string } };

function fail(status: number, error: string, code?: string): AlignResult {
  return { ok: false, status, body: { error, ...(code ? { code } : {}) } };
}

/**
 * The file the correlation reads for a recording: its `audio_only` derivative
 * when the canonical carries video, else the canonical itself.
 *
 * `buildAudioOnly` is idempotent and shares its in-flight ffmpeg with the
 * player's `?variant=audio` path, so two people aligning the same pair at once pay for one
 * transcode.
 */
async function audioPathForRecording(
  recordingId: string
): Promise<{ path: string; filename: string } | { error: string }> {
  const media = await listRecordingMedia([recordingId]);
  const canonical = media
    .filter((m) => m.kind === 'canonical' && m.filename)
    .sort((a, b) => a.ord - b.ord)[0];
  if (!canonical?.filename) return { error: 'That recording has no file on this server.' };
  const filename = canonical.filename;

  let source: string;
  try {
    source = resolveAudioPath(filename);
  } catch {
    return { error: 'That recording has no file on this server.' };
  }
  if (!(await fsp.stat(source).catch(() => null))) {
    return { error: 'That recording’s file is not on this server right now.' };
  }

  const built = await buildAudioOnly(filename, { nice: true });
  if (built.status === 'error') {
    // Not fatal: the correlation can read the original, it is just slower.
    console.warn(`[align] audio-only build failed for ${filename}: ${built.error}`);
    return { path: source, filename };
  }
  return { path: built.derived ? getAudioOnlyPath(filename) : source, filename };
}

export async function alignRecordings(input: {
  caller: { userId: string; email: string };
  recordingId: string;
  againstRecordingId: string;
  nominalOffsetMs?: number | null;
  searchWindowMs?: number | null;
}): Promise<AlignResult> {
  const { caller } = input;
  if (input.recordingId === input.againstRecordingId) {
    return fail(400, 'A recording cannot be lined up against itself.', 'same-recording');
  }

  // Reachability, both of them, through the caller-scoped query. A recording
  // the caller cannot reach is 404 and never 403: this route must not become
  // a way to ask whether a recording id exists.
  for (const id of [input.recordingId, input.againstRecordingId]) {
    const reachable = await listAddableRecordings(caller, { recordingId: id });
    if (reachable.length === 0) return fail(404, 'That recording is not available to you.');
  }

  const [a, b] = await Promise.all([
    getRecording(input.againstRecordingId),
    getRecording(input.recordingId),
  ]);
  if (!a || !b || a.deleted_at || b.deleted_at) {
    return fail(404, 'That recording is not available to you.');
  }

  // `against` is A and `:id` is B, so the answer reads "how far :id starts
  // AFTER against" — which is the number that becomes a clip's `offsetMs`
  // when `against` is the meeting's primary recording and sits at 0.
  const nominalFromClocks = nominalOffsetMsBetween(a.started_at, b.started_at);
  const nominalOffsetMs =
    input.nominalOffsetMs != null && Number.isFinite(input.nominalOffsetMs)
      ? Math.round(input.nominalOffsetMs)
      : (nominalFromClocks ?? 0);
  // ±120 s when we had a clock to start from, ±30 min when we are guessing.
  const searchWindowMs =
    input.searchWindowMs != null && Number.isFinite(input.searchWindowMs)
      ? Math.max(1_000, Math.min(ALIGN_WIDE_WINDOW_MS, Math.round(input.searchWindowMs)))
      : input.nominalOffsetMs != null || nominalFromClocks !== null
        ? ALIGN_WINDOW_MS
        : ALIGN_WIDE_WINDOW_MS;

  const [fa, fb] = await Promise.all([
    audioPathForRecording(input.againstRecordingId),
    audioPathForRecording(input.recordingId),
  ]);
  if ('error' in fa) return fail(409, fa.error, 'no-media');
  if ('error' in fb) return fail(409, fb.error, 'no-media');

  let payload: {
    offsetMs: number;
    confidence: number;
    driftPpm: number | null;
    method: string;
    overlapMs: number | null;
  };
  try {
    const res = await fetch(`${SIDECAR_URL}/align`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        a: fa.path,
        b: fb.path,
        nominalMs: nominalOffsetMs,
        windowMs: searchWindowMs,
      }),
      signal: AbortSignal.timeout(ALIGN_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message = body?.error ?? `alignment failed (${res.status})`;
      // 400 from the sidecar is a statement about the audio ("they do not
      // overlap inside that window"), which the person can act on.
      return fail(res.status === 400 || res.status === 404 ? 409 : 502, message, 'sidecar');
    }
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    console.warn('[align] sidecar call failed:', err);
    return fail(
      503,
      'The alignment service is not answering right now — set the offset by ear, or try again in a minute.',
      'sidecar-down'
    );
  }

  const confidence = Math.max(0, Math.min(1, payload.confidence));
  return {
    ok: true,
    body: {
      ok: true,
      offsetMs: Math.round(payload.offsetMs),
      confidence,
      driftPpm: payload.driftPpm ?? null,
      method: payload.method,
      nominalOffsetMs,
      searchWindowMs,
      overlapMs: payload.overlapMs ?? null,
      advice: alignAdvice(confidence),
    },
  };
}

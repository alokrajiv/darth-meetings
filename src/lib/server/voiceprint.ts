import 'server-only';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { listAll, enrollSample } from '@/db-ops/voiceprints';
import {
  getForUser as getMappingsForUser,
  setSuggestionsForUser,
} from '@/db-ops/speaker-mappings';
import type {
  SpeakerLabel,
  SpeakerSuggestionMap,
  TranscriptResponse,
} from '@/lib/format';

/**
 * Voiceprint speaker auto-identification.
 *
 * The heavy lifting (ffmpeg slicing + ECAPA-TDNN embedding) lives in the
 * Python sidecar (voiceprint/server.py, pm2 `mw-voiceprint`, localhost:3004).
 * This module picks which utterances to embed, talks to the sidecar, and
 * does the cosine matching against enrolled voiceprints in Postgres.
 *
 * Everything here is best-effort: if the sidecar is down or the audio is
 * missing, we log and return — transcription/notes must never be blocked by
 * speaker ID.
 */

const SIDECAR_URL = process.env.MW_VOICEPRINT_URL || 'http://127.0.0.1:3004';

/**
 * Minimum cosine similarity to surface a suggestion. Observed on real org
 * meetings (2026-07-30): genuine cross-meeting matches score 0.6+ (0.84 for
 * a well-enrolled speaker); an unenrolled external speaker false-matched at
 * 0.40 and a borderline case at 0.48, so 0.5 is the floor. Tune with
 * MW_VOICEPRINT_THRESHOLD.
 */
const THRESHOLD = Number(process.env.MW_VOICEPRINT_THRESHOLD || '0.5');

/** Require the best match to beat the runner-up by this margin (ambiguity guard). */
const MARGIN = 0.05;

/**
 * Free-text naming created duplicate identities ("Ivan" vs "Ivan Seow",
 * "Kawen" vs "Kawen Koh", "LiXuan" vs "Li Xuan"). The margin guard must not
 * treat two spellings of the same human as competing candidates — that
 * suppressed a 0.81 match because the duplicate scored 0.77.
 */
function sameIdentity(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  if (na.replace(/\s+/g, '') === nb.replace(/\s+/g, '')) return true; // "LiXuan" / "Li Xuan"
  if (na.startsWith(nb) || nb.startsWith(na)) return true; // "ivan seow" / "ivan"
  return na.split(/\s+/)[0] === nb.split(/\s+/)[0]; // same first name
}

interface Segment {
  start_ms: number;
  end_ms: number;
}

/**
 * Pick the best utterances for a speaker: longest first (more speech = more
 * stable embedding), capped at 6 segments. The sidecar further caps each
 * segment at 20s.
 */
function pickSegments(
  content: TranscriptResponse,
  speaker: string
): Segment[] {
  const utterances = (content.utterances ?? []).filter(
    (u) => u.speaker === speaker && u.end - u.start >= 1500
  );
  return utterances
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .slice(0, 6)
    .map((u) => ({ start_ms: u.start, end_ms: u.end }));
}

async function embedViaSidecar(
  audioPath: string,
  segments: Segment[]
): Promise<number[] | null> {
  if (segments.length === 0) return null;
  const res = await fetch(`${SIDECAR_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_path: audioPath, segments }),
    // Embedding N segments on CPU takes seconds, not minutes.
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sidecar /embed ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! * a[i]!;
    nb += (b[i] ?? 0) * (b[i] ?? 0);
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function audioPathFor(localAudioFilename: string | null): string | null {
  if (!localAudioFilename) return null;
  try {
    return resolveAudioPath(localAudioFilename);
  } catch {
    return null;
  }
}

/**
 * Enroll voiceprints from a transcript's named speakers. Called after a
 * speaker-labels save (and by the backfill script). Only labels with a
 * non-empty customName enroll; failures are logged and swallowed.
 */
export async function enrollFromTranscript(
  localAudioFilename: string | null,
  content: TranscriptResponse | null,
  labels: SpeakerLabel[]
): Promise<void> {
  const audioPath = audioPathFor(localAudioFilename);
  if (!audioPath || !content?.utterances?.length) return;

  for (const label of labels) {
    const name = label.customName.trim();
    if (!name) continue;
    try {
      const segments = pickSegments(content, label.originalSpeaker);
      const embedding = await embedViaSidecar(audioPath, segments);
      if (embedding) {
        await enrollSample(name, embedding);
        console.log(`[voiceprint] enrolled sample for "${name}" (speaker ${label.originalSpeaker})`);
      }
    } catch (err) {
      console.warn(`[voiceprint] enroll failed for "${name}":`, err);
    }
  }
}

/**
 * Match every diarized speaker in a fresh transcript against the enrolled
 * voiceprints and persist suggestions on the owner's speaker_mappings row.
 * Returns the computed map (also what was persisted) so callers can respond
 * synchronously — matching is pure local signal processing, a few seconds.
 */
export async function suggestSpeakersForTranscript(
  ownerUserId: string,
  assemblyaiId: string,
  localAudioFilename: string | null,
  content: TranscriptResponse | null
): Promise<SpeakerSuggestionMap> {
  const audioPath = audioPathFor(localAudioFilename);
  if (!audioPath || !content?.utterances?.length) return {};

  const voiceprints = await listAll();
  if (voiceprints.length === 0) return {};

  const speakers = [...new Set(content.utterances.map((u) => u.speaker))];
  const suggestions: SpeakerSuggestionMap = {};

  for (const speaker of speakers) {
    try {
      const segments = pickSegments(content, speaker);
      const embedding = await embedViaSidecar(audioPath, segments);
      if (!embedding) continue;

      const scored = voiceprints
        .map((vp) => ({ name: vp.name, score: cosine(embedding, vp.embedding) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0]!;
      // Runner-up for the margin check = best-scoring *distinct person*.
      const second = scored.find((s) => !sameIdentity(s.name, best.name));
      if (best.score >= THRESHOLD && (!second || best.score - second.score >= MARGIN)) {
        suggestions[speaker] = {
          name: best.name,
          confidence: Math.round(best.score * 100) / 100,
          source: 'voice',
        };
      }
    } catch (err) {
      console.warn(`[voiceprint] suggest failed for speaker ${speaker}:`, err);
    }
  }

  // Preserve context-source suggestions (from Claude's transcript reading)
  // for speakers the voice pass has no opinion on; voice wins on overlap.
  const existing = (await getMappingsForUser(ownerUserId, assemblyaiId))?.suggestions ?? {};
  const merged: SpeakerSuggestionMap = { ...suggestions };
  for (const [sp, s] of Object.entries(existing)) {
    if (!merged[sp] && s.source === 'context') merged[sp] = s;
  }

  if (Object.keys(merged).length > 0) {
    await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);
    console.log(
      `[voiceprint] ${assemblyaiId}: suggested`,
      Object.entries(merged)
        .map(([sp, s]) => `${sp}=${s.name}(${s.source === 'context' ? 'ctx' : s.confidence})`)
        .join(', ')
    );
  }
  return merged;
}

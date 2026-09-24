import 'server-only';
import { resolveAudioPath } from '@/lib/server/audio-storage';
import { canonicalMedia, localMsIn, type ResolvedMedia } from '@/lib/server/recordings';
import { splitSpeakerLabel } from '@/lib/recording-clips';
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

import { isGroupLabel } from '@/lib/speaker-name-kind';
import { samePerson } from '@/lib/person-identity';
import {
  formatVerdict,
  pickSpeechByBudget,
  type SpeakerVerdict,
} from '@/lib/voiceprint-math';

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

// Free-text naming created duplicate identities ("Ivan" / "Ivan Seow",
// "karnica.katiyar" / "Karnica Katiyar"). The margin guard must not treat two
// spellings of one human as rival candidates — `samePerson`
// (lib/person-identity.ts) is that rule; it also lets two rows sharing a
// personNameKey coexist until scripts/rebuild-voiceprints.ts folds them.

interface Segment {
  start_ms: number;
  end_ms: number;
}

/**
 * Every media file the meeting has, or just the one a caller handed over.
 *
 * The array form is what a meeting over SEVERAL recordings needs (Phase 3b):
 * each recording's snippets have to be cut from ITS OWN file, so the caller
 * passes `resolved.media` and the label says which one. The single form is
 * what every 3a caller passed (`canonicalMedia(...)`) and still means "this
 * meeting has one file and it is this".
 */
export type VoiceprintMedia = ResolvedMedia | ResolvedMedia[] | null;

function asList(media: VoiceprintMedia): ResolvedMedia[] {
  if (media === null) return [];
  return Array.isArray(media) ? media : [media];
}

/**
 * The file a diarized speaker's voice is IN.
 *
 * A meeting over one recording has one answer and the label is a bare letter.
 * A meeting over two carries `<recordingId>:<letter>` labels
 * (`resolveClips` — the namespace exists precisely because "A" of one
 * recording is not "A" of the other), and the prefix names the file: cutting
 * a phone clip's snippets out of the Teams video would embed the wrong
 * person, or silence.
 *
 * Falls back to the canonical when the label carries no prefix, which is
 * every meeting on prod today.
 */
export function mediaForSpeaker(media: VoiceprintMedia, speaker: string): ResolvedMedia | null {
  const list = asList(media);
  if (list.length === 0) return null;
  const { recordingId } = splitSpeakerLabel(speaker);
  if (recordingId) {
    // The recording's CANONICAL file — the one the transcription was made
    // from, and therefore the one its utterance times are measured against.
    const mine = list.filter((m) => m.recordingId === recordingId);
    if (mine.length > 0) return mine[0]!;
    return null;
  }
  return canonicalMedia(list) ?? list[0]!;
}

/**
 * Pick the best utterances for a speaker: longest first (more speech = more
 * stable embedding) until ~90 s of speech or 12 segments
 * (`pickSpeechByBudget`, lib/voiceprint-math.ts). The sidecar further caps
 * each segment at 20s. `seconds` is the speech actually sent — enrolment
 * weights the sample by it.
 *
 * Utterance times are MEETING time; the sidecar slices a FILE. `media` is
 * what the resolver says that file is, so its `offsetMs` converts between
 * them (0 for a compat meeting, where the canonical starts at t=0 — landmine
 * #15, which is why the conversion goes through the resolver rather than
 * being assumed). In a combined meeting the file is the SPEAKER's recording,
 * so `localMsIn` maps through that clip's placement, not the primary's.
 */
export function pickSegments(
  content: TranscriptResponse,
  speaker: string,
  media: ResolvedMedia
): { segments: Segment[]; seconds: number; longestMs: number } {
  const picked = pickSpeechByBudget(content.utterances ?? [], speaker);
  return {
    segments: picked.utterances.map((u) => ({
      start_ms: localMsIn(media, u.start),
      end_ms: localMsIn(media, u.end),
    })),
    seconds: picked.seconds,
    longestMs: picked.longestMs,
  };
}

export async function embedViaSidecar(
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

export function audioPathFor(media: ResolvedMedia | null): string | null {
  if (!media) return null;
  try {
    return resolveAudioPath(media.filename);
  } catch {
    return null;
  }
}

/**
 * Enroll voiceprints from a transcript's named speakers. Called after a
 * speaker-labels save (and by the backfill script). Only labels with a
 * non-empty customName enroll; failures are logged and swallowed.
 *
 * `media` is the meeting's canonical file as the resolver reports it
 * (`canonicalMedia(resolveMeetingContent(row).media)`), not a raw
 * `local_audio_path`.
 */
export async function enrollFromTranscript(
  media: VoiceprintMedia,
  content: TranscriptResponse | null,
  labels: SpeakerLabel[]
): Promise<void> {
  if (asList(media).length === 0 || !content?.utterances?.length) return;

  for (const label of labels) {
    const name = label.customName.trim();
    if (!name) continue;
    // "mixed" / "room mic" is a shared-mic label, not a person: enrolling it
    // (as happened 2026-09-14, voiceprints id 206) makes the matcher SUGGEST
    // it on other meetings. docs/transcript-page-redesign.md §5.
    if (isGroupLabel(name)) {
      console.log(`[voiceprint] not enrolling group label "${name}" (speaker ${label.originalSpeaker})`);
      continue;
    }
    try {
      // Phase 3b: the file this speaker's voice is actually in.
      const from = mediaForSpeaker(media, label.originalSpeaker);
      const audioPath = audioPathFor(from);
      if (!audioPath || !from) continue;
      const { segments, seconds } = pickSegments(content, label.originalSpeaker, from);
      const embedding = await embedViaSidecar(audioPath, segments);
      if (embedding) {
        await enrollSample(name, embedding, seconds);
        console.log(
          `[voiceprint] enrolled sample for "${name}" (speaker ${label.originalSpeaker}, ${seconds.toFixed(0)}s)`
        );
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
  media: VoiceprintMedia,
  content: TranscriptResponse | null
): Promise<SpeakerSuggestionMap> {
  if (asList(media).length === 0 || !content?.utterances?.length) return {};

  // Enrolments made under a group label before the rule existed stay in the
  // table (deleting is a human's call) but never become a suggestion.
  const voiceprints = (await listAll()).filter((vp) => !isGroupLabel(vp.name));
  if (voiceprints.length === 0) return {};

  const speakers = [...new Set(content.utterances.map((u) => u.speaker))];
  const suggestions: SpeakerSuggestionMap = {};
  const verdicts: string[] = [];

  for (const speaker of speakers) {
    let verdict: SpeakerVerdict = { kind: 'error' };
    try {
      // Each recording's snippets come out of ITS file. A label with no
      // prefix is a single-recording meeting and resolves to the canonical,
      // exactly as before.
      const from = mediaForSpeaker(media, speaker);
      const audioPath = audioPathFor(from);
      if (!audioPath || !from) {
        verdict = { kind: 'no-media' };
        continue;
      }
      const { segments, longestMs } = pickSegments(content, speaker, from);
      if (segments.length === 0) {
        verdict = { kind: 'no-segment', longestMs };
        continue;
      }
      const embedding = await embedViaSidecar(audioPath, segments);
      if (!embedding) {
        verdict = { kind: 'no-segment', longestMs };
        continue;
      }

      const scored = voiceprints
        .map((vp) => ({ name: vp.name, score: cosine(embedding, vp.embedding) }))
        .sort((a, b) => b.score - a.score);

      const best = scored[0]!;
      // Runner-up for the margin check = best-scoring *distinct person*. Two
      // rows of one human (legacy name_key spellings awaiting the rebuild)
      // are `samePerson` and never compete.
      const second = scored.find((s) => !samePerson(s.name, best.name));
      if (best.score < THRESHOLD) {
        verdict = { kind: 'below-threshold', best };
      } else if (second && best.score - second.score < MARGIN) {
        verdict = { kind: 'margin', best, second };
      } else {
        verdict = { kind: 'match', name: best.name, score: best.score };
        suggestions[speaker] = {
          name: best.name,
          confidence: Math.round(best.score * 100) / 100,
          source: 'voice',
        };
      }
    } catch (err) {
      console.warn(`[voiceprint] suggest failed for speaker ${speaker}:`, err);
    } finally {
      verdicts.push(formatVerdict(speaker, verdict));
    }
  }
  console.log(`[voiceprint] ${assemblyaiId} verdicts: ${verdicts.join(' · ')}`);

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

/**
 * One embedding PER SEGMENT, for callers that ask whether a stretch of audio
 * is ONE voice rather than whose voice it is (`lib/meet-align-valve.ts`).
 *
 * `/embed` averages its segments into a voiceprint, which is exactly the
 * wrong shape here: the disagreement between segments IS the signal. This
 * hits the sidecar's `/embed-batch`, which cuts each segment audio-only
 * (`-vn`) and returns the segments it managed to decode, in order.
 *
 * Nothing is enrolled and nothing is written: the vectors are compared to
 * each other by the caller and dropped.
 *
 * Returns `[]` when the sidecar has nothing usable — never a partial verdict.
 */
export async function embedSegmentsViaSidecar(
  audioPath: string,
  segments: Segment[]
): Promise<number[][]> {
  if (segments.length === 0) return [];
  const res = await fetch(`${SIDECAR_URL}/embed-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_path: audioPath, segments }),
    // ~0.15 s per 5 s snippet on the VM; 8 snippets is a couple of seconds.
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sidecar /embed-batch ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  return data.embeddings ?? [];
}

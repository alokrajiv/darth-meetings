import 'server-only';
import { AssemblyAI } from 'assemblyai';
import type { TranscriptResponse } from '@/lib/format';
import { DEFAULT_SPEECH_MODEL, keytermsSupported, type SpeechModel } from '@/lib/aai-language';

/**
 * Server-only AssemblyAI wrapper.
 *
 * Reads `ASSEMBLYAI_API_KEY` from the environment once and exposes a
 * singleton client. The key MUST NOT be sent to the browser — this file
 * imports `server-only` to make that a compile-time error.
 */

let cachedClient: AssemblyAI | null = null;

function getClient(): AssemblyAI {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ASSEMBLYAI_API_KEY is not set. Add it to .env.local on the server.'
    );
  }

  cachedClient = new AssemblyAI({ apiKey });
  return cachedClient;
}

/**
 * Upload audio to AssemblyAI. Pass a local file path (string) whenever
 * possible — the SDK streams it from disk via createReadStream, so multi-GB
 * files never sit in memory. Buffers are still accepted for small payloads.
 */
export async function uploadFile(data: string | Buffer | Uint8Array): Promise<string> {
  return await getClient().files.upload(data);
}

export interface SubmitOptions {
  languageCode?: string;
  /**
   * Flat list of phrases to bias AAI recognition toward. Replaces the old
   * `word_boost` field (deprecated 2026-Q2). Max 1000 terms, 6 words per
   * term. Requires the Universal speech model.
   */
  keytermsPrompt?: string[];
  /** Optional custom spelling rules — applied during transcription. */
  customSpelling?: Array<{ to: string; from: string[] }>;
  /** Defaults to DEFAULT_SPEECH_MODEL; 'universal' is the pre-2026-09 path. */
  model?: SpeechModel;
}

export async function submitTranscription(
  audioUrl: string,
  options: SubmitOptions = {}
): Promise<{ id: string; status: string; model: SpeechModel }> {
  const model = options.model ?? DEFAULT_SPEECH_MODEL;
  const params: {
    audio: string;
    speaker_labels: boolean;
    /** Legacy singular field — only for 'universal'. */
    speech_model?: 'universal';
    /** Current plural field (3.5 Pro and later); AAI falls back to
     * Universal-2 by itself for languages the model doesn't cover. */
    speech_models?: SpeechModel[];
    language_code?: string;
    language_detection?: boolean;
    keyterms_prompt?: string[];
    custom_spelling?: Array<{ to: string; from: string[] }>;
  } = {
    audio: audioUrl,
    speaker_labels: true,
    // Explicit model so we never depend on AAI's server-side default.
    // 2026-09-09 side-by-side on a zh/en call: 3.5 Pro adds punctuation,
    // finds more speakers and keeps English phrases universal dropped, but
    // splits some English words inside Mandarin ("em ail") — acceptable
    // because the text is mostly LLM-consumed; text search is the casualty.
    ...(model === 'universal' ? { speech_model: 'universal' as const } : { speech_models: [model] }),
  };
  if (options.languageCode) params.language_code = options.languageCode;
  // No language chosen ("Auto Detect" in the picker, and every import) →
  // let AAI detect it. Without this flag AAI silently assumes English and
  // a Mandarin call comes back as gibberish. Verified 2026-09-09: universal
  // + detection on a zh/en recording is byte-identical to explicit `zh`,
  // and detection makes AAI ignore keyterms_prompt for non-English instead
  // of rejecting the submit, so the bias list can stay on this path.
  else params.language_detection = true;
  // AAI rejects the whole submit (400) when keyterms_prompt accompanies a
  // non-English language_code on the universal model, so only attach the
  // bias list for English (or unset, which AAI defaults to en). Vocab is
  // English-centric anyway; custom_spelling is language-agnostic and stays.
  if (
    options.keytermsPrompt &&
    options.keytermsPrompt.length > 0 &&
    keytermsSupported(options.languageCode)
  ) {
    params.keyterms_prompt = options.keytermsPrompt;
  }
  if (options.customSpelling && options.customSpelling.length > 0) {
    params.custom_spelling = options.customSpelling;
  }
  const transcript = await getClient().transcripts.submit(params as never);
  return { id: transcript.id, status: transcript.status, model };
}

export async function getTranscript(id: string): Promise<TranscriptResponse> {
  const response = await getClient().transcripts.get(id);
  return response as unknown as TranscriptResponse;
}

export async function deleteTranscript(id: string): Promise<void> {
  try {
    await getClient().transcripts.delete(id);
  } catch (error) {
    // Idempotent delete: if the transcript is already gone on AAI, swallow
    // the 404 so our DB delete can still proceed.
    console.warn('[assemblyai] delete failed (treating as already-gone):', error);
  }
}

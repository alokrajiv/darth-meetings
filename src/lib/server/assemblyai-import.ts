import 'server-only';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';
import { AssemblyAI } from 'assemblyai';
import type { TranscriptResponse } from '@/lib/format';

/**
 * Helpers for the "import from your own AssemblyAI key" flow.
 *
 * The user pastes their personal/old AAI API key. We use it ephemerally —
 * never persisted — to list transcripts and pull each selected one's full
 * content into our own database. After the import request returns, the key
 * is gone.
 *
 * Why a separate file from `assemblyai.ts`? That file owns the singleton
 * client built from `process.env.ASSEMBLYAI_API_KEY` (the server-side key).
 * Imports must NOT touch that singleton — they need a fresh client per
 * request, scoped to the user-supplied key.
 */

export interface ImportableTranscriptMeta {
  id: string;
  created: string | null;
  status: string;
  audio_duration: number | null;
  audio_url: string | null;
}

export function createClientWithKey(apiKey: string): AssemblyAI {
  return new AssemblyAI({ apiKey });
}

/**
 * Quick "is this key plausibly valid" check by attempting a minimal list call.
 * Returns true if the key is accepted by AAI (any response code other than
 * 401/403). Doesn't pay for anything.
 */
export async function validateKey(apiKey: string): Promise<boolean> {
  try {
    const client = createClientWithKey(apiKey);
    await client.transcripts.list({ limit: 1 });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/401|403|unauthor/i.test(message)) return false;
    // Anything else (network, 500, etc.) — bubble up so the caller can show a
    // real error rather than silently rejecting a valid key.
    throw err;
  }
}

/**
 * List transcripts for a user-supplied key. Walks pagination up to `maxItems`
 * so the dialog UI can show everything in one shot. AAI's pagination uses
 * `before_id` cursors (newest-first).
 */
export async function listTranscriptsForKey(
  apiKey: string,
  maxItems = 100
): Promise<ImportableTranscriptMeta[]> {
  const client = createClientWithKey(apiKey);
  const out: ImportableTranscriptMeta[] = [];
  let beforeId: string | undefined;

  while (out.length < maxItems) {
    const remaining = maxItems - out.length;
    const limit = Math.min(50, remaining);
    const opts: { limit: number; before_id?: string } = { limit };
    if (beforeId) opts.before_id = beforeId;

    const page = (await client.transcripts.list(opts)) as unknown as {
      transcripts?: Array<{
        id: string;
        created?: string;
        status?: string;
        audio_duration?: number | null;
        audio_url?: string | null;
      }>;
      page_details?: { result_count?: number; next_url?: string };
    };

    const items = page.transcripts ?? [];
    if (items.length === 0) break;

    for (const t of items) {
      out.push({
        id: t.id,
        created: t.created ?? null,
        status: t.status ?? 'unknown',
        audio_duration: t.audio_duration ?? null,
        audio_url: t.audio_url ?? null,
      });
      if (out.length >= maxItems) break;
    }

    // No more pages
    if (items.length < limit) break;
    beforeId = items[items.length - 1]!.id;
  }

  return out;
}

export async function getTranscriptForKey(
  apiKey: string,
  transcriptId: string
): Promise<TranscriptResponse> {
  const client = createClientWithKey(apiKey);
  const response = await client.transcripts.get(transcriptId);
  return response as unknown as TranscriptResponse;
}

/**
 * Download audio bytes from an AAI URL with TLS hostname verification
 * disabled. AAI's `cdn.assemblyai.com` is a CNAME to
 * `*.s3-us-west-2.amazonaws.com`, and the cert is for the S3 hostname — so
 * strict clients refuse. We're a server doing a known-target request to a
 * known-trusted vendor; bypassing the SAN check is safe here.
 *
 * Returns null on any failure (404 because AAI deleted the file, 403 because
 * the URL isn't signed any more, network error, etc.) — the caller decides
 * what to do (typically: import metadata anyway, just without audio).
 */
export async function downloadAudioInsecure(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      const u = new NodeURL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        resolve(null);
        return;
      }
      const req = https.request(
        {
          method: 'GET',
          hostname: u.hostname,
          path: u.pathname + u.search,
          port: u.port || 443,
          rejectUnauthorized: false,
          // Modest cap so a runaway redirect doesn't blow up the server.
          timeout: 60_000,
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', () => resolve(null));
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch {
      resolve(null);
    }
  });
}

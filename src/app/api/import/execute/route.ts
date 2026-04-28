import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import {
  createImportedForUser,
  setLocalAudioPathForUser,
  setImportedContentForUser,
} from '@/db-ops/transcripts';
import {
  downloadAudioInsecure,
  getTranscriptForKey,
  validateKey,
} from '@/lib/server/assemblyai-import';
import { audioFilename, saveAudioBytes } from '@/lib/server/audio-storage';
import { getCurrent as getOrgVocab } from '@/db-ops/org-vocab';
import { applyCustomSpellingsToText } from '@/lib/server/vocab-merge';
import type { TranscriptResponse } from '@/lib/format';

export const runtime = 'nodejs';
// Imports can be slow — we fetch each transcript and download its audio.
export const maxDuration = 600;

/**
 * POST /api/import/execute
 *
 * Body: `{ apiKey: string, transcripts: Array<{id, created?}> }`
 *
 * Accepts transcript metadata (especially `created`) from the list step
 * so we can set the correct `created_at` on the imported row. The AAI SDK's
 * `transcripts.get()` doesn't return a `created` field (tested empirically),
 * but `transcripts.list()` does — so the client passes it through.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const apiKey = (body as { apiKey?: unknown })?.apiKey;
  // Accept both old format (transcriptIds: string[]) and new (transcripts: [{id, created}])
  const transcriptsRaw = (body as { transcripts?: unknown })?.transcripts;
  const transcriptIdsRaw = (body as { transcriptIds?: unknown })?.transcriptIds;

  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 256) {
    return NextResponse.json({ error: 'apiKey is required (string)' }, { status: 400 });
  }

  // Build a normalized list from either input shape
  interface ImportItem { id: string; created: string | null }
  let importItems: ImportItem[];

  if (Array.isArray(transcriptsRaw) && transcriptsRaw.length > 0) {
    importItems = transcriptsRaw.map((t: unknown) => {
      const item = t as { id?: unknown; created?: unknown };
      return {
        id: typeof item.id === 'string' ? item.id : '',
        created: typeof item.created === 'string' ? item.created : null,
      };
    }).filter((t) => t.id.length > 0);
  } else if (Array.isArray(transcriptIdsRaw) && transcriptIdsRaw.length > 0) {
    importItems = (transcriptIdsRaw as string[]).filter((s) => typeof s === 'string').map((id) => ({ id, created: null }));
  } else {
    return NextResponse.json(
      { error: 'transcripts (array of {id, created?}) or transcriptIds (string[]) is required' },
      { status: 400 }
    );
  }

  if (importItems.length > 100) {
    return NextResponse.json(
      { error: 'Maximum 100 transcripts per import request' },
      { status: 400 }
    );
  }

  // Re-validate the key once before doing anything.
  try {
    const ok = await validateKey(apiKey);
    if (!ok) {
      return NextResponse.json(
        { error: 'AssemblyAI rejected this key (401/403)' },
        { status: 401 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to reach AssemblyAI', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  // Pull org spellings once for the post-import pass.
  const orgVocab = await getOrgVocab().catch(() => null);
  const spellings = orgVocab?.custom_spelling ?? [];

  type Result =
    | { id: string; ok: true; hasAudio: boolean }
    | { id: string; ok: false; error: string };

  const results: Result[] = [];

  for (const item of importItems) {
    const id = item.id;
    try {
      let content: TranscriptResponse;
      try {
        content = await getTranscriptForKey(apiKey, id);
      } catch (err) {
        results.push({
          id,
          ok: false,
          error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Apply org custom spellings to the imported text in-place.
      if (spellings.length > 0) {
        if (content.text) content.text = applyCustomSpellingsToText(content.text, spellings);
        if (content.utterances) {
          for (const u of content.utterances) {
            u.text = applyCustomSpellingsToText(u.text, spellings);
          }
        }
        if (content.words) {
          for (const w of content.words) {
            w.text = applyCustomSpellingsToText(w.text, spellings);
          }
        }
      }

      const speakerCount = content.utterances
        ? new Set(content.utterances.map((u) => u.speaker)).size
        : null;

      // Use the `created` date from the list step (which the SDK does
      // return) since the get() response doesn't include it.
      const createdAt = item.created ? new Date(item.created) : null;

      const row = await createImportedForUser(user.userId, {
        assemblyaiId: id,
        originalFilename: null,
        status: content.status,
        createdAt: createdAt && !isNaN(createdAt.getTime()) ? createdAt : null,
        completedAt: content.completed ? new Date(content.completed) : null,
        duration: content.audio_duration ?? null,
        speakerCount,
        languageCode: content.language_code ?? null,
        audioUrl: content.audio_url ?? null,
        importedContent: content,
      });

      // Try to grab the audio bytes. AAI deletes audio after some retention
      // window, so this often fails — we treat that as expected and just
      // import the content without playback.
      let hasAudio = false;
      if (content.audio_url) {
        const buf = await downloadAudioInsecure(content.audio_url);
        if (buf && buf.length > 0) {
          try {
            const filename = audioFilename(id, null);
            await saveAudioBytes(filename, buf);
            await setLocalAudioPathForUser(user.userId, id, filename);
            hasAudio = true;
          } catch (err) {
            console.error('[import/execute] saveAudioBytes failed:', err);
          }
        }
      }

      // Persist the spelling-corrected content (if any spellings were applied).
      if (spellings.length > 0) {
        await setImportedContentForUser(user.userId, id, content);
      }

      results.push({ id, ok: true, hasAudio });
      // suppress unused-row warning
      void row;
    } catch (err) {
      results.push({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ results });
});

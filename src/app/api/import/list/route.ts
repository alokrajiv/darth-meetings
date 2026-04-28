import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { listTranscriptsForKey, validateKey } from '@/lib/server/assemblyai-import';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/import/list
 *
 * Body: `{ apiKey: string }`
 *
 * Validates the user-supplied AssemblyAI key and returns up to 100 of their
 * existing transcripts (id, created, status, duration). The key is used in
 * memory for this single request and never persisted, never logged, and
 * never sent to the browser in any response. Caller (the import dialog)
 * keeps it in component state until the user clicks "Import" on
 * `/api/import/execute`.
 */
export const POST = withAuth(async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const apiKey = (body as { apiKey?: unknown })?.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 256) {
    return NextResponse.json({ error: 'apiKey is required (string, 8–256 chars)' }, { status: 400 });
  }

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

  try {
    const transcripts = await listTranscriptsForKey(apiKey, 100);
    return NextResponse.json({ transcripts });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list transcripts', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
});

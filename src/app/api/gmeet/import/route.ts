import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { executeGmeetImport, type ImportBody } from '@/lib/server/gmeet-import-core';
import { kickDeferredImportPoller } from '@/lib/server/deferred-import-poller';

export const runtime = 'nodejs';
// Pulling a multi-GB recording from Drive and re-uploading it to AssemblyAI
// takes a while (only enforced on serverless hosts; the VM ignores it).
export const maxDuration = 900;

/**
 * POST /api/gmeet/import
 *
 * Import a Google Meet meeting picked from the user's calendar. Thin auth +
 * JSON wrapper — the whole import (modes, dedupe, deferral) lives in
 * lib/server/gmeet-import-core so the deferred-import poller can replay
 * queued imports without a browser session.
 */
export const POST = withAuth(async ({ user, request }) => {
  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const result = await executeGmeetImport({ userId: user.userId, email: user.email }, body);
  // Queued (202): start the poller now so a ready-artifact background import
  // begins in seconds rather than on the next interval tick.
  if (result.status === 202) kickDeferredImportPoller();
  return NextResponse.json(result.body, { status: result.status });
});

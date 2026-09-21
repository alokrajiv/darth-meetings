import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveAccess } from '@/db-ops/transcript-access';
import { logActivity } from '@/db-ops/transcript-activity';
import {
  getForUser as getEditsForUser,
  upsertForUser as upsertEditsForUser,
  patchUtteranceForUser,
} from '@/db-ops/transcript-edits';
import { isUtteranceKey } from '@/lib/recording-clips';
import type { TranscriptEditMap } from '@/lib/format';

export const runtime = 'nodejs';

/**
 * Per-utterance edit overrides for a transcript. The raw transcript content
 * is never mutated by anything in this file — these endpoints write only to
 * `transcript_edits`, which is composed with raw at render time on the client.
 *
 * With sharing: collaborators with 'edit' access write to the OWNER's edits
 * row. There is no per-collaborator edit layer — last-write-wins across
 * everyone with access. Read-only collaborators see edits but can't write.
 *
 * KEYS. The map is keyed by whatever `resolveMeetingContent` reports as
 * `utteranceKeys` for the meeting, which is why the validation lives in
 * `lib/recording-clips.ts` next to the code that mints them. For a compat
 * meeting — every row in prod today — that is the plain utterance index this
 * route has always taken, so nothing here changes shape while the flag is
 * on. A multi-clip meeting keys by `<recordingId>:<index>`; GET is a
 * pass-through either way (the client matches the keys it was handed against
 * the keys it stored), so the resolver is not consulted on read.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateEditMap(value: unknown): TranscriptEditMap | null {
  if (!isPlainObject(value)) return null;
  const out: TranscriptEditMap = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isUtteranceKey(key)) return null;
    if (!isPlainObject(raw)) return null;
    const entry: { text?: string; speaker?: string } = {};
    if ('text' in raw) {
      if (typeof raw.text !== 'string') return null;
      entry.text = raw.text;
    }
    if ('speaker' in raw) {
      if (typeof raw.speaker !== 'string') return null;
      entry.speaker = raw.speaker;
    }
    if (entry.text !== undefined || entry.speaker !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

export const GET = withAuth(async ({ user }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await getEditsForUser(access.ownerUserId, id);
  return NextResponse.json({ edits: row?.edits ?? {} });
});

export const PUT = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const map = validateEditMap((body as { edits?: unknown })?.edits);
  if (map === null) {
    return NextResponse.json(
      { error: 'Invalid edits (expected { edits: { "<index>": { text?, speaker? } } })' },
      { status: 400 }
    );
  }

  const row = await upsertEditsForUser(access.ownerUserId, id, map);

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'find_replace',
    details: { entryCount: Object.keys(map).length },
  });

  return NextResponse.json({ edits: row.edits });
});

export const PATCH = withAuth(async ({ user, request }, { params }) => {
  const { id } = await params;

  const access = await resolveAccess(user.userId, user.email, id);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (access.access === 'read') {
    return NextResponse.json({ error: 'Read-only access' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { utteranceIndex, utteranceKey, text, speaker } = (body ?? {}) as {
    utteranceIndex?: unknown;
    utteranceKey?: unknown;
    text?: unknown;
    speaker?: unknown;
  };

  // `utteranceKey` is the general form (what /content's resolver hands the
  // client); `utteranceIndex` is the compat spelling every client sends
  // today and stays the only one accepted for a plain index.
  let key: string;
  if (utteranceKey !== undefined) {
    if (typeof utteranceKey !== 'string' || !isUtteranceKey(utteranceKey)) {
      return NextResponse.json({ error: 'utteranceKey is not a valid utterance key' }, { status: 400 });
    }
    key = utteranceKey;
  } else if (
    typeof utteranceIndex === 'number' &&
    Number.isInteger(utteranceIndex) &&
    utteranceIndex >= 0
  ) {
    key = String(utteranceIndex);
  } else {
    return NextResponse.json(
      { error: 'utteranceIndex must be a non-negative integer' },
      { status: 400 }
    );
  }

  const patch: { text?: string; speaker?: string } = {};
  if (text !== undefined) {
    if (typeof text !== 'string') {
      return NextResponse.json({ error: 'text must be a string' }, { status: 400 });
    }
    patch.text = text;
  }
  if (speaker !== undefined) {
    if (typeof speaker !== 'string') {
      return NextResponse.json({ error: 'speaker must be a string' }, { status: 400 });
    }
    patch.speaker = speaker;
  }

  if (patch.text === undefined && patch.speaker === undefined) {
    return NextResponse.json(
      { error: 'patch must include at least one of: text, speaker' },
      { status: 400 }
    );
  }

  const row = await patchUtteranceForUser(access.ownerUserId, id, key, patch);

  void logActivity({
    transcriptId: access.row.id,
    userId: user.userId,
    email: user.email,
    action: 'edit_text',
    details: { utteranceIndex: /^\d+$/.test(key) ? Number(key) : key },
  });

  return NextResponse.json({ edits: row.edits });
});

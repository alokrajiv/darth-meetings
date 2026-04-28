import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getCurrentPayload, getCurrent, saveAndAppendHistory } from '@/db-ops/org-vocab';
import type { VocabPayload, CustomSpellingEntry } from '@/lib/format';

export const runtime = 'nodejs';

function validateVocab(value: unknown): VocabPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;

  const keytermsRaw = v.keyterms_prompt;
  if (!Array.isArray(keytermsRaw)) return null;
  const keyterms_prompt: string[] = [];
  for (const item of keytermsRaw) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed.length > 0) keyterms_prompt.push(trimmed);
  }

  const customSpellingRaw = v.custom_spelling;
  if (!Array.isArray(customSpellingRaw)) return null;
  const custom_spelling: CustomSpellingEntry[] = [];
  for (const item of customSpellingRaw) {
    if (typeof item !== 'object' || item === null) return null;
    const it = item as Record<string, unknown>;
    if (typeof it.to !== 'string') return null;
    if (!Array.isArray(it.from)) return null;
    if (!it.from.every((s) => typeof s === 'string')) return null;
    custom_spelling.push({ to: it.to, from: it.from as string[] });
  }

  return { keyterms_prompt, custom_spelling };
}

/**
 * GET /api/vocab/org — fetch the current company-wide vocab. Anyone logged
 * into the app can read this; v1 has no admin gate (per the user's "anyone
 * edit is fine" call). Tighten with a scope check later if needed.
 */
export const GET = withAuth(async () => {
  const row = await getCurrent();
  const payload = await getCurrentPayload();
  return NextResponse.json({
    vocab: payload,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  });
});

/**
 * PUT /api/vocab/org — replace the company vocab. Atomically bumps the
 * version, persists the new state, and appends a snapshot to
 * `org_vocab_history` so the full edit history is queryable from the DB.
 * UI is unrestricted; the audit trail lives in the DB.
 */
export const PUT = withAuth(async ({ user, request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const vocab = validateVocab((body as { vocab?: unknown })?.vocab);
  if (!vocab) {
    return NextResponse.json(
      {
        error:
          'Invalid vocab (expected { vocab: { keyterms_prompt: string[], custom_spelling: [{to, from: []}] } })',
      },
      { status: 400 }
    );
  }

  const noteRaw = (body as { note?: unknown })?.note;
  const note = typeof noteRaw === 'string' ? noteRaw : undefined;

  const saved = await saveAndAppendHistory(user.userId, vocab, note);
  return NextResponse.json({
    vocab,
    version: saved.version,
    updated_at: saved.updated_at,
    updated_by: saved.updated_by,
  });
});

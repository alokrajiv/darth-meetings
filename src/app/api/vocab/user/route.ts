import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/with-auth';
import { getForUser, upsertForUser } from '@/db-ops/user-vocab';
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

export const GET = withAuth(async ({ user }) => {
  const vocab = await getForUser(user.userId);
  return NextResponse.json({ vocab });
});

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

  const saved = await upsertForUser(user.userId, vocab);
  return NextResponse.json({ vocab: saved });
});

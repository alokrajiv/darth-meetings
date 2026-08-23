import 'server-only';
import { NextResponse } from 'next/server';
import { LabelPathError } from '@/lib/labels';
import { LabelConflictError, LabelNotFoundError } from '@/db-ops/labels';

/**
 * Map label-layer errors to HTTP (docs/labels-design.md §7): bad path/name/
 * color → 400, missing label/parent → 404, cycle/dup/depth/children → 409.
 * Postgres CHECK / unique violations that slip past validation map the same
 * way so a race never surfaces as a 500. Anything else rethrows.
 */
export function labelErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof LabelPathError) return NextResponse.json({ error: err.message }, { status: 400 });
  if (err instanceof LabelNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
  if (err instanceof LabelConflictError) return NextResponse.json({ error: err.message }, { status: 409 });
  const code = (err as { code?: string } | null)?.code;
  if (code === '23514') return NextResponse.json({ error: 'Invalid label value' }, { status: 400 });
  if (code === '23505') return NextResponse.json({ error: 'A label with that name already exists here' }, { status: 409 });
  return null;
}

/** Parse a positive integer route param / body field; null when not one. */
export function parseIntId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n > 0 ? n : null;
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

import 'server-only';
import { parseMergeOptions } from '@/lib/transcription-merge-plan';
import type { MergeOptions } from '@/lib/transcript-merge';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `POST …/transcriptions/merge` body, parsed — shared by the meeting and recording routes. */
export interface ParsedMergeBody {
  base: string;
  fill: string;
  options: MergeOptions;
  reason: string | null;
  activate: boolean;
  dryRun: boolean;
}

export function parseMergeBody(raw: unknown): { ok: true; body: ParsedMergeBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid JSON body' };
  const b = raw as Record<string, unknown>;
  const base = typeof b.base === 'string' ? b.base.trim() : '';
  const fill = typeof b.fill === 'string' ? b.fill.trim() : '';
  if (!UUID_RE.test(base) || !UUID_RE.test(fill)) {
    return { ok: false, error: 'base and fill must be transcription ids.' };
  }
  const opts = parseMergeOptions(b.options);
  if (!opts.ok) return opts;
  const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '';
  return {
    ok: true,
    body: {
      base,
      fill,
      options: opts.options,
      reason: reason || null,
      activate: b.activate === true,
      dryRun: b.dryRun === true,
    },
  };
}

export const isTranscriptionId = (v: string | undefined): v is string => !!v && UUID_RE.test(v);

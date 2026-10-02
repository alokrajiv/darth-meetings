/**
 * Search INSIDE one meeting — the results panel's `in: <meeting>` scope
 * (README "Darth desktop shell" → "Search in this meeting"). Pure.
 *
 * There is no per-meeting server search (GET /api/search ranks whole
 * meetings), and the meeting page already holds the transcript it renders —
 * with the reader's edits and speaker names applied — so the scoped search
 * runs client-side over exactly what the page shows: an utterance matches
 * when EVERY term of the query occurs in it (case-insensitively, the same
 * terms as the broad search: lib/meeting-search.ts searchTermsOf), like a
 * Slack `in:#channel` search matches messages. Hits keep transcript order;
 * each carries its start time (the jump target) and a snippet with the
 * matched words as bold ranges.
 */

import { buildSnippet, matchRanges, searchTermsOf, type SearchSnippet } from '@/lib/meeting-search';

/** One utterance as the meeting page shows it. */
export interface ScopeUtterance {
  /** Index in the transcript (the page's `data-utterance-index`). */
  index: number;
  /** Milliseconds from the meeting start. */
  startMs: number;
  /** The speaker's display name (custom name, else "Speaker A"). */
  speaker: string;
  /** The text as shown (edited view: the reader's edits applied). */
  text: string;
}

export interface ScopeHit {
  index: number;
  startMs: number;
  speaker: string;
  snippet: SearchSnippet;
}

export interface ScopeSearchResult {
  terms: string[];
  hits: ScopeHit[];
  /** Matching utterances in total (hits stop at the limit). */
  total: number;
}

export const SCOPE_HIT_LIMIT = 200;

export function searchInMeeting(
  utterances: readonly ScopeUtterance[],
  query: string,
  limit = SCOPE_HIT_LIMIT
): ScopeSearchResult {
  const terms = searchTermsOf(query);
  if (terms.length === 0) return { terms, hits: [], total: 0 };
  const lowered = terms.map((t) => t.toLowerCase());
  const hits: ScopeHit[] = [];
  let total = 0;
  for (const u of utterances) {
    const text = u.text ?? '';
    const lower = text.toLowerCase();
    // Fast reject on the lower-cased copy, then the real ranges on the text.
    if (!lowered.every((t) => lower.includes(t))) continue;
    if (!terms.every((t) => matchRanges(text, [t]).length > 0)) continue;
    total += 1;
    if (hits.length >= limit) continue;
    hits.push({
      index: u.index,
      startMs: u.startMs,
      speaker: u.speaker,
      snippet: buildSnippet(text, terms, { windowAtStart: true, windowAtEnd: true }),
    });
  }
  return { terms, hits, total };
}

import 'server-only';
import type { VocabPayload } from '@/lib/format';

/**
 * Merge user + org vocab into the shape AssemblyAI accepts on submit.
 *
 * Since AAI retired `word_boost` (2026-Q2), the replacement `keyterms_prompt`
 * is a flat string array with no per-entry weights and no global boost.
 * Limits per the AAI docs:
 *   - up to 1000 terms
 *   - max 6 words per term
 *
 * Dedupe rules:
 *   - keyterms_prompt: case-insensitive on the term; org entries take precedence.
 *   - custom_spelling: case-insensitive on `to`; `from` arrays union on
 *     conflict so a user adding more variants for the same canonical
 *     spelling enriches the org entry instead of replacing it.
 *
 * Cap: 1000 terms. Org wins on priority because the company glossary is
 * the more curated list.
 */

export interface MergedVocab {
  keyterms_prompt: string[];
  custom_spelling: Array<{ to: string; from: string[] }>;
}

const MAX_TERMS = 1000;
const MAX_WORDS_PER_TERM = 6;

function isValidTerm(term: string): boolean {
  const trimmed = term.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.split(/\s+/).length > MAX_WORDS_PER_TERM) return false;
  return true;
}

export function mergeVocabs(org: VocabPayload, user: VocabPayload): MergedVocab {
  const seen = new Set<string>();
  const keyterms: string[] = [];

  for (const source of [org, user]) {
    for (const entry of source.keyterms_prompt) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (!isValidTerm(trimmed)) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      keyterms.push(trimmed);
      if (keyterms.length >= MAX_TERMS) break;
    }
    if (keyterms.length >= MAX_TERMS) break;
  }

  const spellingByTo = new Map<string, { to: string; from: Set<string> }>();
  for (const source of [org, user]) {
    for (const entry of source.custom_spelling) {
      const toClean = entry.to.trim();
      if (!toClean) continue;
      const key = toClean.toLowerCase();
      const existing = spellingByTo.get(key);
      if (existing) {
        for (const f of entry.from) {
          const fc = f.trim();
          if (fc) existing.from.add(fc);
        }
      } else {
        spellingByTo.set(key, {
          to: toClean,
          from: new Set(entry.from.map((f) => f.trim()).filter(Boolean)),
        });
      }
    }
  }

  return {
    keyterms_prompt: keyterms,
    custom_spelling: Array.from(spellingByTo.values()).map((e) => ({
      to: e.to,
      from: Array.from(e.from),
    })),
  };
}

/**
 * Apply a list of custom spellings as a plain string-replace pass to a piece
 * of text. Used by the post-import flow so imported transcripts benefit from
 * the company glossary even though we can't re-run them through AAI.
 *
 * Case-insensitive match, longest-from-first to avoid partial overwrites.
 */
export function applyCustomSpellingsToText(
  text: string,
  spellings: Array<{ to: string; from: string[] }>
): string {
  if (!text) return text;
  const pairs: Array<[string, string]> = [];
  for (const s of spellings) {
    for (const f of s.from) {
      const fc = f.trim();
      if (fc) pairs.push([fc, s.to]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);

  let result = text;
  for (const [from, to] of pairs) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), to);
  }
  return result;
}

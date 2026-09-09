import { describe, expect, test } from 'bun:test';
import { keytermsSupported } from '@/lib/aai-language';

describe('keytermsSupported (AAI keyterms_prompt is English-only)', () => {
  test('English variants and unset language keep the bias list', () => {
    for (const lc of [undefined, null, '', 'en', 'en_us', 'en_uk', 'en_au', 'EN_US']) {
      expect(keytermsSupported(lc)).toBe(true);
    }
  });
  test('non-English languages drop it (AAI 400s the whole submit otherwise)', () => {
    for (const lc of ['zh', 'es', 'fr', 'de', 'ja', 'ko', 'ms', 'id']) {
      expect(keytermsSupported(lc)).toBe(false);
    }
  });
});

/**
 * "Is this the same person?" for free-text speaker names — the ONE rule the
 * voiceprint margin guard, the speaker-ID merge and the voiceprint rebuild
 * all read. Pure, client-safe.
 *
 * Why it exists (2026-09-24 diagnosis): names reach us in several spellings
 * of one human — a directory login ("karnica.katiyar"), a typed name
 * ("Karnica Katiyar"), a first name ("Ivan" / "Ivan Seow"), and once with a
 * zero-width space pasted inside ("shridhar.​tirthkar"). Treating those as
 * rival candidates made the margin guard reject a 0.96 voice match because
 * the same person's other row scored 0.92, and let the ID pass "overrule" a
 * correct voice hint with another spelling of the same name.
 */

/** Lowercase, invisible characters gone, dots/underscores/hyphens → spaces, one space between words. */
export function personNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .toLowerCase()
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The key a COMPARISON reads: `personNameKey` with calendar decorations gone —
 * "(EXT)", "[Danone]" and the like. Not used for stored name_keys (those stay
 * `personNameKey`, so enrolled rows keep their identity).
 */
function comparableKey(name: string): string {
  return personNameKey(name.replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));
}

/**
 * Same human under two spellings? Equal keys, spacing-only difference, the
 * same words in another order ("CHUNG Joey" on a Danone invite is "Joey
 * Chung" — surname-first corporate directories), prefix, or same first name.
 */
export function samePerson(a: string, b: string): boolean {
  const na = comparableKey(a);
  const nb = comparableKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return true; // "LiXuan" / "Li Xuan"
  const ta = na.split(' ');
  const tb = nb.split(' ');
  if (ta.length > 1 && ta.length === tb.length && [...ta].sort().join(' ') === [...tb].sort().join(' ')) {
    return true; // "chung joey" / "joey chung"
  }
  if (na.startsWith(nb) || nb.startsWith(na)) return true; // "ivan seow" / "ivan"
  return ta[0] === tb[0]; // same first name
}

/**
 * Is `name` one of the people on `roster` (calendar invitees, the call's
 * counterpart, the recording owner)? `samePerson` against each entry.
 */
export function onRoster(name: string, roster: readonly string[]): boolean {
  return roster.some((r) => samePerson(r, name));
}

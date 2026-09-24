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

/** Same human under two spellings? Equal keys, spacing-only difference, prefix, or same first name. */
export function samePerson(a: string, b: string): boolean {
  const na = personNameKey(a);
  const nb = personNameKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.replace(/ /g, '') === nb.replace(/ /g, '')) return true; // "LiXuan" / "Li Xuan"
  if (na.startsWith(nb) || nb.startsWith(na)) return true; // "ivan seow" / "ivan"
  return na.split(' ')[0] === nb.split(' ')[0]; // same first name
}

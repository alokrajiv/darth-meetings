import { personNameKey } from '@/lib/person-identity';

/**
 * A speaker is a PERSON (an email), not a name string (2026-10-27, phase 1).
 *
 * Until now `SpeakerLabel` carried a name only, so "Test Person A" and
 * "Test Person A Middle" were two people and a colleague sharing a customer's
 * name was one. This module is the pure half of attaching the person:
 *
 *  - `matchEmailByName`: the ONE rule for turning a name into an email — an
 *    exact match against the candidates (invitees, directory), or a
 *    "First Last" prefix of exactly one longer name; two candidates → null,
 *    never a guess.
 *  - `canonicalSpeakerName`: which spelling a label with an email stores. A
 *    name the client SENT is kept as is — the email is identity only, never a
 *    rename: voiceprints are keyed by the name's spelling (`personNameKey`,
 *    which does not fold spacing inside a name), and the directory spelling
 *    differs from the enrolled one for a good share of the heaviest prints,
 *    so "canonicalising" would start a new print and split a voice. Only a
 *    label with NO name (`A=email`) gets one: the same-email suggestion's
 *    spelling (it came from the print) → directory → invitee → local part.
 *
 * The server half (lib/server/speaker-identity.ts) looks the directory up and
 * creates the custom person row; the CLI parses `A=email`, `A="Name <email>"`.
 * Re-keying voiceprints by email is a later, separate migration — by an alias
 * (print ↔ email), never by renaming, for the same spelling reason.
 */

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Lower-cased, trimmed; '' for nothing. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

/** A plausible address — enough to refuse "Name" where an email was expected. */
export function isEmailShape(raw: string | null | undefined): boolean {
  const e = normalizeEmail(raw);
  return e.length >= 5 && EMAIL_RE.test(e);
}

export interface NamedEmail {
  name: string | null | undefined;
  email: string | null | undefined;
}

/**
 * The email of the ONE candidate the name points at, or null.
 *
 * Candidates are de-duplicated by email first (the same person listed twice
 * is not an ambiguity). Then, on `personNameKey` spellings:
 *   1. exactly one candidate with the same key → that email;
 *   2. none exact, the name has two or more words, and exactly one candidate's
 *      key begins with `<name> ` (a longer directory name, "First Last" vs
 *      "First Middle Last") → that email;
 *   3. anything else (no match, two or more matches, a one-word name against
 *      longer names) → null.
 */
export function matchEmailByName(name: string, candidates: ReadonlyArray<NamedEmail>): string | null {
  const key = personNameKey(name ?? '');
  if (!key) return null;
  const byEmail = new Map<string, string>();
  for (const c of candidates) {
    const email = normalizeEmail(c.email);
    if (!isEmailShape(email) || byEmail.has(email)) continue;
    byEmail.set(email, personNameKey(c.name ?? ''));
  }
  const exact = [...byEmail].filter(([, k]) => k === key).map(([e]) => e);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  if (!key.includes(' ')) return null;
  const longer = [...byEmail].filter(([, k]) => k.startsWith(`${key} `)).map(([e]) => e);
  return longer.length === 1 ? longer[0]! : null;
}

export interface CanonicalNameInput {
  /** What the client sent (empty for `A=email`). Non-empty = kept as is. */
  sent: string | null | undefined;
  /** The speaker's current suggestion name, only when that suggestion
   * carries the SAME email — the spelling the voiceprint knows. */
  suggestionName?: string | null;
  /** The directory's name for the email, when a row exists. */
  directoryName?: string | null;
  /** This meeting's invitee name for the email, when on the invite. */
  inviteeName?: string | null;
}

/**
 * The display name a label with an email stores. A sent name wins outright
 * (the email never renames). With no sent name: the same-email suggestion →
 * directory → invitee → (last resort) the email's local part, so a directory
 * row can always be created with SOME name.
 */
export function canonicalSpeakerName(input: CanonicalNameInput, email: string): string {
  for (const n of [input.sent, input.suggestionName, input.directoryName, input.inviteeName]) {
    const t = (n ?? '').trim();
    if (t) return t;
  }
  return normalizeEmail(email).split('@')[0] ?? '';
}

/** The invitees as match candidates, names filled from the directory when the invite had none. */
export function inviteeCandidates(
  attendees: ReadonlyArray<{ email: string; name?: string | null }> | null | undefined,
  directoryNames: ReadonlyMap<string, string> = new Map()
): NamedEmail[] {
  return (attendees ?? []).map((a) => ({
    email: a.email,
    name: a.name?.trim() || directoryNames.get(normalizeEmail(a.email)) || null,
  }));
}

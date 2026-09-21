/**
 * People are people (docs/listing-ui-redesign.md §2.6): the Owner and
 * Organizer columns show an initials avatar + a first name, never a
 * truncated e-mail. Pure — used by the listing and its tests.
 */

export interface PersonDisplay {
  /** "Juhi Sharma" — from the name when known, else from the e-mail local part. */
  full: string;
  /** "Juhi" — what the column shows. */
  first: string;
  /** "JS" — the avatar. */
  initials: string;
  /** Full e-mail for the tooltip (may be empty). */
  email: string;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "juhi.sharma" / "antonius_hariyanto" / "kawen-koh" → ["Juhi","Sharma"]. */
function wordsFromLocalPart(local: string): string[] {
  return local
    .split(/[._\-+]+/)
    .map((w) => w.replace(/\d+$/, ''))
    .filter(Boolean)
    .map((w) => cap(w.toLowerCase()));
}

export function personDisplay(
  email: string | null | undefined,
  name?: string | null
): PersonDisplay {
  const mail = (email ?? '').trim();
  const nm = (name ?? '').trim();
  let words: string[] = [];
  if (nm && !nm.includes('@')) {
    words = nm.split(/\s+/).filter(Boolean);
  } else if (mail) {
    words = wordsFromLocalPart(mail.split('@')[0] ?? '');
  }
  if (words.length === 0) {
    return { full: mail || '—', first: mail || '—', initials: mail ? mail.charAt(0).toUpperCase() : '?', email: mail };
  }
  const full = words.join(' ');
  const first = words[0]!;
  const initials =
    words.length >= 2
      ? `${words[0]!.charAt(0)}${words[words.length - 1]!.charAt(0)}`.toUpperCase()
      : first.slice(0, 2).toUpperCase();
  return { full, first, initials, email: mail };
}

/**
 * A stable hue for an avatar, so the same person is always the same colour
 * across rows. Returns 0..359. Pure string hash — no crypto.
 */
export function personHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

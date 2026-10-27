import 'server-only';
import { createCustomPerson, findPeopleByEmails, findPersonByEmail, searchPeople } from '@/db-ops/people';
import { setSuggestionsForUser } from '@/db-ops/speaker-mappings';
import { getForUser } from '@/db-ops/transcripts';
import {
  canonicalSpeakerName,
  inviteeCandidates,
  isEmailShape,
  matchEmailByName,
  normalizeEmail,
} from '@/lib/speaker-identity';
import type { GmeetAttendee, SpeakerLabel, SpeakerSuggestionMap } from '@/lib/format';

/**
 * The server half of "a speaker is a person" (lib/speaker-identity.ts has
 * the rules): directory lookups, the custom-person row, and the one place
 * suggestions get their email before they are stored.
 */

export interface ResolveIdentityOpts {
  attendees: ReadonlyArray<GmeetAttendee> | null | undefined;
  /** The meeting's current suggestions — a same-email guess lends its
   * spelling to a nameless `A=email` label. */
  suggestions?: SpeakerSuggestionMap | null;
  createdBy: string;
}

/**
 * Labels as the PUT …/speakers route stores them. A label with an email is
 * normalised; its `customName` is KEPT when the client sent one (the email
 * is identity only — renaming to the directory spelling would start a new
 * name-keyed voiceprint). A nameless label (`A=email`) gets a name: the
 * speaker's own suggestion when it carries the same email → directory row
 * (`findPersonByEmail`) → this meeting's invitee → the email's local part.
 * Either way, when no directory row exists one is created with the kept
 * name, exactly as the "+ Person" dialog's POST does; an email that already
 * belongs to someone (a race with another writer) reuses that record — a
 * second one is never forked. Labels without an email, and labels whose
 * email is not an address, pass through (the latter with the bad value
 * dropped — the route already refused it with a 400 when sent).
 *
 * Best-effort per label: a directory failure keeps the name and logs.
 */
export async function resolveLabelIdentities(
  labels: ReadonlyArray<SpeakerLabel>,
  opts: ResolveIdentityOpts
): Promise<SpeakerLabel[]> {
  const out: SpeakerLabel[] = [];
  for (const l of labels) {
    const email = normalizeEmail(l.email);
    if (!email || !isEmailShape(email)) {
      const { email: _dropped, ...rest } = l; // eslint-disable-line @typescript-eslint/no-unused-vars
      out.push(rest);
      continue;
    }
    const suggestion = opts.suggestions?.[l.originalSpeaker];
    const suggestionName = suggestion?.email && normalizeEmail(suggestion.email) === email ? suggestion.name : null;
    const name = await nameAndDirectoryRow(email, { sent: l.customName, suggestionName }, opts).catch((err) => {
      console.warn(`[speaker-identity] directory lookup failed for ${email}:`, err);
      return canonicalSpeakerName({ sent: l.customName, suggestionName }, email);
    });
    out.push({ ...l, customName: name, email });
  }
  return out;
}

/** The name to store, with the directory row ensured. */
async function nameAndDirectoryRow(
  email: string,
  input: { sent: string; suggestionName: string | null },
  opts: ResolveIdentityOpts
): Promise<string> {
  const inviteeName = opts.attendees?.find((a) => normalizeEmail(a.email) === email)?.name ?? null;
  const person = await findPersonByEmail(email);
  if (person) return canonicalSpeakerName({ ...input, directoryName: person.name, inviteeName }, email);
  const name = canonicalSpeakerName({ ...input, inviteeName }, email);
  try {
    await createCustomPerson({ name, email, createdBy: opts.createdBy });
    return name;
  } catch (err) {
    // The email became taken between the lookup and the INSERT: use what is
    // there now — never a second record for one address.
    const now = await findPersonByEmail(email);
    if (now) return canonicalSpeakerName({ ...input, directoryName: now.name, inviteeName }, email);
    throw err;
  }
}

/**
 * Suggestions with their person attached where the name points at exactly
 * one invitee (names filled from the directory when the invite had none),
 * else exactly one directory person (`searchPeople` by the name, matched
 * with the same rule). Ambiguous → no email. Suggestions that already carry
 * one are left alone; nothing else about them changes.
 */
export async function attachSuggestionEmails(
  suggestions: SpeakerSuggestionMap,
  attendees: ReadonlyArray<GmeetAttendee> | null | undefined
): Promise<SpeakerSuggestionMap> {
  const pending = Object.entries(suggestions).filter(([, s]) => s?.name?.trim() && !s.email);
  if (pending.length === 0) return suggestions;

  let directoryNames = new Map<string, string>();
  const emails = (attendees ?? []).map((a) => a.email).filter(Boolean);
  if (emails.length > 0) {
    try {
      const people = await findPeopleByEmails(emails);
      directoryNames = new Map([...people].map(([e, p]) => [e, p.name]));
    } catch (err) {
      console.warn('[speaker-identity] invitee directory lookup failed (continuing):', err);
    }
  }
  const invitees = inviteeCandidates(attendees, directoryNames);

  const out: SpeakerSuggestionMap = { ...suggestions };
  for (const [speaker, s] of pending) {
    let email = matchEmailByName(s.name, invitees);
    let emailSource: 'invite' | 'directory' = 'invite';
    if (!email) {
      try {
        const people = await searchPeople(s.name, 10);
        email = matchEmailByName(s.name, people);
        emailSource = 'directory';
      } catch (err) {
        console.warn(`[speaker-identity] directory search failed for a suggestion:`, err);
      }
    }
    if (email) out[speaker] = { ...s, email, emailSource };
  }
  return out;
}

/**
 * `setSuggestionsForUser` with the person attached first — the one write
 * path the ID pass, the notes-time context guess and the voice matcher all
 * use, so every stored suggestion carries its email when it is unambiguous.
 * Reads the row for the invitees; a failed attach stores the suggestions as
 * they were (names were never the thing at risk).
 */
export async function setSuggestionsWithIdentity(
  ownerUserId: string,
  assemblyaiId: string,
  suggestions: SpeakerSuggestionMap
): Promise<void> {
  let withEmails = suggestions;
  try {
    const row = await getForUser(ownerUserId, assemblyaiId);
    withEmails = await attachSuggestionEmails(suggestions, row?.gmeet_context?.attendees);
  } catch (err) {
    console.warn(`[speaker-identity] attaching emails failed for ${assemblyaiId} (storing names only):`, err);
  }
  await setSuggestionsForUser(ownerUserId, assemblyaiId, withEmails);
}

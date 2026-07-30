import 'server-only';
import {
  getForUser as getSpeakerMapping,
  upsertForUser as upsertSpeakerMapping,
} from '@/db-ops/speaker-mappings';
import { createCustomPerson, findPersonByEmail } from '@/db-ops/people';
import type { GmeetAttendee, MeetParticipantInfo, SpeakerLabel } from '@/lib/format';

/**
 * Shared helpers for transcript imports that arrive with REAL speaker names
 * (Google Meet, Teams exports, …): name→email matching, immediate speaker
 * mappings, and people-directory enrichment.
 */

/** "Chaitanya Konkar" / "chaitanya.konkar@…" → "chaitanyakonkar" */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

/** "chaitanya.konkar@x" → "Chaitanya Konkar" — last-resort display name. */
export function humanizeLocalPart(email: string): string {
  const local = email.split('@')[0] ?? '';
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
  return name || email;
}

/**
 * Best-effort display-name → email map. Priority: actual participants with
 * People-API-resolved emails, then attendee display names, then the
 * email local-part heuristic (chaitanya.konkar@ ↔ "Chaitanya Konkar").
 */
export function buildEmailByName(
  attendees: GmeetAttendee[],
  participants: MeetParticipantInfo[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of attendees) {
    const local = a.email.split('@')[0] ?? '';
    const key = normName(local);
    if (key && !map.has(key)) map.set(key, a.email.toLowerCase());
  }
  for (const a of attendees) {
    if (!a.name) continue;
    const key = normName(a.name);
    if (key) map.set(key, a.email.toLowerCase());
  }
  for (const p of participants ?? []) {
    if (!p.email) continue;
    const key = normName(p.displayName);
    if (key) map.set(key, p.email.toLowerCase());
  }
  return map;
}

/**
 * Directory enrichment: EVERY email discovered during an import (invitees +
 * actual participants) gets registered in the people directory if it isn't
 * known yet, with the best name available. Existing entries (Trames
 * directory or custom) are never touched.
 */
export async function registerPeopleFromMeeting(
  candidates: Array<{ email: string; name?: string | null }>,
  createdBy: string
): Promise<void> {
  const seen = new Set<string>();
  for (const c of candidates) {
    const email = c.email.trim().toLowerCase();
    if (!email.includes('@') || email.endsWith('.calendar.google.com') || seen.has(email)) {
      continue;
    }
    seen.add(email);
    try {
      const existing = await findPersonByEmail(email);
      if (!existing) {
        await createCustomPerson({
          name: c.name?.trim() || humanizeLocalPart(email),
          email,
          createdBy,
        });
      }
    } catch (err) {
      console.warn('[import] people registration failed for', email, err);
    }
  }
}

/**
 * Imports with real speaker names: map every speaker immediately (so the
 * panel never shows "Unnamed · <name>") and register anyone we can resolve
 * an email for into the people directory. Never clobbers mappings a user
 * already made (force re-imports).
 */
export async function autoNameSpeakers(
  userId: string,
  assemblyaiId: string,
  speakerNames: string[],
  attendees: GmeetAttendee[],
  participants: MeetParticipantInfo[] | undefined
): Promise<void> {
  const existing = await getSpeakerMapping(userId, assemblyaiId);
  if (existing && existing.speaker_labels.length > 0) return;

  const emailByName = buildEmailByName(attendees, participants);
  const labels: SpeakerLabel[] = speakerNames.map((name) => {
    const email = emailByName.get(normName(name));
    return {
      originalSpeaker: name,
      customName: name,
      description: email
        ? `${email} · auto-matched from the source transcript`
        : 'auto-added from the source transcript',
    };
  });
  await upsertSpeakerMapping(userId, assemblyaiId, labels);

  for (const name of speakerNames) {
    const email = emailByName.get(normName(name));
    if (!email) continue;
    try {
      const person = await findPersonByEmail(email);
      if (!person) {
        await createCustomPerson({ name, email, createdBy: userId });
      }
    } catch (err) {
      console.warn('[import] people registration failed for', email, err);
    }
  }
}

/**
 * A speaker is a person (2026-10-27, phase 1) — the WIRING, pinned from
 * source (the rules are pure and tested in lib/__tests__/speaker-identity.test.ts):
 *
 *  - PUT …/speakers refuses a malformed email with a 400, resolves the
 *    canonical name + directory row BEFORE the upsert, and every follow-up
 *    (settle, enrol, reply) reads the RESOLVED labels;
 *  - the resolver never forks a second directory record for one address;
 *  - every writer of suggestions (ID pass, notes-time context guess, voice
 *    matcher) goes through the one identity-attaching write path;
 *  - the auto-review evaluator carries the suggestion's email onto the
 *    applied label.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('PUT …/speakers', () => {
  const src = read('app/api/transcripts/[id]/speakers/route.ts');

  test('validateLabels: an email must look like one, else the whole body is a 400', () => {
    const fn = src.slice(src.indexOf('function validateLabels('), src.indexOf('\n}\n', src.indexOf('function validateLabels(')));
    expect(fn).toContain("if (typeof email !== 'string' || !isEmailShape(email)) return null;");
    expect(fn).toContain('email: normalizeEmail(email)');
  });

  test('resolve before the upsert; settle, enrol and the reply use the resolved labels', () => {
    const put = src.slice(src.indexOf('export const PUT = withAuth('));
    const resolve = put.indexOf('await resolveLabelIdentities(sent, {');
    const upsert = put.indexOf('await upsertMappingsForUser(access.ownerUserId, id, labels)');
    expect(resolve).toBeGreaterThan(0);
    expect(upsert).toBeGreaterThan(resolve);
    expect(put).toContain('createdBy: user.userId');
    expect(put).toContain('attendees: access.row.gmeet_context?.attendees');
    // The suggestions are read only when a nameless `A=email` label needs a spelling.
    expect(put).toContain('suggestions: sent.some((l) => l.email && !l.customName.trim())');
    expect(put).toContain('settleSpeakerIdAfterNaming(access.ownerUserId, access.row, labels, content)');
    expect(put).toMatch(/enrollFromTranscript\([^;]*, content, labels\)/);
    expect(put).toContain('return NextResponse.json({ speakerLabels: row.speaker_labels });');
  });
});

describe('resolveLabelIdentities', () => {
  const src = read('lib/server/speaker-identity.ts');

  test('the sent name is kept (canonicalSpeakerName puts `sent` first); the same-email suggestion lends its spelling to a nameless label', () => {
    const pure = read('lib/speaker-identity.ts');
    expect(pure).toContain('for (const n of [input.sent, input.suggestionName, input.directoryName, input.inviteeName])');
    const fn = src.slice(src.indexOf('export async function resolveLabelIdentities('), src.indexOf('\n/** The name to store'));
    expect(fn).toContain("const suggestionName = suggestion?.email && normalizeEmail(suggestion.email) === email ? suggestion.name : null;");
    expect(fn).toContain('if (!email || !isEmailShape(email)) {');
    expect(fn).toContain('out.push({ ...l, customName: name, email });');
  });

  test('the directory row is ensured with the kept name; a taken email reuses the record, never a second one', () => {
    const fn = src.slice(src.indexOf('async function nameAndDirectoryRow('), src.indexOf('\n}\n', src.indexOf('async function nameAndDirectoryRow(')));
    const lookup = fn.indexOf('await findPersonByEmail(email)');
    const create = fn.indexOf('await createCustomPerson({ name, email, createdBy: opts.createdBy })');
    const retry = fn.indexOf('const now = await findPersonByEmail(email);');
    expect(lookup).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(lookup);
    expect(retry).toBeGreaterThan(create);
    expect(fn).toContain('canonicalSpeakerName({ ...input, directoryName: person.name, inviteeName }, email)');
    expect(fn).toContain('canonicalSpeakerName({ ...input, inviteeName }, email)');
    expect(fn).toContain('canonicalSpeakerName({ ...input, directoryName: now.name, inviteeName }, email)');
  });
});

describe('suggestions carry the person', () => {
  test('the ID pass, the notes-time guess and the voice matcher all write through setSuggestionsWithIdentity', () => {
    const notes = read('lib/server/auto-notes.ts');
    expect(notes).toContain("import { setSuggestionsWithIdentity as setSuggestionsForUser } from '@/lib/server/speaker-identity';");
    // …and neither file still imports the raw db-op under any name.
    expect(notes).not.toMatch(/import \{[^}]*\bsetSuggestionsForUser\b[^}]*\} from '@\/db-ops\/speaker-mappings'/);
    expect(read('lib/server/voiceprint.ts')).not.toMatch(/import \{[^}]*\bsetSuggestionsForUser\b[^}]*\} from '@\/db-ops\/speaker-mappings'/);
    expect(notes.match(/await setSuggestionsForUser\(/g)?.length).toBe(2);
    const voice = read('lib/server/voiceprint.ts');
    expect(voice).toContain("import { setSuggestionsWithIdentity as setSuggestionsForUser } from '@/lib/server/speaker-identity';");
    expect(voice).toContain('await setSuggestionsForUser(ownerUserId, assemblyaiId, merged);');
  });

  test('attach: invitees first (directory names fill gaps), then a unique directory person; already-emailed suggestions untouched', () => {
    const src = read('lib/server/speaker-identity.ts');
    const fn = src.slice(src.indexOf('export async function attachSuggestionEmails('), src.indexOf('export async function setSuggestionsWithIdentity('));
    expect(fn).toContain("filter(([, s]) => s?.name?.trim() && !s.email)");
    expect(fn.indexOf('matchEmailByName(s.name, invitees)')).toBeLessThan(fn.indexOf('await searchPeople(s.name, 10)'));
    expect(fn).toContain('matchEmailByName(s.name, people)');
    expect(fn).toContain('if (email) out[speaker] = { ...s, email };');
  });
});

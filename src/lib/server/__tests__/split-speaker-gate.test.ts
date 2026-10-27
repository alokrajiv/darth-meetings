/**
 * Split vs the speaker-ID pass (2026-10-27). A meeting made from a recording,
 * split within the same minute, then fully named via the CLI left three
 * halves stuck on "Identifying speakers first…" for 30 min: each half was
 * born with the source's `speaker_id_status = 'running'`, no pass ever runs
 * for a half, and naming everyone did not settle the status.
 *
 * The decisions are pure and tested on their own (`splitPrecondition`,
 * `childSpeakerIdStatus` in lib/__tests__/clips.test.ts; `shouldSettleSpeakerId`
 * in lib/__tests__/speaker-id-settle.test.ts). What these tests pin is the
 * WIRING — the source order that makes the rule hold:
 *   - the route refuses from the same precondition the ⋯ menu greys out on,
 *     and it does so BEFORE the first write (`createForUser`);
 *   - the half's status comes from `childSpeakerIdStatus`, and nothing in
 *     clip-split writes 'running' to any row;
 *   - the speakers PUT settles the pass right after saving the labels and
 *     before answering, without generating notes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

describe('POST …/split refuses while the speaker pass runs — before anything is written', () => {
  const src = read('lib/server/clip-split.ts');

  test('the precondition the menu and the route share reads speaker_id_status', () => {
    const pre = between(src, 'async function splitPreconditionFor(', '\n}\n');
    expect(pre).toContain("speakerIdRunning: row.speaker_id_status === 'running'");
  });

  test('splitMeeting checks the precondition before the first write', () => {
    const fn = between(src, 'export async function splitMeeting(', '\n}\n');
    const check = fn.indexOf('await splitPreconditionFor(row, state)');
    const refuse = fn.indexOf('if (blocked) return refuse(blocked)');
    const firstWrite = fn.indexOf('await createForUser(');
    expect(check).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(check);
    expect(firstWrite).toBeGreaterThan(refuse);
    // Nothing else writes before the check either.
    for (const write of ['applyMeetingClips(', 'copySpeakerMappings(', 'setSpeakerIdForUser(', 'setClipMirror(']) {
      const i = fn.indexOf(write);
      if (i >= 0) expect(i).toBeGreaterThan(refuse);
    }
  });

  test('the refusal is {error: sentence, code} like every other split refusal', () => {
    const refuse = between(src, 'function refuse<T>(', '\n}\n');
    expect(refuse).toContain('error: refusal.message');
    expect(refuse).toContain('code: refusal.code');
    expect(refuse).not.toContain('message:');
    const clips = read('lib/clips.ts');
    expect(clips).toContain("if (input.speakerIdRunning) return splitRefusal('speaker_check_running')");
  });

  test("the half's status comes from childSpeakerIdStatus; clip-split never writes 'running'", () => {
    expect(src).toContain('childSpeakerIdStatus(row.speaker_id_status, speakerRows.length)');
    expect(src).not.toMatch(/setSpeakerIdForUser\([^)]*'running'/);
    expect(src).not.toContain("status: 'running'");
  });
});

describe('PUT …/speakers settles the pass once everyone is named', () => {
  const src = read('app/api/transcripts/[id]/speakers/route.ts');

  test('after the upsert, before the reply, with the one content read', () => {
    const put = src.slice(src.indexOf('export const PUT = withAuth('));
    const upsert = put.indexOf('await upsertMappingsForUser(');
    const content = put.indexOf('await getContentCached(access.ownerUserId, access.row)');
    const settle = put.indexOf('await settleSpeakerIdAfterNaming(access.ownerUserId, access.row, labels, content)');
    const reply = put.indexOf('return NextResponse.json({ speakerLabels');
    expect(upsert).toBeGreaterThan(0);
    expect(content).toBeGreaterThan(upsert);
    expect(settle).toBeGreaterThan(content);
    expect(reply).toBeGreaterThan(settle);
    // One read serves both the settle and the voiceprint enrollment.
    expect(put.match(/getContentCached\(/g)?.length).toBe(1);
  });

  test('the settle writes completed through the status-machine helper and starts no notes run', () => {
    const settle = read('lib/server/speaker-id-settle.ts');
    expect(settle).toContain("setSpeakerIdForUser(ownerUserId, row.assemblyai_id, { status: 'completed', error: null })");
    expect(settle).not.toContain('generateAutoReport');
    expect(settle).not.toContain('generateAutoNotes');
    expect(settle).not.toContain('identifySpeakers');
    expect(src).not.toContain('generateAutoReport');
  });
});

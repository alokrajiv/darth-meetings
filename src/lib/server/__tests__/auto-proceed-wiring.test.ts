/**
 * Grace-window auto-proceed (2026-10-27) — the WIRING, pinned from source.
 * The decisions are pure and tested on their own (lib/__tests__/
 * auto-review-eval.test.ts, auto-proceed.test.ts); what these tests hold is:
 *
 *  - the series / account path (`maybeAutoReview`) behaves as before: marker
 *    required, evaluated once, the same two DMs with the same dedupe keys,
 *    enrols every name as it always did;
 *  - the grace path re-checks eligibility on the fresh row before any write,
 *    stamps mode 'grace', enrols only the strict subset, DMs once on success
 *    and never on a block;
 *  - the sweeper's pick is the SQL twin of the TS rule — the same predicate
 *    list, one line each — and runs under the shared per-sweep cap;
 *  - the detail GET exposes `autoProceedAt` from the same helper; the hold
 *    route checks access before it writes, writes `mode: 'held'`, and
 *    answers 409 once the summary was already written.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const fnBody = (src: string, head: string) => {
  const a = src.indexOf(head);
  expect(a, head).toBeGreaterThan(0);
  const b = src.indexOf('\n}\n', a);
  return src.slice(a, b);
};

describe('maybeAutoReview — the series / account path is unchanged', () => {
  const src = read('lib/server/auto-review.ts');
  const fn = fnBody(src, 'export async function maybeAutoReview(');

  test('marker required; evaluated once, ever', () => {
    expect(fn).toContain('const marker = autoMarkerOf(row.gmeet_context);');
    expect(fn).toContain('if (!marker) return;');
    expect(fn).toContain('if (row.gmeet_context?.autoReview) return; // evaluated once, ever');
  });

  test('the decision is the shared evaluator; the stored shape carries no mode', () => {
    expect(fn).toContain('evaluateAutoReview({');
    expect(fn).toContain("autoReview: { evaluatedAt: nowIso, passed: false, reason: blocker },");
    expect(fn).not.toContain("mode: 'grace'");
  });

  test('the two DMs, same kinds and dedupe keys as before, to every recipient', () => {
    expect(fn).toContain("kind: 'needs_review'");
    expect(fn).toContain('dedupeKey: `mw-needs-review:${assemblyaiId}${runKey(transcriptionId)}:${to}`');
    expect(fn).toContain("kind: 'report_ready'");
    expect(fn).toContain('dedupeKey: `mw-report-ready:${assemblyaiId}${runKey(transcriptionId)}:${to}`');
    expect(fn.match(/for \(const to of auto\.recipients\)/g)?.length).toBe(2);
  });

  test('enrols every merged name, as it always did (the strict gate is the grace path only)', () => {
    expect(fn).toContain('await upsertMappingsForUser(ownerUserId, assemblyaiId, merged);');
    expect(fn).toMatch(/enrollFromTranscript\([^;]*, content, merged\)/);
  });
});

describe('autoProceedAfterGrace — the manual-row path', () => {
  const src = read('lib/server/auto-review.ts');
  const fn = fnBody(src, 'export async function autoProceedAfterGrace(');

  test('re-checks eligibility on the fresh row before anything else', () => {
    const check = fn.indexOf("if (!row || !autoProceedDue(autoProceedFactsOf(row))) return 'skipped';");
    expect(check).toBeGreaterThan(0);
    for (const write of ['mergeGmeetContextForUser(', 'upsertMappingsForUser(', 'generateAutoReport(', 'notifyUser(']) {
      expect(fn.indexOf(write), write).toBeGreaterThan(check);
    }
  });

  test('blocked: stores mode grace + reason, sends no DM', () => {
    const blocked = fn.slice(fn.indexOf('if (!ev.passed) {'), fn.indexOf("return 'blocked';"));
    expect(blocked).toContain("autoReview: { evaluatedAt: nowIso, passed: false, mode: 'grace', reason: ev.blocker ?? 'blocked' }");
    expect(blocked).not.toContain('notifyUser(');
    expect(fn).not.toContain("kind: 'needs_review'");
  });

  test('passed: names applied, only the strict subset enrolled, mode grace, the row pref, one DM to the owner', () => {
    expect(fn).toContain('await upsertMappingsForUser(ownerUserId, assemblyaiId, ev.merged);');
    expect(fn).toMatch(/enrollFromTranscript\([^;]*, content, ev\.enroll\)/);
    expect(fn).not.toMatch(/enrollFromTranscript\([^;]*, content, ev\.merged\)/);
    expect(fn).toContain("autoReview: { evaluatedAt: nowIso, passed: true, mode: 'grace', generated: pref }");
    expect(fn).toContain("useVideo: pref === 'detailed-video'");
    expect(fn).toContain('dedupeKey: `mw-auto-proceed:${assemblyaiId}:${owner.email}`');
    expect(fn).toContain('*Summary written automatically*');
    expect(fn).toContain('Fix any name');
    expect(fn.match(/notifyUser\(/g)?.length).toBe(1);
  });
});

describe('the sweeper pick is the SQL twin of the TS rule', () => {
  const dbops = read('db-ops/transcripts.ts');
  const q = fnBody(dbops, 'export async function listAutoProceedBacklog(');
  const rule = fnBody(read('lib/auto-proceed.ts'), 'export function autoProceedAt(');

  test('one predicate per condition, both sides', () => {
    const pairs: Array<[string, string]> = [
      ["status = 'completed'", "f.status !== 'completed'"],
      ['deleted_at IS NULL', 'f.deleted_at'],
      ["speaker_id_status = 'completed'", "f.speaker_id_status !== 'completed'"],
      ['speaker_id_at > now() - make_interval(hours => ${windowHours})', 'windowHours * 3_600_000'],
      ["(auto_notes IS NULL OR auto_notes = '')", 'f.hasNotes'],
      ['auto_notes_status IS NULL', 'f.auto_notes_status !== null'],
      ['auto_report_status IS NULL', 'f.auto_report_status !== null'],
      ["jsonb_typeof(gmeet_context->'autoReview') IS DISTINCT FROM 'object'", 'f.autoReviewed'],
      ["COALESCE(gmeet_context->'uploadPrefs'->>'report', '') <> 'later'", "storedReportPref(f.reportPref) === 'later'"],
      ["jsonb_typeof(gmeet_context->'autoImport') IS DISTINCT FROM 'object'", 'f.autoMarked'],
      ["jsonb_typeof(gmeet_context->'autoSync') IS DISTINCT FROM 'object'", 'f.autoMarked'],
    ];
    for (const [sqlSide, tsSide] of pairs) {
      expect(q, sqlSide).toContain(sqlSide);
      expect(rule, tsSide).toContain(tsSide);
    }
    // The grace is the pick's job (the rule only says WHEN); scratch rows are
    // deliberately NOT excluded on either side.
    expect(q).toContain('speaker_id_at < now() - make_interval(mins => ${graceMinutes})');
    expect(q).not.toContain('scratch');
    expect(rule).not.toContain('scratch');
  });

  test('the listing feeds the same helper the same columns', () => {
    const listing = fnBody(dbops, 'export async function listPagedForUser(');
    expect(listing).toContain("jsonb_typeof(t.gmeet_context->'autoReview') = 'object' AS __auto_reviewed");
    expect(listing).toContain("t.gmeet_context->'uploadPrefs'->>'report' AS __report_pref");
    expect(listing).toContain("jsonb_typeof(t.gmeet_context->'autoImport') = 'object'");
    expect(listing).toContain("jsonb_typeof(t.gmeet_context->'autoSync') = 'object'");
    expect(listing).toContain('auto_proceed_at: autoProceedAt(');
    // The inputs are folded in, not exposed as row columns.
    expect(listing).toContain('speaker_id_at, auto_report_status, __auto_reviewed, __report_pref, __auto_marked,\n      ...rest');
  });

  test('the sweeper runs it under the shared cap, after the speaker-id pickup', () => {
    const sweeper = read('lib/server/auto-notes-sweeper.ts');
    const tick = fnBody(sweeper, 'async function sweep(');
    const pick = tick.indexOf('listAutoProceedBacklog(AUTO_PROCEED_GRACE_MIN, AUTO_PROCEED_WINDOW_HOURS, MAX_PER_SWEEP)');
    expect(pick).toBeGreaterThan(tick.indexOf('listSpeakerIdBacklog('));
    expect(tick).toContain('await autoProceedAfterGrace(b.user_id, b.assemblyai_id);');
  });
});

describe('the API: autoProceedAt on GET, the hold route', () => {
  test('GET …/transcripts/:id answers autoProceedAt from the shared helper', () => {
    const src = read('app/api/transcripts/[id]/route.ts');
    const get = src.slice(src.indexOf('export const GET = withAuth('), src.indexOf('const EVENT_CONTEXT_KEYS'));
    expect(get).toContain('autoProceedAt: autoProceedAt(autoProceedFactsOf(refreshed))');
  });

  test('POST …/notes/hold: 404 / 403 before any write; writes mode held with who; 409 once written', () => {
    const src = read('app/api/transcripts/[id]/notes/hold/route.ts');
    const notFound = src.indexOf("{ error: 'Not found' }, { status: 404 }");
    const readOnly = src.indexOf("{ error: 'Read-only access' }, { status: 403 }");
    const write = src.indexOf('await mergeGmeetContextForUser(');
    expect(notFound).toBeGreaterThan(0);
    expect(readOnly).toBeGreaterThan(notFound);
    expect(write).toBeGreaterThan(readOnly);
    expect(src).toContain("mode: 'held'");
    expect(src).toContain('by: { userId: user.userId, email: user.email }');
    expect(src).toContain('passed: false,');
    expect(src).toContain('if (existing?.passed) {');
    expect(src).toContain('{ status: 409 }');
    // Idempotent: an existing evaluation (held or blocked) is left alone.
    expect(src).toContain('if (!existing) {');
    expect(src).toContain('autoProceedAt: autoProceedAt(autoProceedFactsOf(after))');
  });
});

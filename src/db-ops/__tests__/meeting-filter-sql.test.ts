/**
 * `summary=missing|failed` — the SQL the archive filter emits (2026-10-27),
 * over the fake postgres tag (helpers/fake-sql). The fragment is what both
 * the listing's rows query and its tab-count query splice in, so what is
 * asserted here is what keeps rows and counts in agreement; the predicate
 * text is the SQL twin of `summaryStateOf` (lib/listing-summary.ts).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql } from './helpers/fake-sql';
import { EMPTY_MEETING_FILTERS, type MeetingFilters } from '@/lib/server/meeting-filters';

let sql: FakeSql;
type Mod = typeof import('@/db-ops/meeting-filter-sql');
let mod: Mod;

beforeAll(async () => {
  sql = createFakeSql(() => []);
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mod = await import('@/db-ops/meeting-filter-sql');
});

const filters = (over: Partial<MeetingFilters>): MeetingFilters => ({ ...EMPTY_MEETING_FILTERS, ...over });
/** Render a fragment into one WHERE so the text can be read as SQL. */
const render = (f: MeetingFilters) => sql`SELECT 1 FROM t WHERE TRUE ${mod.archiveFilterSql(f)}`;
const MISSING =
  "(t.status = 'completed' AND (t.auto_notes IS NULL OR t.auto_notes = '') AND t.auto_notes_status IS DISTINCT FROM 'running' AND t.auto_notes_status IS DISTINCT FROM 'error')";
const FAILED = "t.auto_notes_status = 'error'";

describe('archiveFilterSql — summary', () => {
  test('no summary filter → no summary clause (the fragment is unchanged)', () => {
    const { text } = render(EMPTY_MEETING_FILTERS);
    expect(text).toBe('SELECT 1 FROM t WHERE TRUE');
  });

  test('missing = completed, no notes text, no run in flight or failed', () => {
    const { text, params } = render(filters({ summary: ['missing'] }));
    expect(text).toBe(`SELECT 1 FROM t WHERE TRUE AND (${MISSING})`);
    expect(params).toEqual([]);
  });

  test('failed = the last run errored', () => {
    const { text } = render(filters({ summary: ['failed'] }));
    expect(text).toBe(`SELECT 1 FROM t WHERE TRUE AND (${FAILED})`);
  });

  test('comma = OR, inside one AND group so it composes with the other filters', () => {
    const { text } = render(filters({ summary: ['missing', 'failed'], provider: ['teams'] }));
    expect(text).toContain(`AND (${MISSING} OR ${FAILED})`);
    expect(text).toContain('= ANY($1::text[])');
    // Order of the OR arms follows the states, not the request.
    const swapped = render(filters({ summary: ['failed', 'missing'] })).text;
    expect(swapped).toContain(`AND (${MISSING} OR ${FAILED})`);
  });

  test('the notes TEXT is only tested for emptiness, never selected', () => {
    const { text } = render(filters({ summary: ['missing', 'failed'] }));
    expect(text).not.toMatch(/SELECT[^(]*t\.auto_notes\b/);
    expect(text.match(/t\.auto_notes\b/g)?.length).toBe(2); // IS NULL / = ''
  });

  test('archiveSummaryExpr with nothing asked is FALSE, so a caller cannot widen by accident', () => {
    expect(sql`${mod.archiveSummaryExpr([])}`.text).toBe('FALSE');
  });
});

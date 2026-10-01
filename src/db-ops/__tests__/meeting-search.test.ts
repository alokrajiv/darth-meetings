/**
 * GET /api/search (the desktop-shell results panel) — query shaping, over the
 * fake postgres tag (helpers/fake-sql): what SQL the db-op emits for a query
 * and what the route serves.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createFakeSql, type FakeSql, type RenderedQuery } from './helpers/fake-sql';
import { shapeMeetingSearch } from '@/lib/meeting-search';

const me = { userId: '11111111-2222-3333-4444-555555555555', email: 'Alok@Trames.sg' };

let sql: FakeSql;
let respond: (q: RenderedQuery) => unknown[] = () => [];
const identityCalls: string[][] = [];

beforeAll(() => {
  sql = createFakeSql((q) => respond(q));
  mock.module('server-only', () => ({}));
  mock.module('@/lib/db', () => ({ sql, default: sql }));
  mock.module('@/lib/plagueis-db', () => ({ plagueisSql: sql }));
  mock.module('@/lib/auth/with-auth', () => ({
    withAuth:
      (h: (ctx: { user: typeof me; request: Request }) => Promise<Response>) =>
      (request: Request) =>
        h({ user: me, request }),
  }));
  mock.module('@/db-ops/transcript-activity', () => ({
    identitiesForUsers: async (ids: string[]) => {
      identityCalls.push(ids);
      return new Map([['owner-2', { userId: 'owner-2', email: 'atira@trames.sg', name: 'Atira' }]]);
    },
  }));
});

const lastExecuted = () => sql.executed[sql.executed.length - 1]!;
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('searchMeetingsForPanel — the SQL a query becomes', () => {
  test('one five-field OR per term, ANDed; patterns as params; visibility + cap', async () => {
    const { searchMeetingsForPanel } = await import('@/db-ops/meeting-search');
    respond = () => [];
    await searchMeetingsForPanel(me.userId, me.email, shapeMeetingSearch('budget 50%')!);
    const q = lastExecuted();
    // 2 terms × 5 fields in the WHERE + 2 title-rank ILIKEs.
    expect(count(q.text, 'ILIKE')).toBe(12);
    expect(count(q.text, "t.imported_content->>'text' ILIKE")).toBe(2);
    expect(q.params).toContain('%budget%');
    expect(q.params).toContain('%50\\%%');
    // Lower-cased terms feed strpos() for the snippet window.
    expect(q.params).toContain('budget');
    expect(q.params).toContain('50%');
    // Visibility: owned or shared-with-email (lower-cased), live, not temporary.
    expect(q.text).toContain('t.deleted_at IS NULL');
    expect(q.text).toContain('NOT t.scratch');
    expect(q.text).toContain('s.shared_with_email =');
    expect(q.params).toContain('alok@trames.sg');
    expect(q.params).toContain(me.userId);
    expect(q.text).toContain('LIMIT');
    expect(q.params).toContain(30);
    // Title hits rank first, then newest.
    expect(q.text).toContain('ORDER BY title_hit DESC, sort_key DESC');
  });

  test('a single term emits no dangling AND / LEAST list', async () => {
    const { searchMeetingsForPanel } = await import('@/db-ops/meeting-search');
    await searchMeetingsForPanel(me.userId, me.email, shapeMeetingSearch('roadmap')!);
    const q = lastExecuted();
    expect(count(q.text, 'ILIKE')).toBe(6);
    expect(q.text).toContain('LEAST(NULLIF(strpos(lb.body, $');
    expect(q.text).not.toMatch(/AND\s+(ORDER|LIMIT|\))/);
  });
});

describe('GET /api/search', () => {
  const get = async (q: string) => {
    const { GET } = await import('@/app/api/search/route');
    const res = await (GET as unknown as (r: Request) => Promise<Response>)(
      new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`)
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  test('no usable term → no query at all, empty hits', async () => {
    const before = sql.executed.length;
    const r = await get(' a ');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ q: ' a ', terms: [], hits: [] });
    expect(sql.executed.length).toBe(before);
  });

  test('hits carry title / date / owner / duration / labels / snippet with ranges', async () => {
    respond = () => [
      {
        id: 'mine-1',
        user_id: me.userId,
        title: 'Budget review',
        original_filename: null,
        recorded_at: '2026-09-30T02:00:00.000Z',
        created_at: '2026-09-30T02:30:00.000Z',
        duration: 1800,
        source: 'imported',
        access: 'owner',
        has_event: true,
        recorder_recording_id: null,
        provider: 'teams',
        labels: [{ id: 3, name: 'Finance', path: 'Finance', color: null }],
        snip_field: null,
        snip_window: null,
        snip_window_start: null,
        snip_at_end: null,
      },
      {
        id: 'shared-1',
        user_id: 'owner-2',
        title: 'Ops weekly',
        original_filename: null,
        recorded_at: null,
        created_at: '2026-09-29T08:00:00.000Z',
        duration: null,
        source: 'uploaded',
        access: 'read',
        has_event: false,
        recorder_recording_id: null,
        provider: null,
        labels: [],
        snip_field: 'content',
        snip_window: 'ial so the budget line moves to Q4 and the review is next week',
        snip_window_start: 381,
        snip_at_end: false,
      },
    ];
    const r = await get('budget review');
    expect(r.status).toBe(200);
    expect(r.body.terms).toEqual(['budget', 'review']);
    const hits = r.body.hits as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      id: 'mine-1',
      matched_in: 'title',
      owner: null,
      duration: 1800,
      at: '2026-09-30T02:00:00.000Z',
      snippet: null,
    });
    expect(hits[1]).toMatchObject({
      id: 'shared-1',
      matched_in: 'content',
      owner: { email: 'atira@trames.sg', name: 'Atira' },
      at: '2026-09-29T08:00:00.000Z',
    });
    const snip = hits[1]!.snippet as { text: string; ranges: [number, number][]; atStart: boolean };
    expect(snip.ranges.map(([a, b]) => snip.text.slice(a, b))).toEqual(['budget', 'review']);
    expect(snip.atStart).toBe(false);
    // Only the shared row's owner is looked up.
    expect(identityCalls.at(-1)).toEqual(['owner-2']);
  });
});

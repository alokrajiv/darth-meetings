/**
 * The desktop replica's browser glue (lib/offline/replica-client.ts) with a
 * fake store bridge and a fake fetch: the owner key from the session (and the
 * unkeyed, read-only open when it cannot be asked), the meeting page's
 * write-through, the background sync (listing, warm, plan revs, ≤ 2 meetings
 * at a time, `?replica=1`, once per interval, nothing while offline, stop on
 * the first network failure), offline reads + search. Plus the shell glue
 * (shell-offline.ts) and the offline copy helpers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createFakeDesktopStore, type FakeDesktopStore } from './helpers/fake-desktop-store';
import type { DesktopStoreBridge } from '../offline/replica-db';
import {
  loadStoredListing,
  loadStoredMeeting,
  rememberOpenedMeeting,
  replicaAvailable,
  searchStored,
  setReplicaEnvForTests,
  syncReplicaSoon,
} from '../offline/replica-client';
import {
  connectivityStateOf,
  isOfflineState,
  meetingPageUrl,
  setShellConnectivityForTests,
  warmPages,
} from '../offline/shell-offline';
import { dayHeading, groupByLocalDay, readHashOf, readIdFromHash, savedAtLabel, savedLine } from '../offline/offline-copy';
import type { TranscriptListRow } from '@/lib/format';

const ORIGIN = 'https://meetings.example';

function listRow(id: string, at: string, status = 'completed'): TranscriptListRow {
  return {
    id: 1,
    user_id: 'u1',
    assemblyai_id: id,
    original_filename: null,
    status,
    created_at: at,
    completed_at: at,
    duration: 600,
    speaker_count: 2,
    language_code: 'en',
    title: `Meeting ${id}`,
    description: null,
    last_accessed: at,
    source: 'imported',
    recorded_at: at,
    auto_notes_status: null,
    upload_bytes_received: null,
    upload_bytes_total: null,
    access: 'owner',
    owner_email: null,
    owner_name: null,
    labels: [],
  };
}

function detail(id: string, at: string) {
  return {
    transcript: {
      id: 1,
      user_id: 'u1',
      assemblyai_id: id,
      original_filename: null,
      status: 'completed',
      created_at: at,
      completed_at: at,
      duration: 600,
      speaker_count: 2,
      language_code: 'en',
      title: `Meeting ${id}`,
      description: null,
      last_accessed: at,
      source: 'imported',
      gmeet_context: null,
      recorded_at: at,
      auto_notes: `Notes for ${id} mention the walrus`,
      auto_notes_at: at,
      auto_report: null,
      auto_report_at: null,
      auto_segments: null,
      access: 'owner',
    },
  };
}

type Route = (url: URL) => unknown | Promise<unknown>;
interface FakeNet {
  fetch: typeof fetch;
  calls: string[];
  inFlightMax: number;
}
function fakeNet(routes: Record<string, Route>, opts: { failOn?: (u: URL) => boolean; delayMs?: number } = {}): FakeNet {
  const net: FakeNet = { calls: [], inFlightMax: 0, fetch: undefined as unknown as typeof fetch };
  let inFlight = 0;
  net.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), ORIGIN);
    net.calls.push(url.pathname + url.search);
    inFlight++;
    net.inFlightMax = Math.max(net.inFlightMax, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failOn?.(url)) throw new TypeError('Failed to fetch');
      const key = Object.keys(routes).find((k) => new RegExp(k).test(url.pathname));
      if (!key) return new Response('{}', { status: 404 });
      const body = await routes[key]!(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
  return net;
}

const AT = (d: number) => `2026-10-${String(d).padStart(2, '0')}T10:00:00Z`;
const ROWS = [listRow('m5', AT(5)), listRow('m4', AT(4)), listRow('p3', AT(3), 'processing'), listRow('m2', AT(2)), listRow('m1', AT(1))];

function standardRoutes(revs: Record<string, string> = {}): Record<string, Route> {
  return {
    '^/api/auth/session$': () => ({ userId: 'u1' }),
    '^/api/transcripts$': () => ({
      days: [{ key: '2026-10-05', rows: ROWS, totalSecs: 0 }],
      counts: { all: 5, mine: 5, shared: 0, trash: 0 },
      nextCursor: null,
      hasMore: false,
    }),
    '^/api/offline/plan$': (u) => ({
      meetings: (u.searchParams.get('ids') ?? '').split(',').filter(Boolean).map((id) => ({ id, rev: revs[id] ?? `rev-${id}` })),
    }),
    '^/api/transcripts/[^/]+/speakers$': () => ({ speakerLabels: [{ originalSpeaker: 'A', customName: 'Ann', description: '' }] }),
    '^/api/transcripts/[^/]+/edits$': () => ({ edits: {} }),
    '^/api/transcripts/[^/]+/content$': () => ({
      content: { id: 'x', status: 'completed', created: '', utterances: [{ speaker: 'A', start: 0, end: 1, text: 'the zebra crossing' }] },
    }),
    '^/api/transcripts/[^/]+$': (u) => detail(decodeURIComponent(u.pathname.split('/').pop()!), AT(1)),
  };
}

let store: FakeDesktopStore;
let warmed: string[][];
const g = globalThis as unknown as { window?: unknown };

beforeEach(() => {
  store = createFakeDesktopStore({ allowDataVersion: true });
  warmed = [];
  g.window = Object.assign(new EventTarget(), {
    location: { origin: ORIGIN, pathname: '/' },
    darthDesktop: {
      offlineCache: {
        warm: async (urls: string[]) => {
          warmed.push(urls);
          return { queued: urls.length };
        },
      },
    },
  });
  setShellConnectivityForTests('online');
});
afterEach(() => {
  setReplicaEnvForTests({ bridge: undefined, fetch: undefined });
  setShellConnectivityForTests(null);
  delete g.window;
  store.close();
});

function useEnv(net: FakeNet, bridge: DesktopStoreBridge | null = store as unknown as DesktopStoreBridge) {
  setReplicaEnvForTests({ bridge, fetch: net.fetch });
}

describe('background sync', () => {
  test('listing → store, pages warmed, missing meetings fetched two at a time with ?replica=1', async () => {
    const net = fakeNet(standardRoutes(), { delayMs: 2 });
    useEnv(net);
    const r = await syncReplicaSoon();
    expect(r).toMatchObject({ ran: true, listed: 5, warmed: 4, fetched: 4, failed: 0 });
    expect(warmed).toEqual([['m5', 'm4', 'm2', 'm1'].map((id) => meetingPageUrl(ORIGIN, id))]);
    expect(net.calls.filter((c) => /^\/api\/transcripts\/[^/]+\?replica=1$/.test(c))).toHaveLength(4);
    expect(net.calls.some((c) => /^\/api\/transcripts\/[^/?]+$/.test(c))).toBe(false); // never a logged "view"
    expect(net.calls.find((c) => c.startsWith('/api/offline/plan'))).toBe('/api/offline/plan?ids=m5,m4,m2,m1');
    // 4 requests per meeting run together; never more than 2 meetings → ≤ 8.
    expect(net.inFlightMax).toBeLessThanOrEqual(8);
    expect(net.inFlightMax).toBeGreaterThan(4);
    const listing = await loadStoredListing();
    expect(listing?.rows.map((x) => x.assemblyai_id)).toEqual(['m5', 'm4', 'p3', 'm2', 'm1']);
    expect([...listing!.saved].sort()).toEqual(['m1', 'm2', 'm4', 'm5']);
    const m = await loadStoredMeeting('m4');
    expect(m?.doc?.turns).toEqual([['Ann', 0, 'the zebra crossing']]);
    expect(m?.doc?.rev).toBe('rev-m4');
  });

  test('a second sync within the interval does nothing (kept in the store); force re-fetches only changed revs', async () => {
    const revs: Record<string, string> = {};
    const net = fakeNet(standardRoutes(revs));
    useEnv(net);
    await syncReplicaSoon();
    // A new page load: the in-memory guard is gone, the stored one is not.
    setReplicaEnvForTests({ bridge: store as unknown as DesktopStoreBridge, fetch: net.fetch });
    const before = net.calls.length;
    expect((await syncReplicaSoon()).stoppedBy).toBe('recent');
    expect(net.calls.length - before).toBe(1); // only the session (owner key)
    revs.m2 = 'rev-m2-changed';
    const r = await syncReplicaSoon({ force: true });
    expect(r.fetched).toBe(1);
    expect((await loadStoredMeeting('m2'))?.doc?.rev).toBe('rev-m2-changed');
  });

  test('nothing at all while the shell says offline', async () => {
    const net = fakeNet(standardRoutes());
    useEnv(net);
    setShellConnectivityForTests('offline-manual');
    expect((await syncReplicaSoon()).stoppedBy).toBe('offline');
    expect(net.calls).toEqual([]);
    expect(warmed).toEqual([]);
  });

  test('the first network failure stops the sync (no retry loop)', async () => {
    let contentCalls = 0;
    const net = fakeNet(standardRoutes(), {
      failOn: (u) => {
        if (!u.pathname.endsWith('/content')) return false;
        contentCalls++;
        return true;
      },
    });
    useEnv(net);
    const r = await syncReplicaSoon();
    expect(r.stoppedBy).toBe('network');
    expect(r.fetched).toBe(0);
    expect(contentCalls).toBeLessThanOrEqual(2); // the two in flight, then stop
  });

  test('on the web (no store bridge) nothing is fetched or stored', async () => {
    const net = fakeNet(standardRoutes());
    useEnv(net, null);
    expect(replicaAvailable()).toBe(false);
    expect((await syncReplicaSoon()).stoppedBy).toBe('no-store');
    expect(await loadStoredListing()).toBeNull();
    expect(await searchStored('zebra')).toBeNull();
    expect(net.calls).toEqual([]);
  });
});

describe('write-through, offline reads, search', () => {
  test('an opened meeting is kept with its plan rev; offline it reads and searches without the network', async () => {
    const net = fakeNet(standardRoutes({ m9: 'rev-nine' }));
    useEnv(net);
    const d = detail('m9', AT(9)).transcript;
    await rememberOpenedMeeting({
      row: d as never,
      speakerLabels: [],
      edits: { '0': { text: 'an edited line about the okapi' } },
      content: { id: 'x', status: 'completed', created: '', utterances: [{ speaker: 'B', start: 5, end: 6, text: 'raw' }] },
      labels: null,
    });
    const m = await loadStoredMeeting('m9');
    expect(m?.doc?.turns).toEqual([['Speaker B', 5, 'an edited line about the okapi']]);
    expect(m?.doc?.rev).toBe('rev-nine');

    // Offline: a fresh page load opens the store unkeyed (no session call).
    setReplicaEnvForTests({ bridge: store as unknown as DesktopStoreBridge, fetch: net.fetch });
    setShellConnectivityForTests('offline-network');
    const before = net.calls.length;
    const hit = await searchStored('okapi');
    expect(hit?.hits.map((h) => [h.id, h.matched_in])).toEqual([['m9', 'content']]);
    expect(hit?.saved.has('m9')).toBe(true);
    expect((await searchStored('walrus'))?.hits[0]?.matched_in).toBe('notes');
    expect((await loadStoredMeeting('m9'))?.doc?.meta.title).toBe('Meeting m9');
    expect(net.calls.length).toBe(before);
    // And writes are refused while unkeyed.
    await rememberOpenedMeeting({ row: detail('m8', AT(8)).transcript as never, content: { id: 'x', status: 'completed', created: '', text: 'x' } });
    expect((await loadStoredMeeting('m8'))?.doc).toBeNull();
  });

  test('a pending meeting (no content yet) is not written', async () => {
    const net = fakeNet(standardRoutes());
    useEnv(net);
    await rememberOpenedMeeting({ row: { ...detail('m7', AT(7)).transcript, status: 'processing' } as never, content: null });
    expect((await loadStoredMeeting('m7'))?.doc).toBeNull();
  });
});

describe('shell glue', () => {
  test('connectivity details', () => {
    expect(connectivityStateOf({ state: 'online', online: true })).toBe('online');
    expect(connectivityStateOf({ state: 'offline-manual' })).toBe('offline-manual');
    expect(connectivityStateOf({ error: { code: 'X' } })).toBeNull();
    expect(connectivityStateOf({ state: 'weird' })).toBeNull();
    expect(connectivityStateOf(null)).toBeNull();
    expect(isOfflineState('offline-network')).toBe(true);
    expect(isOfflineState('online')).toBe(false);
    expect(isOfflineState(null)).toBe(false);
  });

  test('warmPages never throws, caps at 200, 0 without the API', async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${ORIGIN}/transcript/m${i}`);
    expect(await warmPages(urls)).toBe(200);
    expect(await warmPages(urls, {})).toBe(0);
    expect(await warmPages(urls, { darthDesktop: { offlineCache: { warm: () => Promise.reject(new Error('x')) } } })).toBe(0);
    expect(await warmPages(urls, { darthDesktop: { offlineCache: { warm: () => { throw new Error('x'); } } } })).toBe(0);
    expect(await warmPages([], undefined)).toBe(0);
    expect(meetingPageUrl(ORIGIN, 'a b')).toBe(`${ORIGIN}/transcript/a%20b`);
  });
});

describe('offline copy', () => {
  test('#read=<id> round trip', () => {
    expect(readIdFromHash(readHashOf('abc/def'))).toBe('abc/def');
    expect(readIdFromHash('#other')).toBeNull();
    expect(readIdFromHash('#read=')).toBeNull();
    expect(readIdFromHash('#read=%E0%A4%A')).toBeNull();
    expect(readIdFromHash(undefined)).toBeNull();
  });

  test('saved line and day grouping', () => {
    const now = new Date(2026, 9, 22, 15, 0);
    expect(savedLine(null, now)).toBe('Showing what was saved on this Mac');
    expect(savedLine(new Date(2026, 9, 22, 14, 2).getTime(), now)).toStartWith('Showing what was saved at ');
    expect(savedAtLabel(new Date(2026, 9, 20, 9, 5).getTime(), now)).toContain(',');
    expect(dayHeading('2026-10-22', now)).toBe('Today');
    expect(dayHeading('2026-10-21', now)).toBe('Yesterday');
    const rows = [
      { at: new Date(2026, 9, 22, 9).toISOString() },
      { at: new Date(2026, 9, 21, 18).toISOString() },
      { at: new Date(2026, 9, 22, 8).toISOString() },
    ];
    const groups = groupByLocalDay(rows, (r) => r.at);
    expect(groups.map((x) => [x.key, x.rows.length])).toEqual([
      ['2026-10-22', 2],
      ['2026-10-21', 1],
    ]);
  });
});

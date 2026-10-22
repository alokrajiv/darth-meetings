/**
 * The Meetings desktop replica (README "Offline in the Darth desktop shell")
 * against a fake store bridge that enforces the shell's rules over
 * node:sqlite (helpers/fake-desktop-store.ts): one statement per call,
 * params only, the authorizer, fts5, the limits, QUOTA. Every statement the
 * replica sends therefore passes the shell's filter or the test fails.
 *
 * Covers: migrate / version mismatch / ensureOwner (wipe on another owner,
 * unkeyed = read only); the FTS probe and the LIKE fallback; compaction (no
 * raw JSON, names + edits applied, size); the listing write (ranks, roll-off,
 * docs keep rows); doc write-through + read; eviction under the budget and on
 * QUOTA; local search (FTS + LIKE, snippets, matched_in, saved set).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createFakeDesktopStore, type FakeDesktopStore } from './helpers/fake-desktop-store';
import {
  REPLICA_VERSION,
  desktopStoreBridge,
  migrationStatements,
  openReplicaDb,
  type DesktopStoreBridge,
  type ReplicaDb,
} from '../offline/replica-db';
import {
  DOC_MAX_BYTES,
  compactMeeting,
  docBytes,
  fitDoc,
  ftsQueryOf,
  pickEvictions,
  readDoc,
  readListing,
  saveDoc,
  saveListing,
  searchReplica,
  turnsOf,
  type MeetingSources,
  type ReplicaDoc,
} from '../offline/replica';
import type { StoredTranscript, TranscriptListRow, TranscriptResponse } from '@/lib/format';

const quiet = () => {};
const stores: FakeDesktopStore[] = [];
function fake(o: Parameters<typeof createFakeDesktopStore>[0] = { allowDataVersion: true }): FakeDesktopStore {
  const f = createFakeDesktopStore(o);
  stores.push(f);
  return f;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});
async function open(f: FakeDesktopStore, owner: string | null = 'user-1'): Promise<ReplicaDb> {
  const db = await openReplicaDb(f as unknown as DesktopStoreBridge, owner, quiet);
  if (!db) throw new Error('store did not open');
  return db;
}
function raw<T = Record<string, unknown>>(f: FakeDesktopStore, sql: string, ...params: unknown[]): T[] {
  return f.raw.prepare(sql).all(...(params as never[])) as T[];
}

function listRow(id: string, at: string, extra: Partial<TranscriptListRow> = {}): TranscriptListRow {
  return {
    id: 1,
    user_id: 'user-1',
    assemblyai_id: id,
    original_filename: null,
    status: 'completed',
    created_at: at,
    completed_at: at,
    duration: 1800,
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
    labels: [{ id: 7, name: 'Ops', path: 'Ops', color: '#f00' } as never],
    ...extra,
  };
}

function content(n = 3, words = true): TranscriptResponse {
  const utterances = Array.from({ length: n }, (_, i) => ({
    speaker: i % 2 ? 'B' : 'A',
    start: i * 1000,
    end: i * 1000 + 900,
    text: `utterance number ${i} about the quarterly budget`,
    ...(words
      ? { words: Array.from({ length: 8 }, (_, w) => ({ text: `w${w}`, start: w, end: w + 1, confidence: 0.9, speaker: 'A' })) }
      : {}),
  }));
  return { id: 'x', status: 'completed', created: '2026-10-01', utterances, text: utterances.map((u) => u.text).join(' ') } as TranscriptResponse;
}

function sources(id: string, at: string, extra: Partial<StoredTranscript> = {}, n = 3): MeetingSources {
  const row = {
    id: 1,
    user_id: 'user-1',
    assemblyai_id: id,
    original_filename: 'call.mp4',
    status: 'completed',
    created_at: at,
    completed_at: at,
    duration: 1200,
    speaker_count: 2,
    language_code: 'en',
    title: `Planning ${id}`,
    description: 'Weekly sync with the ops team',
    last_accessed: at,
    source: 'imported',
    speech_model: null,
    imported_content: null,
    audio_url: null,
    local_audio_path: null,
    drive_file_id: null,
    gmeet_context: {
      provider: 'gmeet',
      eventId: 'evt',
      eventTitle: 'Planning',
      organizerEmail: 'org@trames.sg',
      attendees: [{ email: 'alice@trames.sg', name: 'Alice' }, { email: 'bob@trames.sg' }],
      teams: { joinWebUrl: 'https://teams.example/secret-join', tenantId: 't', organizerOid: 'o' },
    },
    recorded_at: at,
    auto_notes: '## Summary\nWe agreed on the **hiring plan**.',
    auto_segments: [{ title: 'Intro', start_ms: 0 }],
    auto_notes_status: 'done',
    auto_notes_error: null,
    auto_notes_at: at,
    auto_report: '# Report\nDetailed hiring discussion.',
    auto_report_status: 'done',
    auto_report_error: null,
    auto_report_at: at,
    speaker_id_status: null,
    speaker_id_error: null,
    speaker_id_at: null,
    upload_bytes_received: null,
    upload_bytes_total: null,
    deleted_at: null,
    scratch: false,
    access: 'owner',
    ...extra,
  } as unknown as MeetingSources['row'];
  return {
    row,
    speakerLabels: [{ originalSpeaker: 'A', customName: 'Alice Tan', description: '' }],
    edits: { '1': { text: 'edited second utterance about the zeppelin' } },
    content: content(n),
  };
}

describe('desktopStoreBridge()', () => {
  test('null on the web, an older shell, or a bridge missing a call', () => {
    expect(desktopStoreBridge({})).toBeNull();
    expect(desktopStoreBridge({ darthDesktop: {} })).toBeNull();
    expect(desktopStoreBridge({ darthDesktop: { store: { exec() {}, query() {} } } })).toBeNull();
    const store = { exec() {}, query() {}, transaction() {} };
    expect(desktopStoreBridge({ darthDesktop: { store } })).toBe(store as never);
  });
});

describe('migrate + ensureOwner', () => {
  test('a fresh store gets the schema, the version stamp and the owner', async () => {
    const f = fake();
    const db = await open(f);
    expect(db.fts).toBe(true);
    expect(raw<{ user_version: number }>(f, 'PRAGMA user_version')[0]!.user_version).toBe(REPLICA_VERSION);
    expect(raw(f, "SELECT v FROM meta WHERE k = 'owner'")).toEqual([{ v: 'user-1' }]);
    const tables = raw<{ name: string }>(f, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const t of ['meta', 'meetings', 'docs', 'search', 'search_lite']) expect(tables).toContain(t);
  });

  test('another owner wipes every row first; the same owner keeps them', async () => {
    const f = fake();
    const a = await open(f, 'user-1');
    await saveListing(a, [listRow('m1', '2026-10-01T10:00:00Z')]);
    expect(await saveDoc(a, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), 'r1')).toBe('ok');
    await open(f, 'user-1');
    expect(raw(f, 'SELECT id FROM docs')).toHaveLength(1);
    await open(f, 'user-2');
    expect(raw(f, 'SELECT id FROM docs')).toHaveLength(0);
    expect(raw(f, 'SELECT id FROM meetings')).toHaveLength(0);
    expect(raw(f, 'SELECT id FROM search')).toHaveLength(0);
    expect(raw(f, "SELECT v FROM meta WHERE k = 'owner'")).toEqual([{ v: 'user-2' }]);
  });

  test('an unkeyed open (offline) reads but never writes, and never wipes', async () => {
    const f = fake();
    const a = await open(f, 'user-1');
    await saveDoc(a, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), null);
    const ro = await open(f, null);
    expect(ro.owner).toBeNull();
    expect((await readDoc(ro, 'm1'))?.meta.title).toBe('Planning m1');
    expect(await saveDoc(ro, compactMeeting(sources('m2', '2026-10-02T10:00:00Z')), null)).toBe('NO_OWNER');
    expect(await saveListing(ro, [listRow('m2', '2026-10-02T10:00:00Z')])).toBe(false);
    expect(raw(f, 'SELECT id FROM docs')).toHaveLength(1);
  });

  test('a version mismatch drops and recreates the tables', async () => {
    const f = fake();
    const db = await open(f);
    await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), null);
    f.raw.exec('PRAGMA user_version = 99');
    await open(f);
    expect(raw(f, 'SELECT id FROM docs')).toHaveLength(0);
    expect(raw<{ user_version: number }>(f, 'PRAGMA user_version')[0]!.user_version).toBe(REPLICA_VERSION);
    expect(migrationStatements(0)[0]!.sql).toMatch(/^CREATE/);
    expect(migrationStatements(3)[0]!.sql).toMatch(/^DROP TABLE IF EXISTS/);
  });

  test('a shell that refuses FTS5 (≤ 0.4) opens with fts off and uses search_lite', async () => {
    const f = fake({ allowDataVersion: false });
    const db = await open(f);
    expect(db.fts).toBe(false);
    await saveListing(db, [listRow('m1', '2026-10-01T10:00:00Z')]);
    expect(await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), null)).toBe('ok');
    expect(raw(f, 'SELECT id FROM search_lite')).toHaveLength(1);
    const r = await searchReplica(db, 'zeppelin');
    expect(r?.hits.map((h) => h.id)).toEqual(['m1']);
    expect(r?.hits[0]!.matched_in).toBe('content');
  });

  test('UNAVAILABLE (no store on this runtime) → null', async () => {
    const bridge = {
      exec: async () => ({ error: { code: 'UNAVAILABLE', message: 'x' } }),
      query: async () => ({ error: { code: 'UNAVAILABLE', message: 'x' } }),
      transaction: async () => ({ error: { code: 'UNAVAILABLE', message: 'x' } }),
    };
    expect(await openReplicaDb(bridge, 'u', quiet)).toBeNull();
  });
});

describe('compaction', () => {
  test('turns carry the page names and edited text; the raw JSON is not kept', () => {
    const doc = compactMeeting(sources('m1', '2026-10-01T10:00:00Z'));
    expect(doc.turns[0]).toEqual(['Alice Tan', 0, 'utterance number 0 about the quarterly budget']);
    expect(doc.turns[1]).toEqual(['Speaker B', 1000, 'edited second utterance about the zeppelin']);
    expect(doc.meta.speakers).toEqual(['Alice Tan', 'Speaker B']);
    expect(doc.meta.attendees).toEqual([
      { email: 'alice@trames.sg', name: 'Alice' },
      { email: 'bob@trames.sg', name: null },
    ]);
    expect(doc.meta.organizer).toBe('org@trames.sg');
    expect(doc.notes).toContain('hiring plan');
    expect(doc.report).toContain('Detailed hiring');
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"words"');
    expect(json).not.toContain('joinWebUrl'); // the context is not stored wholesale
  });

  test('a transcript without utterances becomes one turn of text', () => {
    expect(turnsOf({ id: 'x', status: 'completed', created: '', text: ' plain text ' } as TranscriptResponse, [], {})).toEqual([
      ['', 0, 'plain text'],
    ]);
    expect(turnsOf(null, [], {})).toEqual([]);
  });

  test('much smaller than the payload it came from', () => {
    const src = sources('m1', '2026-10-01T10:00:00Z', {}, 400);
    const doc = compactMeeting(src);
    expect(docBytes(doc)).toBeLessThan(JSON.stringify(src.content).length);
  });

  test('an oversized meeting keeps the longest prefix that fits and says so', () => {
    const doc = compactMeeting(sources('m1', '2026-10-01T10:00:00Z', {}, 50));
    const cut = fitDoc(doc, docBytes({ ...doc, turns: doc.turns.slice(0, 10) }));
    expect(cut.turns).toHaveLength(10);
    expect(cut.meta.truncated).toBe(true);
    expect(fitDoc(doc, DOC_MAX_BYTES)).toBe(doc);
  });
});

describe('listing', () => {
  test('ranks newest first; a re-save drops rows that fell out unless a doc keeps them', async () => {
    const f = fake();
    const db = await open(f);
    const rows = ['m3', 'm2', 'm1'].map((id, i) => listRow(id, `2026-10-0${3 - i}T10:00:00Z`));
    expect(await saveListing(db, rows, 1000)).toBe(true);
    let l = await readListing(db);
    expect(l?.rows.map((r) => r.assemblyai_id)).toEqual(['m3', 'm2', 'm1']);
    expect(l?.savedAt).toBe(1000);
    expect(l?.saved.size).toBe(0);
    await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), null);
    await saveListing(db, [listRow('m4', '2026-10-04T10:00:00Z'), rows[0]!], 2000);
    l = await readListing(db);
    expect(l?.rows.map((r) => r.assemblyai_id)).toEqual(['m4', 'm3']);
    expect(raw<{ id: string }>(f, 'SELECT id FROM meetings ORDER BY id').map((r) => r.id)).toEqual(['m1', 'm3', 'm4']);
    // m2's title row went with it; m1's doc row stayed (full text).
    expect(raw<{ id: string }>(f, 'SELECT id FROM search ORDER BY id').map((r) => r.id)).toEqual(['m1', 'm3', 'm4']);
    expect(raw<{ content: string }>(f, "SELECT content FROM search WHERE id = 'm1'")[0]!.content).toContain('zeppelin');
  });

  test('search-only fields never reach the store', async () => {
    const f = fake();
    const db = await open(f);
    await saveListing(db, [listRow('m1', '2026-10-01T10:00:00Z', { snippet: 'x', matched_in: 'title' })]);
    const json = raw<{ row_json: string }>(f, 'SELECT row_json FROM meetings')[0]!.row_json;
    expect(json).not.toContain('snippet');
    expect(json).not.toContain('matched_in');
  });
});

describe('docs', () => {
  test('write-through then read back', async () => {
    const f = fake();
    const db = await open(f);
    expect(await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), 'rev-1', { now: 5 })).toBe('ok');
    const d = await readDoc(db, 'm1');
    expect(d?.rev).toBe('rev-1');
    expect(d?.savedAt).toBe(5);
    expect(d?.turns).toHaveLength(3);
    expect(d?.meta.labels).toEqual([]);
    // A second write replaces (one doc row, one search row).
    await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z', { title: 'Renamed' })), 'rev-2');
    expect(raw(f, 'SELECT id FROM docs')).toHaveLength(1);
    expect(raw<{ title: string }>(f, "SELECT title FROM search WHERE id = 'm1'")).toEqual([{ title: 'Renamed' }]);
    expect(await readDoc(db, 'nope')).toBeNull();
  });
});

describe('eviction', () => {
  test('pickEvictions: oldest first, never the kept id, stops once under budget', () => {
    const docs = [
      { id: 'new', at: '2026-10-05', bytes: 10 },
      { id: 'old', at: '2026-10-01', bytes: 10 },
      { id: 'mid', at: '2026-10-03', bytes: 10 },
    ];
    expect(pickEvictions(docs, 30)).toEqual([]);
    expect(pickEvictions(docs, 25)).toEqual(['old']);
    expect(pickEvictions(docs, 15, 0, 'old')).toEqual(['mid', 'new']);
    expect(pickEvictions(docs, 30, 10)).toEqual(['old']);
  });

  test('a doc over the budget evicts the oldest stored meetings', async () => {
    const f = fake();
    const db = await open(f);
    const docs = ['m1', 'm2', 'm3'].map((id, i) => compactMeeting(sources(id, `2026-10-0${i + 1}T10:00:00Z`)));
    const budget = docBytes(docs[0]!) * 2 + 10;
    for (const d of docs) expect(await saveDoc(db, d, null, { budget })).toBe('ok');
    expect(raw<{ id: string }>(f, 'SELECT id FROM docs ORDER BY id').map((r) => r.id)).toEqual(['m2', 'm3']);
    expect(raw(f, "SELECT id FROM search WHERE id = 'm1'")).toHaveLength(0);
  });

  test('an evicted meeting still in the listing keeps its title search row', async () => {
    const f = fake();
    const db = await open(f);
    await saveListing(db, [listRow('m1', '2026-10-01T10:00:00Z')]);
    const d1 = compactMeeting(sources('m1', '2026-10-01T10:00:00Z'));
    await saveDoc(db, d1, null);
    await saveDoc(db, compactMeeting(sources('m2', '2026-10-02T10:00:00Z')), null, { budget: docBytes(d1) + 10 });
    expect(raw(f, "SELECT id FROM docs WHERE id = 'm1'")).toHaveLength(0);
    expect(raw<{ title: string; content: string }>(f, "SELECT title, content FROM search WHERE id = 'm1'")).toEqual([
      { title: 'Meeting m1', content: '' },
    ]);
    expect((await readListing(db))?.rows.map((r) => r.assemblyai_id)).toEqual(['m1']);
  });

  test('QUOTA from the shell: evict the oldest and retry, never the meeting being saved', async () => {
    // A tiny database: a handful of 4 KB pages.
    const f = fake({ allowDataVersion: true, maxPages: 60 });
    const db = await open(f);
    let saved = 0;
    for (let i = 1; i <= 12; i++) {
      const at = `2026-09-${String(i).padStart(2, '0')}T10:00:00Z`;
      const r = await saveDoc(db, compactMeeting(sources(`m${i}`, at, {}, 200)), null, { budget: 1e12 });
      if (r === 'ok') saved++;
    }
    expect(saved).toBe(12);
    expect(f.calls.length).toBeGreaterThan(0);
    const left = raw<{ id: string }>(f, 'SELECT id FROM docs ORDER BY at').map((r) => r.id);
    expect(left).toContain('m12');
    expect(left).not.toContain('m1');
    expect(left.length).toBeLessThan(12);
  });
});

describe('local search', () => {
  async function seeded(fts = true): Promise<{ f: FakeDesktopStore; db: ReplicaDb }> {
    const f = fake({ allowDataVersion: fts });
    const db = await open(f);
    await saveListing(db, [
      listRow('m3', '2026-10-03T10:00:00Z', { title: 'Hiring committee' }),
      listRow('m2', '2026-10-02T10:00:00Z', { title: 'Vendor call', description: 'Zeppelin parts pricing' }),
      listRow('m1', '2026-10-01T10:00:00Z'),
    ]);
    await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), null);
    return { f, db };
  }

  test('ftsQueryOf quotes every term as a prefix and ANDs them', () => {
    expect(ftsQueryOf(['budget', 'q"3'])).toBe('"budget"* "q""3"*');
  });

  for (const fts of [true, false]) {
    test(`transcript, notes, description and title hits (${fts ? 'fts5' : 'LIKE'})`, async () => {
      const { db } = await seeded(fts);
      const t = await searchReplica(db, 'zeppelin');
      expect(t?.hits.map((h) => [h.id, h.matched_in])).toEqual([
        ['m2', 'description'],
        ['m1', 'content'],
      ]);
      const content = t!.hits[1]!;
      expect(content.snippet?.text).toContain('zeppelin');
      expect(content.snippet?.ranges.length).toBeGreaterThan(0);
      expect(t?.saved.has('m1')).toBe(true);
      expect(t?.saved.has('m2')).toBe(false);

      const n = await searchReplica(db, 'hiring');
      expect(n?.hits.map((h) => [h.id, h.matched_in])).toEqual([
        ['m3', 'title'],
        ['m1', 'notes'],
      ]);
      expect(n?.hits[0]!.labels).toHaveLength(1);
      const both = await searchReplica(db, 'quarterly budget');
      expect(both?.hits.map((h) => h.id)).toEqual(['m1']);
      expect((await searchReplica(db, 'x'))?.hits).toEqual([]);
      expect((await searchReplica(db, 'nothing-like-this'))?.hits).toEqual([]);
    });
  }

  test('a hit shows the owner of a shared meeting', async () => {
    const f = fake();
    const db = await open(f);
    await saveListing(db, [
      listRow('s1', '2026-10-01T10:00:00Z', { access: 'read', owner_email: 'atira@trames.sg', owner_name: 'Atira' }),
    ]);
    const r = await searchReplica(db, 'meeting');
    expect(r?.hits[0]!.owner).toEqual({ email: 'atira@trames.sg', name: 'Atira' });
    expect(r?.hits[0]!.access).toBe('read');
  });
});

describe('never stored', () => {
  test('no cookie, token or session value reaches the store', async () => {
    const f = fake();
    const db = await open(f);
    await saveListing(db, [listRow('m1', '2026-10-01T10:00:00Z')]);
    await saveDoc(db, compactMeeting(sources('m1', '2026-10-01T10:00:00Z')), 'r');
    for (const c of f.calls) {
      for (const s of c.statements) {
        const text = JSON.stringify(s.params ?? []);
        expect(text).not.toMatch(/darth_session|dth_|dapp_|cookie|refresh_token|access_token/i);
      }
    }
  });
});

// Keep the type import honest (ReplicaDoc is part of the module's surface).
const _doc: ReplicaDoc | null = null;
void _doc;

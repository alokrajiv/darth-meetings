/**
 * P5 / P6 UI (docs/recordings-meetings-series-design.md §3, §5): Recordings
 * is its own top-level surface, the meetings listing no longer carries the
 * Recordings / Temporary tabs, a meeting cannot be moved to temporary, and a
 * temporary row takes no new share.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAV, legacyTabRedirect, navItemActive } from '@/lib/app-nav';
import { sharingRefusal } from '@/lib/share-gate';

const root = join(import.meta.dir, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('top-level nav: Meetings · Recordings · Series', () => {
  test('three surfaces, in that order', () => {
    expect(APP_NAV.map((n) => n.label)).toEqual(['Meetings', 'Recordings', 'Series']);
    expect(APP_NAV.map((n) => n.href)).toEqual(['/', '/recordings', '/series']);
  });
  test('active state per route; Meetings owns / only', () => {
    const [meetings, recordings, series] = APP_NAV;
    expect(navItemActive(meetings!, '/')).toBe(true);
    expect(navItemActive(meetings!, '/recordings')).toBe(false);
    expect(navItemActive(recordings!, '/recordings')).toBe(true);
    expect(navItemActive(recordings!, '/recordings/abc')).toBe(true);
    expect(navItemActive(recordings!, '/recordingsx')).toBe(false);
    expect(navItemActive(series!, '/series')).toBe(true);
    expect(navItemActive(series!, null)).toBe(false);
  });
  test('Recordings and Series need the server; Meetings stays live offline', () => {
    expect(APP_NAV.filter((n) => n.needsServer).map((n) => n.key)).toEqual(['recordings', 'series']);
  });
});

describe('old listing tabs land on /recordings', () => {
  test('?tab=recordings / ?tab=scratch', () => {
    expect(legacyTabRedirect('?tab=recordings')).toBe('/recordings');
    expect(legacyTabRedirect('?tab=scratch')).toBe('/recordings#temporary');
    expect(legacyTabRedirect('?tab=mine')).toBeNull();
    expect(legacyTabRedirect('')).toBeNull();
    expect(legacyTabRedirect('?label=3&tab=recordings')).toBe('/recordings');
  });
});

describe('the meetings listing is meetings only', () => {
  const src = read('components/transcript-table.tsx');
  test('no Recordings / Temporary tab', () => {
    expect(src).toContain("type TabKey = 'all' | 'mine' | 'shared' | 'trash';");
    expect(src).not.toContain("tabButton('scratch'");
    expect(src).not.toContain("tabButton('recordings'");
    expect(src).not.toContain('<RecordingsSurface');
  });
  test('the unlinked strip links to /recordings', () => {
    expect(src).toMatch(/href="\/recordings"\s+data-unlinked-banner/);
  });
  test('no "Move to temporary" on a meeting — row menu or bulk bar', () => {
    expect(src).not.toContain("label: 'Move to temporary'");
    expect(src).toContain('scratchAction={null}');
    const page = read('app/transcript/[id]/page.tsx');
    expect(page).not.toContain("'Move to temporary'");
  });
});

describe('P5: only meetings are shareable', () => {
  test('a temporary row is refused, a meeting is not', () => {
    expect(sharingRefusal({ scratch: true })).toContain('cannot be shared');
    expect(sharingRefusal({ scratch: false })).toBeNull();
    expect(sharingRefusal({})).toBeNull();
  });
  test('POST …/shares answers 409 through the gate; PATCH/DELETE untouched', () => {
    const route = read('app/api/transcripts/[id]/shares/route.ts');
    const post = route.slice(route.indexOf('export const POST'), route.indexOf('export const PATCH'));
    expect(post).toContain('sharingRefusal(access.row)');
    expect(post).toContain('status: 409');
    const rest = route.slice(route.indexOf('export const PATCH'));
    expect(rest).not.toContain('sharingRefusal');
  });
  test('the transcript page hides Share on a temporary row without shares', () => {
    const page = read('app/transcript/[id]/page.tsx');
    expect(page).toContain('const shareHidden = !!sharingRefusal(row) && collaboratorEmails.size === 0;');
    expect(page.match(/\{!shareHidden && \(/g)?.length).toBe(2);
  });
});

describe('the Recordings surface', () => {
  const src = read('components/recordings-surface.tsx');
  test('reads the owner-scoped endpoint, not the meetings listing', () => {
    expect(src).toContain('/api/recordings?');
    expect(src).not.toContain('/api/transcripts?');
    expect(src).not.toContain('/api/recorder/recordings?mine=1`');
  });
  test('Q5: "Name…" is "Make a meeting"; temporary cards offer Keep', () => {
    expect(src).toContain('Make a meeting');
    expect(src).not.toMatch(/>\s*Name…\s*</);
    expect(src).toContain('data-keep-recording');
    expect(src).toContain('Link to meeting…');
  });
  test('no raw match score on the hint (F3)', () => {
    expect(src).not.toContain('{pct}%');
  });
});

/**
 * /recordings, 2026-10-02 (Ivan's 30-min Teams call):
 *  - B1: a Mac row whose upload is under way refetches until the server
 *    lists it as the recording its upload opened (which offers Link to
 *    meeting… / Make a meeting) — the pure rules in lib/recordings-live.ts;
 *  - B2: linked recordings stay findable — the "Linked to a meeting" card
 *    and the All view's group, rendered statically (no DOM).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  linkedMeetingLabel,
  linkedRecordingFacts,
  registryItemsAwaitingSwap,
  swapRefreshDelay,
  SWAP_REFRESH_DELAYS_MS,
} from '@/lib/recordings-live';
import { stripForRecordingView, type RecordingViewWire } from '@/lib/recording-view';
import { LinkedCard, LinkedGroup, type RecordingsItemWire } from '@/components/recordings-surface';

const REC = '11111111-0000-4000-8000-000000000002';

const view = (over: Partial<RecordingViewWire> = {}): RecordingViewWire => ({
  id: REC,
  pseudo_id: `rec-${REC}`,
  title: 'Ivan / Data team',
  source_kind: 'recorder',
  status: 'ready',
  status_note: null,
  started_at: '2026-10-02T01:00:53.000Z',
  created_at: '2026-10-02T01:31:54.000Z',
  duration_sec: 1800,
  speaker_count: 3,
  language_code: 'en',
  original_filename: 'call.m4a',
  bytes: 47_000_000,
  has_video: false,
  part_count: 0,
  expires_at: null,
  temporary: false,
  upload: null,
  meetings: [],
  in_meeting: true,
  suggested_event: null,
  recorder_recording_id: 'reg-1',
  source_app: 'Microsoft Teams',
  ...over,
});

describe('B1 — the registry → recording swap', () => {
  const reg = (id: string, status = 'local') => ({ kind: 'registry', registry: { id, status } });

  test('a Mac row the tray is uploading, or the server says is uploading, awaits its recording', () => {
    const items = [
      reg('b-live'),
      reg('a-server', 'uploading'),
      reg('c-idle'),
      { kind: 'recording', registry: null },
      { kind: 'meeting', registry: { id: 'd-meeting-reg', status: 'uploading' } },
    ];
    const uploads = { 'b-live': { status: 'uploading' }, 'c-idle': { status: 'done' } };
    expect(registryItemsAwaitingSwap(items, uploads)).toEqual(['a-server', 'b-live']);
  });

  test('nothing uploading → nothing to wait for (no refetch loop)', () => {
    expect(registryItemsAwaitingSwap([reg('x'), reg('y', 'upload_failed')], { x: { status: 'failed' } })).toEqual([]);
  });

  test('the refetch backoff starts almost at once and stops after about a minute', () => {
    expect(swapRefreshDelay(0)).toBeLessThanOrEqual(500);
    const total = SWAP_REFRESH_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThanOrEqual(90_000);
    expect(swapRefreshDelay(SWAP_REFRESH_DELAYS_MS.length)).toBeNull();
    expect(swapRefreshDelay(-1)).toBeNull();
  });

  test('the uploading recording keeps the tray’s progress bar and bytes', () => {
    const m = stripForRecordingView(view({ status: 'uploading', upload: { bytes_received: null, bytes_total: null } }), {
      live: { pct: 41.6, bytesSent: 19_000_000, bytesTotal: 47_000_000 },
      fmtBytes: (n) => `${Math.round(n / 1e6)} MB`,
      fmtDuration: (s) => `${s}s`,
    });
    expect(m.progress).toEqual({ pct: 41.6, label: 'Uploading · 42% · 19 MB of 47 MB', live: true });
    expect(m.text).toBe('Uploading · 42% · 19 MB of 47 MB');
  });

  test('the surface wires it: the swap effect, and Link / Make a meeting gate only on a failed transcription', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'components', 'recordings-surface.tsx'), 'utf8');
    expect(src).toContain('registryItemsAwaitingSwap(items, companion.uploads)');
    expect(src).toContain('setTimeout(refresh, delay)');
    // RecordingCard: the actions are not gated on the upload.
    expect(src).toContain("const linkable = r.status !== 'failed';");
    expect(src).toMatch(/disabled=\{disabled \|\| !linkable\}\s+onClick=\{onLink\}/);
  });
});

describe('B2 — linked recordings stay findable', () => {
  const fmt = {
    when: (iso: string) => `@${iso.slice(0, 10)}`,
    duration: (s: number) => `${s / 60}m`,
    bytes: (n: number) => `${Math.round(n / 1e6)} MB`,
  };

  test('facts: date · duration · source app · size, empty parts dropped', () => {
    expect(linkedRecordingFacts(view(), fmt)).toBe('@2026-10-02 · 30m · Microsoft Teams · 47 MB');
    expect(linkedRecordingFacts(view({ source_app: null, duration_sec: null, bytes: null }), fmt)).toBe(
      '@2026-10-02 · Darth Recorder'
    );
    expect(linkedRecordingFacts(view({ source_kind: 'upload', source_app: undefined, started_at: null }), fmt)).toBe(
      '@2026-10-02 · 30m · Uploaded file · 47 MB'
    );
  });

  test('meeting label: title · when, or Untitled meeting', () => {
    expect(linkedMeetingLabel({ assemblyai_id: 'm', title: 'Data scrum', recorded_at: '2026-10-02T01:00:00Z' }, fmt.when)).toBe(
      'Data scrum · @2026-10-02'
    );
    expect(linkedMeetingLabel({ assemblyai_id: 'm', title: '  ', recorded_at: null }, fmt.when)).toBe('Untitled meeting');
  });

  test('LinkedCard: its own facts, the meeting it is in, Open meeting + Open recording', () => {
    const html = renderToStaticMarkup(
      <LinkedCard r={view()} meetings={[{ assemblyai_id: 'abc-123', title: 'Data scrum', recorded_at: '2026-10-02T01:00:00Z' }]} />
    );
    expect(html).toContain('data-recording-card="linked"');
    expect(html).toContain('Ivan / Data team');
    expect(html).toContain('Microsoft Teams');
    expect(html).toContain('Data scrum');
    expect(html).toContain('href="/transcript/abc-123"');
    expect(html).toContain('Open meeting');
    expect(html).toContain(`href="/recording/${REC}"`);
    expect(html).toContain('Open recording');
    // Nothing on it links, unlinks or shares.
    expect(html).not.toMatch(/Share|Unlink|Link to meeting|Make a meeting/);
  });

  test('LinkedCard with no meeting the caller can open: no Open meeting, says so', () => {
    const html = renderToStaticMarkup(<LinkedCard r={view()} meetings={[]} />);
    expect(html).not.toContain('Open meeting');
    expect(html).toContain('In a meeting you can no longer open');
    expect(html).toContain('Open recording');
  });

  test('LinkedGroup: heading with the count; "Show all" only when there are more', () => {
    const item: RecordingsItemWire = {
      kind: 'recording',
      section: 'linked',
      sort_us: '1',
      recording: view(),
      meetings: [{ assemblyai_id: 'abc-123', title: 'Data scrum', recorded_at: null }],
    };
    const more = renderToStaticMarkup(<LinkedGroup items={[item]} count={7} onShowAll={() => {}} />);
    expect(more).toContain('Linked to a meeting');
    expect(more).toContain('Show all 7');
    const all = renderToStaticMarkup(<LinkedGroup items={[item]} count={1} onShowAll={() => {}} />);
    expect(all).not.toContain('Show all');
  });

  test('the page asks for the linked section by name; the default request is unchanged', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'components', 'recordings-surface.tsx'), 'utf8');
    expect(src).toContain("section: 'linked'");
    expect(src).toContain("{ key: 'linked', label: 'Linked to a meeting', short: 'Linked' }");
    // useUnlinkedRecordings (the Meetings strip) still counts mac + uploaded only.
    expect(src).toContain('setCount(data.counts.mac + data.counts.uploaded)');
  });
});

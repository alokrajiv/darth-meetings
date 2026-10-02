/**
 * The whole /recordings surface, rendered statically (no DOM, effects do not
 * run) from a page state like Ivan's on 2026-10-02 09:32 SGT: his Teams call
 * mid-upload (now a recording item), a Mac row still on the Mac, and a
 * recording already linked to a meeting.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RecordingViewWire } from '@/lib/recording-view';

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => '/recordings',
  useSearchParams: () => new URLSearchParams(),
}));

type Surface = typeof import('@/components/recordings-surface');
let S: Surface;
beforeAll(async () => {
  S = await import('@/components/recordings-surface');
});

const rec = (id: string, over: Partial<RecordingViewWire> = {}): RecordingViewWire => ({
  id,
  pseudo_id: `rec-${id}`,
  title: null,
  source_kind: 'recorder',
  status: 'ready',
  status_note: null,
  started_at: '2026-10-02T01:00:53.000Z',
  created_at: '2026-10-02T01:31:54.000Z',
  duration_sec: 1800,
  speaker_count: null,
  language_code: null,
  original_filename: 'call.m4a',
  bytes: 47_000_000,
  has_video: false,
  part_count: 0,
  expires_at: null,
  temporary: false,
  upload: null,
  meetings: [],
  in_meeting: false,
  suggested_event: null,
  recorder_recording_id: null,
  source_app: 'Microsoft Teams',
  ...over,
});

const UPLOADING = 'aaaaaaaa-0000-4000-8000-00000000000a';
const LINKED = 'bbbbbbbb-0000-4000-8000-00000000000b';
const REG = 'cccccccc-0000-4000-8000-00000000000c';

function page(filter: 'all' | 'linked'): import('@/components/recordings-surface').RecordingsPage {
  const linkedItem = {
    kind: 'recording' as const,
    section: 'linked' as const,
    sort_us: '1',
    recording: rec(LINKED, { title: 'Ivan / Data team', in_meeting: true }),
    meetings: [{ assemblyai_id: 'mtg-1', title: 'Data scrum', recorded_at: '2026-10-02T01:00:00.000Z' }],
  };
  return {
    items:
      filter === 'linked'
        ? [linkedItem]
        : [
            {
              kind: 'recording',
              section: 'uploaded',
              sort_us: '3',
              recording: rec(UPLOADING, {
                title: 'Teams call',
                status: 'uploading',
                upload: { bytes_received: null, bytes_total: null },
                recorder_recording_id: 'reg-uploading',
              }),
            },
            {
              kind: 'registry',
              section: 'mac',
              sort_us: '2',
              registry: {
                id: REG,
                device_id: 'mac',
                status: 'local',
                started_at: '2026-10-02T02:00:00.000Z',
                ended_at: null,
                duration_s: 60,
                bytes: 1000,
                segments: null,
                call: { title: 'Slack huddle', app: 'Slack' },
                matched: null,
                transcript_id: null,
                error: null,
              },
            },
          ],
    counts: filter === 'linked' ? { mac: 1, uploaded: 1, temporary: 0, linked: 6 } : { mac: 1, uploaded: 1, temporary: 0 },
    linked: filter === 'linked' ? { count: 6, preview: [] } : { count: 6, preview: [linkedItem] },
    filter,
    setFilter: () => {},
    query: '',
    setQuery: () => {},
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    loadMore: () => {},
    refresh: () => {},
  };
}

/** The <button> carrying `attr`, as markup. */
const buttonWith = (html: string, cardAttr: string, attr: string) => {
  const card = html.slice(html.indexOf(cardAttr));
  const at = card.indexOf(attr);
  const start = card.lastIndexOf('<button', at);
  return card.slice(start, card.indexOf('>', at) + 1);
};

describe('/recordings, All', () => {
  test('chips: All counts the linked ones too; a Linked chip with its count', () => {
    const html = renderToStaticMarkup(<S.RecordingsSurface data={page('all')} />);
    expect(html).toContain('data-filter="linked"');
    expect(html).toMatch(/data-filter="all"[^]*?>8<\/span>/); // 1 + 1 + 0 + 6
    expect(html).toMatch(/data-filter="linked"[^]*?Linked to a meeting<\/span><span[^>]*>6<\/span>/);
  });

  test('the uploading recording offers Link to meeting… and Make a meeting, enabled, with its progress strip', () => {
    const html = renderToStaticMarkup(<S.RecordingsSurface data={page('all')} />);
    const card = `data-recording-id="${UPLOADING}"`;
    expect(html).toContain(card);
    const link = buttonWith(html, card, 'data-link-meeting');
    const make = buttonWith(html, card, 'data-name-meeting');
    expect(link).not.toContain('disabled=""');
    expect(make).not.toContain('disabled=""');
    expect(html.slice(html.indexOf(card))).toContain('Uploading');
  });

  test('the Mac row stays a Mac row (Upload from the tray), and the linked group follows the list', () => {
    const html = renderToStaticMarkup(<S.RecordingsSurface data={page('all')} />);
    expect(html).toContain('data-recording-card="mac"');
    const list = html.indexOf('data-recordings-list');
    const group = html.indexOf('data-linked-group');
    expect(group).toBeGreaterThan(list);
    expect(html).toContain('Show all 6');
    expect(html).toContain('href="/transcript/mtg-1"');
    expect(html).toContain(`href="/recording/${LINKED}"`);
  });
});

describe('/recordings, Linked to a meeting', () => {
  test('the list is linked cards only; no group, no unlinked copy', () => {
    const html = renderToStaticMarkup(<S.RecordingsSurface data={page('linked')} />);
    expect(html).toContain('data-recording-card="linked"');
    expect(html).not.toContain('data-linked-group');
    expect(html).toContain('Data scrum');
    expect(html).toContain('Open meeting');
    expect(html).toContain('Open recording');
    expect(html).not.toContain('data-link-meeting');
  });
});

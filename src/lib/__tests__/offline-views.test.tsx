/**
 * The offline screens as static renders (no DOM): the stored listing (saved
 * rows open in place, the rest dimmed "Not available offline"), the stored
 * meeting (saved-at line, disabled playback and actions, notes, speaker-named
 * turns, the not-saved state), the disabled import button, and an offline
 * search hit whose text is not stored.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { OfflineListingView } from '@/components/offline-listing';
import { OfflineMeetingView } from '@/components/offline-meeting';
import { ImportSplitButton } from '@/components/import-split-button';
import { MeetingHitRow } from '@/components/shell-search';
import { compactMeeting } from '@/lib/offline/replica';
import { NOT_AVAILABLE_OFFLINE } from '@/lib/offline/offline-copy';
import type { TranscriptListRow } from '@/lib/format';

const NOW = new Date(2026, 9, 22, 15, 0);

function listRow(id: string, at: Date, extra: Partial<TranscriptListRow> = {}): TranscriptListRow {
  const iso = at.toISOString();
  return {
    id: 1,
    user_id: 'u1',
    assemblyai_id: id,
    original_filename: null,
    status: 'completed',
    created_at: iso,
    completed_at: iso,
    duration: 1500,
    speaker_count: 3,
    language_code: 'en',
    title: `Meeting ${id}`,
    description: null,
    last_accessed: iso,
    source: 'imported',
    recorded_at: iso,
    auto_notes_status: null,
    upload_bytes_received: null,
    upload_bytes_total: null,
    access: 'owner',
    owner_email: null,
    owner_name: null,
    labels: [],
    ...extra,
  };
}

describe('OfflineListingView', () => {
  test('saved rows are buttons; the others say "Not available offline"; grouped by day', () => {
    const html = renderToStaticMarkup(
      <OfflineListingView
        listing={{
          rows: [
            listRow('a', new Date(2026, 9, 22, 9)),
            listRow('b', new Date(2026, 9, 21, 9), { access: 'read', owner_name: 'Atira' }),
          ],
          saved: new Set(['a']),
          savedAt: new Date(2026, 9, 22, 14, 2).getTime(),
        }}
        online={false}
        onOpen={() => {}}
        now={NOW}
      />
    );
    expect(html).toContain('Showing what was saved at');
    expect(html).toContain('Today');
    expect(html).toContain('Yesterday');
    expect(html).toMatch(/data-offline-row="a" data-offline-saved="1"><button/);
    expect(html).toMatch(/<li class="[^"]*opacity-50"[^>]*data-offline-row="b" data-offline-saved="0"/);
    expect(html).not.toMatch(/data-offline-row="b"[^>]*><button/);
    expect(html.split(NOT_AVAILABLE_OFFLINE).length - 1).toBe(2); // b's tooltip + its text
    expect(html).toContain('Atira');
    expect(html).not.toContain('Try again'); // offline: nothing to retry
  });

  test('online after a failed read: "Try again"; empty store explains itself', () => {
    const html = renderToStaticMarkup(
      <OfflineListingView listing={{ rows: [], saved: new Set(), savedAt: null }} online onOpen={() => {}} onRetry={() => {}} now={NOW} />
    );
    expect(html).toContain('Try again');
    expect(html).toContain('No meetings were saved on this Mac yet');
  });
});

describe('OfflineMeetingView', () => {
  const doc = {
    ...compactMeeting({
      row: {
        assemblyai_id: 'm1',
        title: 'Hiring sync',
        description: null,
        original_filename: null,
        status: 'completed',
        recorded_at: new Date(2026, 9, 21, 10).toISOString(),
        created_at: new Date(2026, 9, 21, 10).toISOString(),
        completed_at: null,
        duration: 1800,
        language_code: 'en',
        source: 'imported',
        gmeet_context: { attendees: [{ email: 'ann@trames.sg', name: 'Ann' }] },
        auto_notes: '## Decisions\nHire **two** engineers.',
        auto_notes_at: null,
        auto_report: null,
        auto_report_at: null,
        auto_segments: null,
        access: 'owner',
      } as never,
      speakerLabels: [{ originalSpeaker: 'A', customName: 'Ann', description: '' }],
      content: {
        id: 'x',
        status: 'completed',
        created: '',
        utterances: [
          { speaker: 'A', start: 0, end: 1, text: 'Welcome everyone' },
          { speaker: 'B', start: 65000, end: 66000, text: 'Thanks' },
        ],
      },
    }),
    savedAt: new Date(2026, 9, 22, 14, 2).getTime(),
    rev: null,
  };

  test('the stored meeting: saved line, disabled actions, notes, turns', () => {
    const html = renderToStaticMarkup(<OfflineMeetingView id="m1" doc={doc} row={null} online={false} bare now={NOW} />);
    expect(html).toContain('Hiring sync');
    expect(html).toContain('Showing what was saved at');
    expect(html).toMatch(/<button type="button" disabled="" title="Not available offline" aria-label="Play — Not available offline"/);
    expect(html).toContain('aria-label="Share — Not available offline"');
    expect(html).toMatch(/Hire <strong[^>]*>two<\/strong> engineers\./);
    expect(html).toContain('Welcome everyone');
    expect(html).toContain('>Ann<');
    expect(html).toContain('Speaker B');
    expect(html).toContain('1:05');
    expect(html).not.toContain('Try again');
  });

  test('not saved: says so, with the listing row title when there is one', () => {
    const html = renderToStaticMarkup(
      <OfflineMeetingView id="m2" doc={null} row={listRow('m2', new Date(2026, 9, 20, 9))} online bare onRetry={() => {}} now={NOW} />
    );
    expect(html).toContain('Meeting m2');
    expect(html).toContain('data-testid="offline-not-saved"');
    expect(html).toContain('Try again');
  });
});

describe('controls', () => {
  test('the import button disabled with the offline reason', () => {
    const html = renderToStaticMarkup(<ImportSplitButton onAction={() => {}} disabledReason={NOT_AVAILABLE_OFFLINE} defaultOpen />);
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain(`title="${NOT_AVAILABLE_OFFLINE}"`);
    expect(html).not.toContain('role="menu"');
  });

  test('an offline search hit without stored text is dimmed and says why', () => {
    const hit = {
      id: 'm3',
      title: 'Vendor call',
      original_filename: null,
      at: '2026-10-20T10:00:00Z',
      recorded_at: '2026-10-20T10:00:00Z',
      created_at: '2026-10-20T10:00:00Z',
      duration: null,
      access: 'owner' as const,
      owner: null,
      labels: [],
      has_event: false,
      recorder_recording_id: null,
      source: 'imported' as const,
      provider: null,
      matched_in: 'title' as const,
      snippet: null,
    };
    const html = renderToStaticMarkup(
      <MeetingHitRow hit={hit} index={0} terms={['vendor']} selected={false} unavailable onSelect={() => {}} onHover={() => {}} />
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(NOT_AVAILABLE_OFFLINE);
    const normal = renderToStaticMarkup(
      <MeetingHitRow hit={hit} index={0} terms={['vendor']} selected={false} onSelect={() => {}} onHover={() => {}} />
    );
    expect(normal).not.toContain(NOT_AVAILABLE_OFFLINE);
  });
});

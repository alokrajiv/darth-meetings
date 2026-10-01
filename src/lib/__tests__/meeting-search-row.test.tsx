/**
 * The results panel's row, rendered statically (no DOM): title with bold
 * matches, date, meta (owner · duration · where), snippet with <mark>s and
 * the ellipses the snippet flags ask for.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Highlighted, MeetingHitRow } from '@/components/shell-search';
import type { MeetingSearchHit } from '../meeting-search';

const hit = (over: Partial<MeetingSearchHit> = {}): MeetingSearchHit => ({
  id: 'abc',
  title: 'Budget review',
  original_filename: null,
  at: '2026-09-30T02:00:00.000Z',
  recorded_at: '2026-09-30T02:00:00.000Z',
  created_at: '2026-09-30T02:00:00.000Z',
  duration: 1830,
  access: 'read',
  owner: { email: 'atira@trames.sg', name: 'Atira' },
  labels: [{ id: 1, name: 'Finance', path: 'Finance', color: null }],
  has_event: true,
  recorder_recording_id: null,
  source: 'imported',
  provider: 'teams',
  matched_in: 'content',
  snippet: { text: 'so the budget moves', ranges: [[7, 13]], atStart: false, atEnd: false },
  ...over,
});

const render = (h: MeetingSearchHit, terms = ['budget']) =>
  renderToStaticMarkup(
    <MeetingHitRow hit={h} index={0} terms={terms} selected={false} onSelect={() => {}} onHover={() => {}} />
  );

describe('MeetingHitRow', () => {
  test('title + snippet matches are <mark>ed; meta names owner, duration, field', () => {
    const html = render(hit());
    expect(html).toContain('role="option"');
    expect(html).toContain('<mark class="search-match">Budget</mark>');
    expect(html).toContain('<mark class="search-match">budget</mark>');
    expect(html).toContain('Atira · 30m 30s · in transcript');
    expect(html).toContain('Finance');
    // Mid-field snippet: ellipsis on both sides.
    expect(html).toMatch(/data-testid="meeting-search-snippet">…<span>so the <\/span>/);
    expect(html).toMatch(/ moves<\/span>…<\/span>/);
  });

  test('own meeting → "You"; no snippet → no snippet line', () => {
    const html = render(hit({ access: 'owner', owner: null, snippet: null, matched_in: 'title' }));
    expect(html).toContain('You · 30m 30s · in title');
    expect(html).not.toContain('meeting-search-snippet');
  });
});

describe('Highlighted', () => {
  test('ranges become marks, the rest plain spans', () => {
    expect(renderToStaticMarkup(<Highlighted text="a budget b" ranges={[[2, 8]]} />)).toBe(
      '<span>a </span><mark class="search-match">budget</mark><span> b</span>'
    );
  });
});

/**
 * The link dialog's choice (owner, 2026-10-02): "This occurrence already has
 * a meeting by <owner> — Add my recording to it (default) / Keep mine
 * separate". Rendered statically (no DOM), plus the two pieces of glue the
 * dialog and the suggestion strip share: the candidate query and where a
 * joined answer sends the person.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  JoinChoice,
  fetchLinkCandidates,
  joinedMeetingHref,
} from '@/components/occurrence-join-choice';
import type { OccurrenceMeetingCandidate } from '@/lib/occurrence-join';

const candidate = (over: Partial<OccurrenceMeetingCandidate> = {}): OccurrenceMeetingCandidate => ({
  meetingId: 'm-kawen',
  url: '/transcript/m-kawen',
  title: 'Data team weekly',
  ownerName: 'Ka Wen Koh',
  ownerEmail: 'kawen@trames.sg',
  mine: false,
  access: 'edit',
  recordingCount: 1,
  joinable: true,
  blockedCode: null,
  blockedReason: null,
  ...over,
});

describe('the choice, as the dialog renders it', () => {
  test('names the owner and the meeting; Add first and marked default; Keep separate second', () => {
    const html = renderToStaticMarkup(<JoinChoice candidate={candidate()} onPick={() => {}} />);
    expect(html).toContain('This occurrence already has a meeting by Ka Wen Koh');
    expect(html).toContain('Data team weekly');
    expect(html).toContain('Add my recording to it');
    expect(html).toContain('(default)');
    expect(html).toContain('Keep mine separate');
    expect(html.indexOf('data-join-mode="join"')).toBeLessThan(html.indexOf('data-join-mode="separate"'));
    expect(html).toContain('data-join-choice="m-kawen"');
  });

  test('your own meeting says "you"; while linking both buttons are disabled', () => {
    const html = renderToStaticMarkup(
      <JoinChoice candidate={candidate({ mine: true })} busy="join" onPick={() => {}} />
    );
    expect(html).toContain('already has a meeting by you');
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });

  test('the suggestion strip’s one-line form carries the same two actions', () => {
    const html = renderToStaticMarkup(<JoinChoice candidate={candidate()} onPick={() => {}} compact />);
    expect(html).toContain('This occurrence already has a meeting by Ka Wen Koh');
    expect(html).toContain('Add my recording to it');
    expect(html).toContain('Keep mine separate');
    expect(html).not.toContain('(default)');
  });
});

describe('the glue', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('the candidate query goes to the recording or the meeting route, empty values dropped', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ candidate: candidate(), candidates: [candidate()], defaultMode: 'join' }));
    }) as typeof fetch;
    const out = await fetchLinkCandidates({ recordingId: 'r1' }, { eventId: 'ev', startTime: 'T', meetingCode: undefined });
    expect(out?.candidate?.meetingId).toBe('m-kawen');
    expect(urls[0]).toBe('/api/recordings/r1/link-candidates?eventId=ev&startTime=T');
    await fetchLinkCandidates({ transcriptId: 'm-1' }, { event: 'ev|2026-10-02T06:00:00.000Z' });
    expect(urls[1]).toBe('/api/transcripts/m-1/link-candidates?event=ev%7C2026-10-02T06%3A00%3A00.000Z');
  });

  test('a failed question is no answer — the link goes ahead with the server default', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await fetchLinkCandidates({ recordingId: 'r1' }, { eventId: 'ev' })).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchLinkCandidates({ recordingId: 'r1' }, { eventId: 'ev' })).toBeNull();
  });

  test('a joined answer goes to the joined meeting; anything else stays', () => {
    expect(joinedMeetingHref({ joined: true, meetingId: 'm-kawen' })).toBe('/transcript/m-kawen');
    expect(joinedMeetingHref({ joined: false, meeting: { id: 'm-own' } })).toBeNull();
    expect(joinedMeetingHref(null)).toBeNull();
  });

  test('the dialog and the strip ask before they link, and send the mode the person picked', () => {
    const dialog = readFileSync(join(import.meta.dir, '..', '..', 'components', 'link-event-dialog.tsx'), 'utf8');
    expect(dialog).toContain('fetchLinkCandidates(');
    expect(dialog).toContain('<JoinChoice');
    expect(dialog).toContain('...(mode ? { mode } : {})');
    const strip = readFileSync(join(import.meta.dir, '..', '..', 'components', 'suggested-event-strip.tsx'), 'utf8');
    expect(strip).toContain('fetchLinkCandidates({ transcriptId }, { event: suggested.key })');
    expect(strip).toContain('<JoinChoice');
  });
});

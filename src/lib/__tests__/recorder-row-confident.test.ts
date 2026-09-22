/**
 * P3 / F3 (docs/recordings-meetings-series-design.md): a weak match is never
 * offered — anywhere.
 *
 * The tray asks "Link to 'X'?" only on the server's `confident` bit, and the
 * calendar fold has required one since a2e3ea4. The Recordings surface did
 * not: it rendered every match, at any score, with a one-click **Link to
 * it**. `recorderRowIsConfident` is what that surface now asks, and it is
 * the one definition — the server's bit when the row carries one, the shared
 * function otherwise.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recorderRowIsConfident } from '../recorder';
import type { RecorderMatch } from '../recorder';

const match = (over: Partial<RecorderMatch> = {}): RecorderMatch => ({
  event_key: 'evt-1|2026-09-22T09:00:00.000Z',
  event_id: 'evt-1',
  meeting_code: 'abc-defg-hij',
  occ_start: '2026-09-22T09:00:00.000Z',
  title: 'Triton next steps!',
  overlap: 0.98,
  title_score: 0.8,
  score: 0.91,
  candidates: [],
  matched_at: '2026-09-22T09:50:00.000Z',
  ...over,
});

describe('recorderRowIsConfident', () => {
  test('no row, no match → never', () => {
    expect(recorderRowIsConfident(null)).toBe(false);
    expect(recorderRowIsConfident(undefined)).toBe(false);
    expect(recorderRowIsConfident({ matched: null })).toBe(false);
    expect(recorderRowIsConfident({ matched: null, matched_confident: true })).toBe(false);
  });

  test('the server’s bit wins when the row carries one', () => {
    expect(recorderRowIsConfident({ matched: match(), matched_confident: true })).toBe(true);
    // Even over numbers that look strong: the server saw the whole picture
    // (the provider veto reads `call_provider`, which the row may not show).
    expect(recorderRowIsConfident({ matched: match(), matched_confident: false })).toBe(false);
  });

  test('without the bit it falls back to the ONE definition', () => {
    expect(recorderRowIsConfident({ matched: match() })).toBe(true);
    // The 17:03 fixture: a Slack DM against a Teams invite at 0.3.
    expect(
      recorderRowIsConfident({
        matched: match({ score: 0.3, title_score: 0, provider: 'teams', call_provider: 'slack' }),
      })
    ).toBe(false);
    // The 15:56 one: clocks overlap, nothing else agrees.
    expect(recorderRowIsConfident({ matched: match({ score: 0.7, title_score: 0 }) })).toBe(false);
  });

  test('a row the surface may not offer is not one click from a link', () => {
    // What the Recordings card asks before it renders "Link to it".
    const weak = { matched: match({ score: 0.3, title_score: 0 }) };
    expect(recorderRowIsConfident(weak) && !!weak.matched.event_key).toBe(false);
  });
});

describe('the Recordings surface asks it', () => {
  const src = readFileSync(join(import.meta.dir, '..', '..', 'components/recordings-surface.tsx'), 'utf8');

  test('both MatchHint call sites go through the gate', () => {
    // A hint at all…
    expect(src).toContain('<MatchHint m={recorderRowIsConfident(r) ? r.matched : null} />');
    // …and the one-click Link, which is the part that linked a DM.
    expect(src).toContain("m={recorderRowIsConfident(reg) ? reg!.matched : null}");
    expect(src).toContain('onLink={recorderRowIsConfident(reg) && reg!.matched!.event_key && !placeholder');
    // No raw `r.matched` / `reg?.matched` reaches a hint unguarded.
    expect(src).not.toContain('<MatchHint m={r.matched}');
    expect(src).not.toContain('<MatchHint m={reg?.matched');
  });

  test('the stale "the server links a confident match at upload open" comment is gone', () => {
    expect(src).not.toContain('The server links a confident calendar match at upload open');
    // …and so is the empty state that promised the same auto-link.
    expect(src).not.toContain('Every recording belongs to a meeting');
  });
});

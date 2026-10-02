/**
 * Page → band search echo (desktop shell 0.3.3): the payload shape, the
 * feature-detect guard (no API = nothing happens), never awaiting / rejecting,
 * the change-only echoer, and the band's `scope: null` (chip removed).
 */
import { describe, expect, test } from 'bun:test';
import {
  ECHO_FALLBACK_LABEL,
  ECHO_LABEL_MAX,
  ECHO_QUERY_MAX,
  bandEcho,
  bandRemovedScope,
  createBandEchoer,
  desktopSearchEcho,
  echoToBand,
  type SearchEcho,
} from '../shell-search-echo';
import { SHELL_SIGNALS, shellSearchDetail, subscribeShellSignals, type ShellSearchDetail } from '../shell-signals';

function shellWindow(echo: (d: SearchEcho) => unknown) {
  return { darthDesktop: { search: { echo } } };
}

describe('bandEcho — the shell contract shape', () => {
  test('a scope becomes {kind:"meeting", id, label}', () => {
    expect(bandEcho('budget', { id: 'tx-1', title: 'Weekly sync' })).toEqual({
      query: 'budget',
      scope: { kind: 'meeting', id: 'tx-1', label: 'Weekly sync' },
    });
  });
  test('no scope → scope null; empty query stays empty', () => {
    expect(bandEcho('', null)).toEqual({ query: '', scope: null });
  });
  test('query cut to 512, label to 4096; blank title → fallback label', () => {
    const e = bandEcho('x'.repeat(600), { id: 'a', title: 't'.repeat(5000) });
    expect(e.query.length).toBe(ECHO_QUERY_MAX);
    expect(e.scope?.label.length).toBe(ECHO_LABEL_MAX);
    expect(bandEcho('q', { id: 'a', title: '   ' }).scope?.label).toBe(ECHO_FALLBACK_LABEL);
    expect(bandEcho('q', { id: 'a', title: '' }).scope?.label).toBe(ECHO_FALLBACK_LABEL);
  });
  test('an id the shell would refuse (empty / > 200 chars) sends no scope', () => {
    expect(bandEcho('q', { id: '', title: 'T' }).scope).toBeNull();
    expect(bandEcho('q', { id: 'i'.repeat(201), title: 'T' }).scope).toBeNull();
    expect(bandEcho('q', { id: 'i'.repeat(200), title: 'T' }).scope?.id.length).toBe(200);
  });
});

describe('echoToBand — guarded, fire and forget', () => {
  test('sends the shaped payload when the API exists', () => {
    const seen: SearchEcho[] = [];
    const w = shellWindow((d) => {
      seen.push(d);
      return Promise.resolve({ ok: true, shown: true });
    });
    expect(echoToBand('q', { id: 'm', title: 'M' }, w)).toBe(true);
    expect(seen).toEqual([{ query: 'q', scope: { kind: 'meeting', id: 'm', label: 'M' } }]);
  });

  test('absent API (browser, older shell, no echo function) → nothing, no throw', () => {
    expect(desktopSearchEcho({})).toBeNull();
    expect(desktopSearchEcho({ darthDesktop: {} })).toBeNull();
    expect(desktopSearchEcho({ darthDesktop: { store: {} } })).toBeNull();
    expect(desktopSearchEcho({ darthDesktop: { search: {} } })).toBeNull();
    expect(desktopSearchEcho({ darthDesktop: { search: { echo: 'nope' } } })).toBeNull();
    expect(echoToBand('q', null, {})).toBe(false);
  });

  test('no window at all (bun test / SSR) → false', () => {
    expect(typeof window).toBe('undefined');
    expect(desktopSearchEcho()).toBeNull();
    expect(echoToBand('q', null)).toBe(false);
  });

  test('a rejecting or throwing bridge never surfaces', async () => {
    const rejecting = shellWindow(() => Promise.reject(new Error('IPC')));
    expect(echoToBand('q', null, rejecting)).toBe(true);
    const throwing = shellWindow(() => {
      throw new Error('boom');
    });
    expect(() => echoToBand('q', null, throwing)).not.toThrow();
    // Give an unhandled rejection a tick to surface (it must not).
    await new Promise((r) => setTimeout(r, 0));
  });

  test('echo is called with its own object as `this`', () => {
    let self: unknown = null;
    const search = {
      echo(this: unknown) {
        self = this;
      },
    };
    echoToBand('q', null, { darthDesktop: { search } });
    expect(self).toBe(search);
  });
});

describe('createBandEchoer — only on a change', () => {
  test('the first closed/empty state sends nothing (a reload keeps the band text)', () => {
    const sent: [string, string | null][] = [];
    const echo = createBandEchoer((q, s) => sent.push([q, s?.id ?? null]));
    echo('', null);
    echo('', null);
    expect(sent).toEqual([]);
  });

  test('query, chip set, chip title change, chip cleared, close — each once', () => {
    const sent: SearchEcho[] = [];
    const echo = createBandEchoer((q, s) => sent.push(bandEcho(q, s)));
    echo('bud', null);
    echo('bud', null); // re-render: no second echo
    echo('bud', { id: 'm1', title: 'Sync' }); // Enter applied the chip
    echo('bud', { id: 'm1', title: 'Sync' }); // same chip, new object
    echo('bud', { id: 'm1', title: 'Sync 2' }); // meeting renamed
    echo('bud', null); // chip removed
    echo('', null); // panel closed
    expect(sent).toEqual([
      { query: 'bud', scope: null },
      { query: 'bud', scope: { kind: 'meeting', id: 'm1', label: 'Sync' } },
      { query: 'bud', scope: { kind: 'meeting', id: 'm1', label: 'Sync 2' } },
      { query: 'bud', scope: null },
      { query: '', scope: null },
    ]);
  });

  test('a recent picked in the panel echoes its query and chip', () => {
    const sent: SearchEcho[] = [];
    const echo = createBandEchoer((q, s) => sent.push(bandEcho(q, s)));
    echo('', null); // empty Enter opened the panel on its suggestions
    echo('roadmap', { id: 'm2', title: 'Planning' });
    expect(sent).toEqual([{ query: 'roadmap', scope: { kind: 'meeting', id: 'm2', label: 'Planning' } }]);
  });

  test('the default sender is the guarded echoToBand (no window → silent)', () => {
    const echo = createBandEchoer();
    expect(() => echo('q', { id: 'm', title: 'M' })).not.toThrow();
  });
});

describe('scope: null from the band — the chip was removed', () => {
  const search = (detail: unknown) => new CustomEvent(SHELL_SIGNALS.search, { detail });

  test('shellSearchDetail passes scope:null through; no key stays absent', () => {
    expect(shellSearchDetail(search({ query: 'q', submit: false, scope: null }))).toEqual({
      query: 'q',
      submit: false,
      scope: null,
    });
    const plain = shellSearchDetail(search({ query: 'q', submit: false }));
    expect(plain).toEqual({ query: 'q', submit: false });
    expect(plain && 'scope' in plain).toBe(false);
  });

  test('a non-null scope from the band is ignored (the page owns its scope)', () => {
    const d = shellSearchDetail(search({ query: 'q', submit: true, scope: { kind: 'meeting', id: 'x', label: 'X' } }));
    expect(d).toEqual({ query: 'q', submit: true });
    expect(bandRemovedScope(d)).toBe(false);
  });

  test('bandRemovedScope: only a present null', () => {
    expect(bandRemovedScope({ scope: null })).toBe(true);
    expect(bandRemovedScope({})).toBe(false);
    expect(bandRemovedScope({ scope: undefined })).toBe(false);
    expect(bandRemovedScope(null)).toBe(false);
    expect(bandRemovedScope(undefined)).toBe(false);
  });

  test('Esc in the band (clear + chip removed) reaches the handler as one event', () => {
    const target = new EventTarget();
    const got: ShellSearchDetail[] = [];
    subscribeShellSignals(target, { search: (d) => got.push(d), toggleSidebar: () => {} });
    target.dispatchEvent(search({ query: '', submit: false, scope: null }));
    expect(got).toEqual([{ query: '', submit: false, scope: null }]);
    expect(bandRemovedScope(got[0])).toBe(true);
  });
});

/**
 * The desktop shell → page signals over a plain EventTarget (no DOM):
 * `darth-shell:search` {query, submit} and `darth-shell:toggle-sidebar`.
 */
import { describe, expect, test } from 'bun:test';
import {
  SHELL_SIGNALS,
  shellSearchAction,
  shellSearchDetail,
  subscribeShellSignals,
  type ShellSearchDetail,
} from '../shell-signals';

function rig() {
  const target = new EventTarget();
  const searches: ShellSearchDetail[] = [];
  let toggles = 0;
  const off = subscribeShellSignals(target, {
    search: (d) => searches.push(d),
    toggleSidebar: () => toggles++,
  });
  return { target, searches, toggles: () => toggles, off };
}

const search = (detail: unknown) => new CustomEvent(SHELL_SIGNALS.search, { detail });

describe('subscribeShellSignals', () => {
  test('search events reach the handler with the contract detail', () => {
    const r = rig();
    r.target.dispatchEvent(search({ query: 'bud', submit: false }));
    r.target.dispatchEvent(search({ query: 'budget', submit: true }));
    r.target.dispatchEvent(search({ query: '', submit: false }));
    expect(r.searches).toEqual([
      { query: 'bud', submit: false },
      { query: 'budget', submit: true },
      { query: '', submit: false },
    ]);
  });

  test('malformed details are dropped; a non-boolean submit is false', () => {
    const r = rig();
    r.target.dispatchEvent(search(null));
    r.target.dispatchEvent(search({ submit: true }));
    r.target.dispatchEvent(search({ query: 42 }));
    r.target.dispatchEvent(new Event(SHELL_SIGNALS.search));
    r.target.dispatchEvent(search({ query: 'x', submit: 'yes' }));
    expect(r.searches).toEqual([{ query: 'x', submit: false }]);
  });

  test('toggle-sidebar fires its handler; new-chat is not listened for', () => {
    const r = rig();
    r.target.dispatchEvent(new CustomEvent(SHELL_SIGNALS.toggleSidebar));
    r.target.dispatchEvent(new CustomEvent(SHELL_SIGNALS.newChat));
    expect(r.toggles()).toBe(1);
    expect(r.searches).toEqual([]);
  });

  test('the unsubscribe removes every listener', () => {
    const r = rig();
    r.off();
    r.target.dispatchEvent(search({ query: 'after', submit: true }));
    r.target.dispatchEvent(new CustomEvent(SHELL_SIGNALS.toggleSidebar));
    expect(r.searches).toEqual([]);
    expect(r.toggles()).toBe(0);
  });
});

describe('shellSearchDetail', () => {
  test('reads the detail shape', () => {
    expect(shellSearchDetail(search({ query: 'q', submit: true }))).toEqual({ query: 'q', submit: true });
    expect(shellSearchDetail(search(undefined))).toBeNull();
  });
});

describe('shellSearchAction — never two panels', () => {
  test('closed: a non-empty query opens, an empty one / whitespace is ignored', () => {
    expect(shellSearchAction(false, { query: 'q', submit: false })).toBe('open');
    expect(shellSearchAction(false, { query: 'q', submit: true })).toBe('open');
    expect(shellSearchAction(false, { query: '', submit: false })).toBe('ignore');
    expect(shellSearchAction(false, { query: '   ', submit: true })).toBe('ignore');
  });
  test('open: every event (a clear included) updates in place', () => {
    expect(shellSearchAction(true, { query: 'q', submit: false })).toBe('update');
    expect(shellSearchAction(true, { query: '', submit: false })).toBe('update');
    expect(shellSearchAction(true, { query: 'q', submit: true })).toBe('update');
  });
});

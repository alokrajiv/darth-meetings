/**
 * The listing's ONE layout (README "Darth desktop shell" → Layout rules):
 * which controls exist in the shell vs the browser, the one-row toolbar,
 * the Filter badge count, the import split button, the account menu, the
 * theme boot script — pure functions plus static renders (no DOM).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FilterPopover,
  ListingToolbar,
  MoreMenu,
  ToolbarSearch,
} from '@/components/listing-toolbar';
import { ImportSplitButton } from '@/components/import-split-button';
import { AccountMenu } from '@/components/account-menu';
import { RowMenu } from '@/components/row-menu';
import {
  THEME_BOOT_SCRIPT,
  THEME_SHELL_NOTE,
  accountMenuItems,
  filterBadgeCount,
  filterSections,
  moreMenuItems,
  searchShortcutEnabled,
  toolbarControls,
  type FilterBadgeInput,
} from '../listing-layout';

const ALL_ON = { archive: true, unimported: true, norec: true };

describe('toolbar composition', () => {
  test('shell: tabs | Filter · ⋯ — no in-app search, no / shortcut', () => {
    expect(toolbarControls(true)).toEqual({ left: ['tabs'], right: ['filter', 'more'] });
    expect(searchShortcutEnabled(true)).toBe(false);
  });
  test('browser: tabs | search · Filter · ⋯ — search on the same row, / works', () => {
    expect(toolbarControls(false)).toEqual({ left: ['tabs'], right: ['search', 'filter', 'more'] });
    expect(searchShortcutEnabled(false)).toBe(true);
  });
  test('ONE Filter control and ONE ⋯ in either mode', () => {
    for (const shell of [true, false]) {
      const all = [...toolbarControls(shell).left, ...toolbarControls(shell).right];
      expect(all.filter((c) => c === 'filter')).toHaveLength(1);
      expect(all.filter((c) => c === 'more')).toHaveLength(1);
    }
  });
  test('Filter popover sections; Hidden only when something is hidden', () => {
    expect(filterSections({ hiddenCount: 0 })).toEqual(['layers', 'labels', 'range', 'people']);
    expect(filterSections({ hiddenCount: 2 })).toEqual(['layers', 'labels', 'range', 'people', 'hidden']);
  });
  test('⋯ menu: sync only with the calendar timeline on; refresh + columns always', () => {
    expect(moreMenuItems({ calendarSync: true })).toEqual(['sync', 'refresh', 'columns']);
    expect(moreMenuItems({ calendarSync: false })).toEqual(['refresh', 'columns']);
  });
});

describe('filterBadgeCount', () => {
  const base: FilterBadgeInput = {
    layers: ALL_ON,
    layersApply: true,
    rangePreset: 'all',
    labelFilterActive: false,
    peopleTerms: 0,
  };
  test('nothing set → 0', () => {
    expect(filterBadgeCount(base)).toBe(0);
  });
  test('a layer off counts once — only where layers apply', () => {
    const off = { ...ALL_ON, norec: false, unimported: false };
    expect(filterBadgeCount({ ...base, layers: off })).toBe(1);
    expect(filterBadgeCount({ ...base, layers: off, layersApply: false })).toBe(0);
  });
  test('range and label count once each; every people term counts', () => {
    expect(filterBadgeCount({ ...base, rangePreset: 'thisWeek' })).toBe(1);
    expect(filterBadgeCount({ ...base, labelFilterActive: true })).toBe(1);
    expect(filterBadgeCount({ ...base, peopleTerms: 3 })).toBe(3);
    expect(
      filterBadgeCount({
        layers: { ...ALL_ON, archive: false },
        layersApply: true,
        rangePreset: 'month',
        labelFilterActive: true,
        peopleTerms: 2,
      })
    ).toBe(5);
  });
  test('negative term counts never subtract', () => {
    expect(filterBadgeCount({ ...base, peopleTerms: -4 })).toBe(0);
  });
});

const toolbarHtml = (inDesktopShell: boolean) =>
  renderToStaticMarkup(
    <ListingToolbar
      inDesktopShell={inDesktopShell}
      tabs={<span data-tabs>All Mine Shared Trash</span>}
      search={<ToolbarSearch value="" onChange={() => {}} inDesktopShell={inDesktopShell} />}
      filter={
        <FilterPopover count={2}>
          <p>sections</p>
        </FilterPopover>
      }
      more={
        <MoreMenu>
          <p>more</p>
        </MoreMenu>
      }
    />
  );

describe('ListingToolbar (static render)', () => {
  test('one row: nowrap container, tabs scroll horizontally, right cluster never shrinks', () => {
    for (const shell of [true, false]) {
      const html = toolbarHtml(shell);
      const root = html.match(/<div data-listing-toolbar[^>]*class="([^"]+)"/)?.[1] ?? '';
      expect(root).toContain('flex-nowrap');
      expect(root).not.toContain('flex-wrap ');
      expect(html).not.toMatch(/class="[^"]*\bflex-wrap\b/);
      expect(html).toMatch(/data-toolbar-left="true" class="[^"]*overflow-x-auto/);
      expect(html).toMatch(/data-toolbar-right="true" class="[^"]*shrink-0[^"]*flex-nowrap/);
      expect(html.match(/data-filter-button/g)).toHaveLength(1);
      expect(html.match(/data-more-button/g)).toHaveLength(1);
    }
  });

  test('shell: no search field, no / hint; order Filter then ⋯', () => {
    const html = toolbarHtml(true);
    expect(html).toContain('data-toolbar-mode="shell"');
    expect(html).not.toContain('meetings-search-input');
    expect(html).not.toContain('data-search-shortcut');
    expect(html.indexOf('data-toolbar-control="filter"')).toBeLessThan(
      html.indexOf('data-toolbar-control="more"')
    );
    expect(html).not.toContain('data-toolbar-control="search"');
  });

  test('browser: compact 240 px search with the / hint, left of Filter', () => {
    const html = toolbarHtml(false);
    expect(html).toContain('data-toolbar-mode="browser"');
    expect(html).toContain('data-testid="meetings-search-input"');
    expect(html).toContain('w-[240px]');
    expect(html).toContain('focus:w-[320px]');
    expect(html).toMatch(/data-search-shortcut[^>]*>\/<\/kbd>/);
    const s = html.indexOf('data-toolbar-control="search"');
    const f = html.indexOf('data-toolbar-control="filter"');
    expect(s).toBeGreaterThan(-1);
    expect(s).toBeLessThan(f);
  });
});

describe('FilterPopover badge', () => {
  test('no badge at 0, the count otherwise', () => {
    const none = renderToStaticMarkup(<FilterPopover count={0}>x</FilterPopover>);
    expect(none).not.toContain('data-filter-badge');
    const three = renderToStaticMarkup(<FilterPopover count={3}>x</FilterPopover>);
    expect(three).toMatch(/data-filter-badge[^>]*>3<\/span>/);
  });
  test('open: holds the host sections and Clear all', () => {
    const html = renderToStaticMarkup(
      <FilterPopover count={1} defaultOpen onClearAll={() => {}}>
        <p data-section>Layers</p>
      </FilterPopover>
    );
    expect(html).toContain('data-filter-popover');
    expect(html).toContain('data-section');
    expect(html).toContain('Clear all filters');
  });
  test('disabled (offline): no popover even when asked open', () => {
    const html = renderToStaticMarkup(
      <FilterPopover count={1} disabled defaultOpen>
        x
      </FilterPopover>
    );
    expect(html).not.toContain('data-filter-popover');
  });
});

describe('ImportSplitButton', () => {
  test('primary = Import meeting; the menu = Import from…, Upload media', () => {
    const html = renderToStaticMarkup(<ImportSplitButton onAction={() => {}} defaultOpen />);
    expect(html).toMatch(/data-import-primary[^]*?Import meeting/);
    const items = [...html.matchAll(/data-import-item="([^"]+)"/g)].map((m) => m[1]);
    expect(items).toEqual(['import-file', 'upload-media']);
    expect(html).toContain('Import from…');
    expect(html).toContain('Upload media');
    expect(html.match(/data-import-item="import-meeting"/)).toBeNull();
  });
  test('closed: only the two halves render', () => {
    const html = renderToStaticMarkup(<ImportSplitButton onAction={() => {}} />);
    expect(html).toContain('data-import-primary');
    expect(html).toContain('data-import-more');
    expect(html).not.toContain('role="menu"');
  });
});

describe('account menu', () => {
  test('items per mode', () => {
    expect(accountMenuItems(true)).toEqual(['settings', 'theme-shell', 'sign-out']);
    expect(accountMenuItems(false)).toEqual(['settings', 'theme-toggle', 'sign-out']);
  });
  test('shell: "Theme · set in Darth", no toggle', () => {
    const html = renderToStaticMarkup(<AccountMenu inDesktopShell defaultOpen />);
    const items = [...html.matchAll(/data-account-item="([^"]+)"/g)].map((m) => m[1]);
    expect(items).toEqual(['settings', 'theme-shell', 'sign-out']);
    expect(html).toContain(THEME_SHELL_NOTE);
    expect(html).not.toContain('Dark theme');
  });
  test('browser: the light/dark toggle, no Darth note', () => {
    const html = renderToStaticMarkup(<AccountMenu inDesktopShell={false} defaultOpen />);
    const items = [...html.matchAll(/data-account-item="([^"]+)"/g)].map((m) => m[1]);
    expect(items).toEqual(['settings', 'theme-toggle', 'sign-out']);
    expect(html).toContain('Dark theme');
    expect(html).not.toContain(THEME_SHELL_NOTE);
    expect(html).toContain('href="/settings"');
    expect(html).toContain('Sign out');
  });
});

describe('THEME_BOOT_SCRIPT', () => {
  type Listener = (e: { matches: boolean }) => void;
  const run = (opts: { shell: boolean; stored: string | null; dark: boolean }) => {
    const classes = new Set<string>();
    const listeners: Listener[] = [];
    const documentElement = {
      getAttribute: (n: string) => (n === 'data-shell' && opts.shell ? 'desktop' : null),
      classList: {
        add: (c: string) => classes.add(c),
        toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
      },
    };
    const mm = { matches: opts.dark, addEventListener: (_: string, fn: Listener) => listeners.push(fn) };
    new Function('document', 'matchMedia', 'localStorage', THEME_BOOT_SCRIPT)(
      { documentElement },
      () => mm,
      { getItem: () => opts.stored }
    );
    return { dark: () => classes.has('dark'), fire: (m: boolean) => listeners.forEach((f) => f({ matches: m })), listeners };
  };

  test('shell: follows prefers-color-scheme, ignores a stored choice, keeps following', () => {
    const r = run({ shell: true, stored: 'light', dark: true });
    expect(r.dark()).toBe(true);
    expect(r.listeners).toHaveLength(1);
    r.fire(false);
    expect(r.dark()).toBe(false);
    expect(run({ shell: true, stored: 'dark', dark: false }).dark()).toBe(false);
  });
  test('browser: the stored choice wins, else the OS; no live listener', () => {
    expect(run({ shell: false, stored: 'dark', dark: false }).dark()).toBe(true);
    expect(run({ shell: false, stored: 'light', dark: true }).dark()).toBe(false);
    const r = run({ shell: false, stored: null, dark: true });
    expect(r.dark()).toBe(true);
    expect(r.listeners).toHaveLength(0);
  });
});

describe('table: row action + columns', () => {
  test('"Add recording" is a hover/focus icon with a tooltip, not a labelled button', () => {
    const html = renderToStaticMarkup(
      <RowMenu
        trigger="icon"
        ariaLabel="Add recording"
        triggerIcon={<svg data-plus />}
        sections={[{ key: 'w', items: [{ key: 'a', label: 'In a file — upload…', onSelect: () => {} }] }]}
      />
    );
    expect(html).toContain('aria-label="Add recording"');
    expect(html).toContain('title="Add recording"');
    expect(html).toContain('opacity-0 group-hover:opacity-100 focus-visible:opacity-100');
    expect(html).toContain('[@media(hover:none)]:opacity-100');
    expect(html).not.toMatch(/>Add recording</);
    expect(html).toContain('h-7 w-7');
  });

  const table = readFileSync(join(import.meta.dir, '../../components/transcript-table.tsx'), 'utf8');
  test('no Labels column; Owner · Duration · Speakers right-aligned with fixed widths', () => {
    expect(table).toContain("type ColKey = 'owner' | 'date' | 'duration' | 'speakers' | 'language' | 'imported';");
    const order = table.match(/const DEFAULT_COL_ORDER: ColKey\[\] = \[([^\]]+)\]/)?.[1] ?? '';
    expect(order).not.toContain("'labels'");
    for (const k of ['owner', 'duration', 'speakers']) {
      expect(table).toMatch(new RegExp(`${k}: 'w-\\[\\d+px\\]'`));
      expect(table).toMatch(new RegExp(`const COL_ALIGN[^]*?${k}: 'text-right'`));
    }
  });
  test('the toolbar is the one-row ListingToolbar; the old wrapping row is gone', () => {
    expect(table).toContain('<ListingToolbar');
    expect(table).not.toContain('mb-3 flex flex-wrap items-center gap-x-3');
    expect(table).not.toContain('toolbarExtra');
  });
});

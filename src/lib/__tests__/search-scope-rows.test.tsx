/**
 * The scope pieces of the results panel, rendered statically (no DOM): the
 * `in: <meeting>` chip, the "Search in <title>" suggestion, a Recent searches
 * row with its chip, and a match inside the meeting (time · speaker, bold).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecentSearchRow, ScopeChip, ScopeLineRow, ScopeSuggestionRow } from '@/components/shell-search';

const noop = () => {};

describe('scope rows', () => {
  test('chip: "in:" + title + a remove button that says what it does', () => {
    const html = renderToStaticMarkup(<ScopeChip title="Weekly sync" onRemove={noop} />);
    expect(html).toContain('data-testid="meeting-search-scope-chip"');
    expect(html).toContain('in:');
    expect(html).toContain('Weekly sync');
    expect(html).toContain('aria-label="Remove “in: Weekly sync” — search all meetings"');
  });

  test('suggestion: "Search in <title> for “q”", an option, Enter glyph only when selected', () => {
    const sel = renderToStaticMarkup(
      <ScopeSuggestionRow index={0} title="Weekly sync" query="budget" selected onSelect={noop} onHover={noop} />
    );
    expect(sel).toContain('role="option"');
    expect(sel).toContain('aria-selected="true"');
    expect(sel).toContain('id="meeting-search-item-0"');
    expect(sel).toMatch(/Search in <span class="font-medium">Weekly sync<\/span>/);
    expect(sel).toContain('for “budget”');
    expect(sel).toContain('aria-label="Enter"');
    const idle = renderToStaticMarkup(
      <ScopeSuggestionRow index={0} title="Weekly sync" query="" selected={false} onSelect={noop} onHover={noop} />
    );
    expect(idle).not.toContain('for “');
    expect(idle).not.toContain('aria-label="Enter"');
  });

  test('recent: the chip when it was scoped, the query, a forget button', () => {
    const html = renderToStaticMarkup(
      <RecentSearchRow
        index={2}
        recent={{ q: 'pricing', scope: { id: 'm1', title: 'Weekly sync' }, at: 1 }}
        selected={false}
        onSelect={noop}
        onForget={noop}
        onHover={noop}
      />
    );
    expect(html).toContain('data-testid="meeting-search-recent"');
    expect(html).toContain('data-item-index="2"');
    expect(html).toContain('Weekly sync');
    expect(html).toContain('pricing');
    expect(html).toContain('aria-label="Forget “pricing”"');
    const broad = renderToStaticMarkup(
      <RecentSearchRow index={0} recent={{ q: 'pricing', scope: null, at: 1 }} selected onSelect={noop} onForget={noop} onHover={noop} />
    );
    expect(broad).not.toContain('in:');
  });

  test('line: m:ss · speaker, snippet with marks and ellipses', () => {
    const html = renderToStaticMarkup(
      <ScopeLineRow
        index={0}
        line={{
          index: 41,
          startMs: 754_000,
          speaker: 'Ben',
          snippet: { text: 'so the budget moves', ranges: [[7, 13]], atStart: false, atEnd: true },
        }}
        selected={false}
        onSelect={noop}
        onHover={noop}
      />
    );
    expect(html).toContain('data-utterance="41"');
    expect(html).toContain('12:34');
    expect(html).toContain('Ben');
    expect(html).toMatch(/…<span>so the <\/span><mark class="search-match">budget<\/mark><span> moves<\/span><\/span>/);
  });
});

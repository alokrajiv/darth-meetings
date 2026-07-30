/**
 * Extract markdown headings (h1–h4 by default) from a raw markdown string.
 * Used by the right-rail outline to render a Notion-style ToC of the
 * Notes section, and by the Notes ReactMarkdown component map to assign
 * matching anchor ids on the rendered headings.
 *
 * Slug rules (matched 1:1 by `makeSlugger()` so both sides agree):
 *   - lowercase
 *   - non-word/space chars dropped
 *   - whitespace runs → single hyphen
 *   - duplicate slugs get a numeric suffix (`foo`, `foo-1`, `foo-2`, …)
 *
 * Code blocks are skipped so a `# comment` inside a fenced block doesn't
 * show up in the outline.
 */

export interface MarkdownHeading {
  level: number;
  text: string;
  slug: string;
}

export function slugifyText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * A render-time slugger: instantiate one per ReactMarkdown render so that
 * the duplicate-counter resets but stays in lockstep with the order the
 * markdown components are invoked. Headings can't nest, so the document
 * order matches invocation order in practice.
 */
export function makeSlugger() {
  const counts = new Map<string, number>();
  return (text: string): string => {
    const base = slugifyText(text) || 'section';
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

export function extractHeadings(
  md: string | null | undefined,
  maxLevel = 4
): MarkdownHeading[] {
  if (!md) return [];
  const slug = makeSlugger();
  const out: MarkdownHeading[] = [];
  let inFence = false;
  for (const rawLine of md.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine);
    if (!m) continue;
    const level = m[1]!.length;
    if (level > maxLevel) continue;
    const text = m[2]!.trim();
    if (!text) continue;
    out.push({ level, text, slug: slug(text) });
  }
  return out;
}

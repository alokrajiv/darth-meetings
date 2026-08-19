import 'server-only';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';

const execFileP = promisify(execFile);

/**
 * Best-effort text extraction from uploaded context files, done once at
 * upload time so notes generation just reads `text_content`.
 *
 * Formats:
 *  - plain text family (txt/md/csv/json/vtt/srt…): read as utf8
 *  - rtf: stripped to plain text in pure JS (no unrtf/textutil on the VM)
 *  - pdf: `pdftotext` (poppler-utils, installed on the VM)
 *  - docx/pptx/xlsx: they're zips of XML — `unzip -p` the content parts and
 *    strip tags. Crude but effective for prompt-grounding purposes.
 *
 * Returns { text, status }: status 'ok' (text extracted), 'none' (format we
 * don't attempt), 'failed' (attempted and errored). Output capped.
 */

const MAX_EXTRACT_CHARS = 60_000;
const EXEC_OPTS = { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 } as const;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'vtt', 'srt', 'log', 'html', 'htm', 'xml', 'yaml', 'yml',
]);

function ext(name: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return m ? m[1]!.toLowerCase() : '';
}

/** Destination groups whose content is markup plumbing, not document text. */
const RTF_SKIP_GROUPS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'colorschememapping', 'listtable', 'listoverridetable', 'latentstyles',
  'datastore', 'xmlnstbl', 'header', 'footer',
]);

/**
 * Pure-JS RTF → plain text. RTF is ASCII markup: brace groups, `\control`
 * words, `\'hh` cp1252 escapes and `\uN?` unicode escapes around the actual
 * text. No CLI dependency (`unrtf`/`textutil` aren't on the VM) — walking the
 * source once covers real-world exports (Word, TextEdit, Outlook minutes).
 */
function rtfToText(src: string): string {
  const n = src.length;
  let out = '';
  let i = 0;
  const skipGroup = (start: number): number => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      const c = src[j];
      if (c === '\\') j += 1;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) return j + 1;
    }
    return n;
  };
  while (i < n) {
    const c = src[i]!;
    if (c === '{') {
      // `{\*` marks an ignorable destination; named plumbing groups too.
      const named = /^\{\\([a-z]+)/.exec(src.slice(i, i + 24));
      if (src.startsWith('{\\*', i) || (named && RTF_SKIP_GROUPS.has(named[1]!))) {
        i = skipGroup(i);
      } else {
        i += 1;
      }
      continue;
    }
    if (c === '}') {
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      // Raw newlines are insignificant in RTF — `\par` carries the breaks.
      i += 1;
      continue;
    }
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const rest = src.slice(i + 1, i + 40);
    let m = /^'([0-9a-f]{2})/i.exec(rest);
    if (m) {
      out += Buffer.from([parseInt(m[1]!, 16)]).toString('latin1');
      i += 4;
      continue;
    }
    m = /^u(-?\d+) ?/.exec(rest);
    if (m) {
      let code = parseInt(m[1]!, 10);
      if (code < 0) code += 65536;
      out += String.fromCharCode(code);
      i += 1 + m[0].length;
      // Skip the ANSI fallback char that follows \uN (default \uc1).
      if (src.startsWith("\\'", i)) i += 4;
      else if (i < n && src[i] !== '\\' && src[i] !== '{' && src[i] !== '}') i += 1;
      continue;
    }
    m = /^([a-z]{1,32})(-?\d{1,10})? ?/.exec(rest);
    if (m) {
      const word = m[1]!;
      if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') out += '\n';
      else if (word === 'tab' || word === 'cell') out += '\t';
      else if (word === 'emdash') out += '—';
      else if (word === 'endash') out += '–';
      else if (word === 'lquote') out += '‘';
      else if (word === 'rquote') out += '’';
      else if (word === 'ldblquote') out += '“';
      else if (word === 'rdblquote') out += '”';
      else if (word === 'bullet') out += '•';
      i += 1 + m[0].length;
      continue;
    }
    const lit = src[i + 1];
    if (lit === '{' || lit === '}' || lit === '\\') out += lit;
    else if (lit === '~') out += ' ';
    else if (lit === '-' || lit === '_') out += '-';
    else if (lit === '\r' || lit === '\n') {
      // Backslash + raw newline is a paragraph break (Cocoa/TextEdit exports).
      out += '\n';
      if (lit === '\r' && src[i + 2] === '\n') i += 1;
    }
    i += 2;
  }
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripXmlTags(xml: string): string {
  return xml
    // OOXML delimits paragraphs/cells with these closers — keep line breaks.
    .replace(/<\/(w:p|a:p|si|t[rc])>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function unzipParts(absPath: string, pattern: string): Promise<string> {
  const { stdout } = await execFileP('unzip', ['-p', absPath, pattern], EXEC_OPTS);
  return stdout;
}

export async function extractAttachmentText(
  absPath: string,
  originalFilename: string | null,
  mimeType: string | null
): Promise<{ text: string | null; status: 'ok' | 'none' | 'failed' }> {
  const e = ext(originalFilename);
  try {
    // RTF first: its `text/rtf` mime would otherwise hit the plain-text
    // branch below and return control-word soup.
    if (e === 'rtf' || mimeType === 'application/rtf' || mimeType === 'text/rtf') {
      // latin1 keeps raw cp1252 bytes intact (some writers emit them bare).
      const raw = await fsp.readFile(absPath, 'latin1');
      const text = rtfToText(raw).slice(0, MAX_EXTRACT_CHARS);
      return { text: text || null, status: text ? 'ok' : 'failed' };
    }

    if (TEXT_EXTENSIONS.has(e) || mimeType?.startsWith('text/')) {
      const raw = await fsp.readFile(absPath, 'utf8');
      const text = (e === 'html' || e === 'htm' || e === 'xml' ? stripXmlTags(raw) : raw)
        .slice(0, MAX_EXTRACT_CHARS)
        .trim();
      return { text: text || null, status: text ? 'ok' : 'none' };
    }

    if (e === 'pdf' || mimeType === 'application/pdf') {
      const { stdout } = await execFileP('pdftotext', ['-layout', absPath, '-'], EXEC_OPTS);
      const text = stdout.slice(0, MAX_EXTRACT_CHARS).trim();
      return { text: text || null, status: text ? 'ok' : 'failed' };
    }

    if (e === 'docx') {
      const xml = await unzipParts(absPath, 'word/document.xml');
      const text = stripXmlTags(xml).slice(0, MAX_EXTRACT_CHARS);
      return { text: text || null, status: text ? 'ok' : 'failed' };
    }

    if (e === 'pptx') {
      // Slides + their notes, in archive order.
      let xml = '';
      try {
        xml += await unzipParts(absPath, 'ppt/slides/slide*.xml');
      } catch { /* no slides part */ }
      try {
        xml += await unzipParts(absPath, 'ppt/notesSlides/notesSlide*.xml');
      } catch { /* notes are optional */ }
      const text = stripXmlTags(xml).slice(0, MAX_EXTRACT_CHARS);
      return { text: text || null, status: text ? 'ok' : 'failed' };
    }

    if (e === 'xlsx') {
      let xml = '';
      try {
        xml += await unzipParts(absPath, 'xl/sharedStrings.xml');
      } catch { /* fine */ }
      const text = stripXmlTags(xml).slice(0, MAX_EXTRACT_CHARS);
      return { text: text || null, status: text ? 'ok' : 'failed' };
    }

    return { text: null, status: 'none' };
  } catch (err) {
    console.warn('[attachment-extract] failed for', originalFilename, err);
    return { text: null, status: 'failed' };
  }
}

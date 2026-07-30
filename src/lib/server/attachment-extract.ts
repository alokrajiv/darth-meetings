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

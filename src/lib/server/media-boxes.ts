import { promises as fsp } from 'node:fs';

/**
 * ISO-BMFF (mp4 / m4a / mov) top-level box walk: where does `moov` (the
 * index) sit relative to `mdat` (the payload)? A moov-last file cannot
 * stream progressively — the browser needs head + tail before the first
 * frame — and is what media-faststart.ts remuxes.
 *
 * Pure module, no `server-only` marker: unit-tested directly with bun
 * (`__tests__/media-faststart.test.ts`). Instead of `ffprobe -v trace`
 * (parses the whole index) this reads one 16-byte header per top-level box
 * and jumps by the declared size — a handful of positional reads however
 * large the file.
 */

/** Extensions that are ISO-BMFF containers. Anything else (mp3, wav, webm,
 * ogg, flac …) has no moov atom and is left alone. */
const ISO_BMFF_EXT = /\.(mp4|m4a|m4v|mov)$/i;

export function isIsoBmffName(filename: string): boolean {
  return ISO_BMFF_EXT.test(filename);
}

/** Sanity cap on the top-level walk — a real file has < 10 top-level boxes. */
const MAX_TOP_LEVEL_BOXES = 64;

export type MoovLayout =
  /** `moov` precedes `mdat` — streams progressively, nothing to do. */
  | 'moov-first'
  /** `mdat` precedes `moov` — needs the faststart remux. */
  | 'moov-last'
  /** No `mdat` seen before `moov` was found, but no mdat at all either
   * (edge case: header-only files); treated as fine. */
  | 'no-mdat'
  /** Not a parseable ISO-BMFF box sequence (wrong container, truncated). */
  | 'not-isobmff';

/** Positional reader the scanner drives — a file handle in production, a
 * Buffer in tests. Returns fewer bytes than asked at EOF. */
export type ReadAt = (position: number, length: number) => Promise<Uint8Array>;

/**
 * Walk the top-level boxes and report where `moov` sits relative to `mdat`.
 * Pure over `readAt` so it is unit-testable on a Buffer; `scanFileLayout`
 * is the file-backed wrapper.
 */
export async function scanMoovLayout(readAt: ReadAt, fileSize: number): Promise<MoovLayout> {
  let pos = 0;
  let sawMdat = false;
  let sawFtyp = false;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && pos + 8 <= fileSize; i++) {
    const head = await readAt(pos, 16);
    if (head.length < 8) return 'not-isobmff';
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size: number = view.getUint32(0);
    const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit "largesize" follows the type — mdat of a long recording.
      if (head.length < 16) return 'not-isobmff';
      const hi = view.getUint32(8);
      const lo = view.getUint32(12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      // "Extends to end of file" — only legal for the last box.
      size = fileSize - pos;
    }
    if (!/^[\x20-\x7e]{4}$/.test(type)) return 'not-isobmff';
    if (i === 0 && type !== 'ftyp') return 'not-isobmff';
    if (type === 'ftyp') sawFtyp = true;
    if (type === 'moov') return sawMdat ? 'moov-last' : sawFtyp ? 'moov-first' : 'not-isobmff';
    if (type === 'mdat') sawMdat = true;
    if (size < headerLen) return 'not-isobmff';
    pos += size;
  }
  return sawMdat ? 'not-isobmff' : 'no-mdat';
}

/** File-backed scanner. Callers gate on the extension (`isIsoBmffName`)
 * first — this reads the box headers whatever the name says, which is what
 * lets the remux output be verified under its `.tmp` name. */
export async function scanFileLayout(absPath: string): Promise<MoovLayout> {
  const fh = await fsp.open(absPath, 'r');
  try {
    const { size } = await fh.stat();
    const readAt: ReadAt = async (position, length) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead);
    };
    return await scanMoovLayout(readAt, size);
  } finally {
    await fh.close();
  }
}


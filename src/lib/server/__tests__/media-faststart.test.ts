import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFileLayout, scanMoovLayout, type ReadAt } from '@/lib/server/media-boxes';

/** Build a box sequence from [type, payloadBytes] pairs (32-bit sizes). */
function boxes(...parts: Array<[string, number]>): Buffer {
  return Buffer.concat(
    parts.map(([type, payload]) => {
      const b = Buffer.alloc(8 + payload);
      b.writeUInt32BE(8 + payload, 0);
      b.write(type, 4, 'ascii');
      return b;
    })
  );
}

function readerFor(buf: Buffer): ReadAt {
  return async (pos, len) => buf.subarray(pos, Math.min(buf.length, pos + len));
}

describe('scanMoovLayout (synthetic boxes)', () => {
  test('moov before mdat → moov-first', async () => {
    const b = boxes(['ftyp', 24], ['moov', 100], ['mdat', 5000]);
    expect(await scanMoovLayout(readerFor(b), b.length)).toBe('moov-first');
  });

  test('mdat before moov → moov-last', async () => {
    const b = boxes(['ftyp', 24], ['free', 8], ['mdat', 5000], ['moov', 100]);
    expect(await scanMoovLayout(readerFor(b), b.length)).toBe('moov-last');
  });

  test('64-bit largesize mdat is skipped by its declared size', async () => {
    const ftyp = boxes(['ftyp', 24]);
    const payload = 3000;
    const mdat = Buffer.alloc(16 + payload);
    mdat.writeUInt32BE(1, 0); // size == 1 → largesize follows
    mdat.write('mdat', 4, 'ascii');
    mdat.writeUInt32BE(0, 8);
    mdat.writeUInt32BE(16 + payload, 12);
    const b = Buffer.concat([ftyp, mdat, boxes(['moov', 64])]);
    expect(await scanMoovLayout(readerFor(b), b.length)).toBe('moov-last');
  });

  test('size 0 (extends to EOF) on the last box', async () => {
    const b = boxes(['ftyp', 24], ['moov', 64], ['mdat', 100]);
    b.writeUInt32BE(0, 8 + 24 + 8 + 64); // mdat size → 0
    expect(await scanMoovLayout(readerFor(b), b.length)).toBe('moov-first');
  });

  test('non-ISO-BMFF bytes (ID3/mp3, RIFF/wav, webm) → not-isobmff', async () => {
    for (const head of ['ID3\x04\x00\x00\x00\x00\x00\x00', 'RIFF\x24\x00\x00\x00WAVEfmt ', '\x1a\x45\xdf\xa3\x00\x00\x00\x00']) {
      const b = Buffer.from(head, 'latin1');
      expect(await scanMoovLayout(readerFor(b), b.length)).toBe('not-isobmff');
    }
  });

  test('truncated/garbage sizes never loop forever', async () => {
    const b = boxes(['ftyp', 24], ['mdat', 10]);
    b.writeUInt32BE(3, 8 + 24); // mdat size smaller than its header
    expect(await scanMoovLayout(readerFor(b), b.length)).toBe('not-isobmff');
  });
});

const ffmpeg = Bun.which('ffmpeg');

describe.skipIf(!ffmpeg)('scanFileLayout on real ffmpeg output', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mw-faststart-'));
    // Plain AAC encode: ffmpeg's mp4 muxer writes moov at the END by default.
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'aac', join(dir, 'out.m4a')]);
    // Stream-copy remux with +faststart moves moov to the front.
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-i', join(dir, 'out.m4a'), '-c', 'copy', '-movflags', '+faststart', join(dir, 'fs.m4a')]);
    execFileSync(ffmpeg!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'libmp3lame', join(dir, 'out.mp3')]);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('default mp4 mux → moov-last', async () => {
    expect(await scanFileLayout(join(dir, 'out.m4a'))).toBe('moov-last');
  });

  test('+faststart remux → moov-first', async () => {
    expect(await scanFileLayout(join(dir, 'fs.m4a'))).toBe('moov-first');
  });

  test('mp3 → not-isobmff', async () => {
    expect(await scanFileLayout(join(dir, 'out.mp3'))).toBe('not-isobmff');
  });
});

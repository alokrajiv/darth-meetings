/**
 * The pure helpers the browser uploader and the /api/uploads routes share
 * for the blob transit path (src/lib/darth-uploads-shared.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  backoffSeconds,
  blockIdOf,
  blockListXml,
  blocksOf,
  parseUncommitted,
  sanitizeBlobFileName,
  uploadBlobName,
  withQuery,
  UPLOAD_BLOCK_BYTES,
} from '../darth-uploads-shared';

describe('darth-uploads-shared', () => {
  test('block ids are equal-length base64 of the zero-padded index', () => {
    expect(blockIdOf(0)).toBe(btoa('000000'));
    expect(blockIdOf(42)).toBe(btoa('000042'));
    expect(blockIdOf(0).length).toBe(blockIdOf(999999).length);
  });

  test('blocksOf covers the file exactly, last block short', () => {
    const b = blocksOf(10 * UPLOAD_BLOCK_BYTES + 5, UPLOAD_BLOCK_BYTES);
    expect(b.length).toBe(11);
    expect(b[0]).toEqual({ index: 0, start: 0, end: UPLOAD_BLOCK_BYTES });
    expect(b[10]).toEqual({ index: 10, start: 10 * UPLOAD_BLOCK_BYTES, end: 10 * UPLOAD_BLOCK_BYTES + 5 });
    expect(blocksOf(0, UPLOAD_BLOCK_BYTES)).toEqual([]);
    expect(blocksOf(1, UPLOAD_BLOCK_BYTES)).toEqual([{ index: 0, start: 0, end: 1 }]);
  });

  test('withQuery appends to a SAS URL that already has a query', () => {
    const u = withQuery('https://a.blob.core.windows.net/c/u/s/n.mp4?sv=1&sig=x', { comp: 'block', blockid: 'MDAwMDAx' });
    const url = new URL(u);
    expect(url.searchParams.get('sig')).toBe('x');
    expect(url.searchParams.get('comp')).toBe('block');
    expect(url.searchParams.get('blockid')).toBe('MDAwMDAx');
  });

  test('parseUncommitted reads only the uncommitted section', () => {
    const xml = `<?xml version="1.0"?><BlockList><CommittedBlocks><Block><Name>AAA</Name><Size>9</Size></Block></CommittedBlocks><UncommittedBlocks><Block><Name>MDAwMDAw</Name><Size>4194304</Size></Block><Block>
      <Name>MDAwMDAx</Name>
      <Size>17</Size>
    </Block></UncommittedBlocks></BlockList>`;
    const m = parseUncommitted(xml);
    expect([...m.entries()]).toEqual([
      ['MDAwMDAw', 4194304],
      ['MDAwMDAx', 17],
    ]);
    expect(parseUncommitted('<BlockList></BlockList>').size).toBe(0);
  });

  test('blockListXml lists every id as Latest in order', () => {
    expect(blockListXml(['a', 'b'])).toBe('<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>a</Latest><Latest>b</Latest></BlockList>');
  });

  test('backoffSeconds follows the schedule and repeats the last value', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => backoffSeconds(n))).toEqual([1, 2, 4, 8, 15, 30, 30, 30]);
    expect(backoffSeconds(0)).toBe(1);
  });

  test('blob names carry the user and the session; the file name is sanitised', () => {
    expect(uploadBlobName('u1', 's1', sanitizeBlobFileName('2026-09-18 15.34.04 meet part1.mp4'))).toBe('u1/s1/2026-09-18-15.34.04-meet-part1.mp4');
    expect(sanitizeBlobFileName('../../etc/passwd')).toBe('etc/passwd'.replace('/', '-'));
    expect(sanitizeBlobFileName('')).toBe('');
    expect(uploadBlobName('u', 's', '')).toBe('u/s/upload');
    expect(sanitizeBlobFileName('x'.repeat(200) + '.m4a').length).toBeLessThanOrEqual(120);
    expect(sanitizeBlobFileName('x'.repeat(200) + '.m4a').endsWith('.m4a')).toBe(true);
  });
});

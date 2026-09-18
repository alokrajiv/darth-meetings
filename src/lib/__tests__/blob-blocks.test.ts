/**
 * The browser's block uploader (src/lib/blob-blocks.ts) against the fake
 * Azure Blob REST server: a clean upload commits the right bytes; a block
 * that fails twice is retried after the backoff and the blocks already
 * staged are NOT re-sent (the resume rule); a 403 renews the ticket; a
 * blob that is already committed skips straight to done; a spent resume
 * window rejects; abort rejects at once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { uploadBlobBlocks, BlobUploadError } from '../blob-blocks';
import { blockIdOf, type BlobUploadTicket } from '../darth-uploads-shared';
import { startFakeBlobServer, type FakeBlobServer } from '../server/__tests__/helpers/fake-blob-server';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let srv: FakeBlobServer;
beforeAll(() => {
  srv = startFakeBlobServer('meetings');
});
afterAll(() => srv.stop());

function ticketFor(blobName: string, expiresInMs = 3_600_000, blockBytes = 64 * 1024, parallel = 3): BlobUploadTicket {
  return {
    sasUrl: `${srv.url}/meetings/${blobName}?sig=rig&sp=racw`,
    blobName,
    blockBytes,
    parallel,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

const noSleep = async () => {};
const base = { sleep: noSleep, isOnline: () => true, onOnline: () => () => {} };

describe('uploadBlobBlocks', () => {
  test('uploads every block in parallel and commits the exact bytes', async () => {
    const data = new Uint8Array(randomBytes(64 * 1024 * 5 + 123));
    const file = new File([data], 'a.bin', { type: 'video/mp4' });
    const t = ticketFor('u/s1/a.bin');
    const progress: number[] = [];
    await uploadBlobBlocks({ file, ticket: t, renewTicket: async () => t, onProgress: (n) => progress.push(n), ...base });
    expect(srv.state.store.sha256Of('u/s1/a.bin')).toBe(sha(data));
    expect(srv.state.store.blobs.get('u/s1/a.bin')?.contentType).toBe('video/mp4');
    expect(progress[progress.length - 1]).toBe(data.length);
    const puts = srv.state.log.filter((l) => l.includes('comp=block&') || l.includes('comp=block%')).length;
    expect(puts).toBe(6);
  });

  test('a block that fails twice is retried; blocks already staged are not re-sent', async () => {
    srv.state.log.length = 0;
    const data = new Uint8Array(randomBytes(64 * 1024 * 8));
    const file = new File([data], 'b.bin');
    const t = ticketFor('u/s2/b.bin', 3_600_000, 64 * 1024, 1); // serial, so the fault lands deterministically
    const id3 = encodeURIComponent(blockIdOf(3));
    srv.state.faults.push({ match: new RegExp(`PUT .*blockid=${id3.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), status: 500, times: 2 });
    const notes: Array<string | null> = [];
    const resumed: number[] = [];
    await uploadBlobBlocks({ file, ticket: t, renewTicket: async () => t, onNote: (n) => notes.push(n), onResumed: (n) => resumed.push(n), ...base });
    expect(srv.state.store.sha256Of('u/s2/b.bin')).toBe(sha(data));
    // 3 attempts: blocks 0..2 once, block 3 three times, 4..7 once — never a re-send of a staged block.
    const putsOf = (i: number) => srv.state.log.filter((l) => l.startsWith('PUT') && l.includes(`blockid=${encodeURIComponent(blockIdOf(i))}`)).length;
    expect(putsOf(0)).toBe(1);
    expect(putsOf(3)).toBe(3);
    expect(putsOf(7)).toBe(1);
    expect(notes.some((n) => n?.includes('reconnecting'))).toBe(true);
    expect(notes[notes.length - 1]).toBeNull();
    // Each resumed attempt reported the 3 staged blocks.
    expect(resumed).toEqual([3 * 64 * 1024, 3 * 64 * 1024]);
  });

  test('a 403 from Blob renews the ticket on the same blob', async () => {
    const data = new Uint8Array(randomBytes(64 * 1024 * 2));
    const file = new File([data], 'c.bin');
    const t = ticketFor('u/s3/c.bin');
    srv.state.faults.push({ match: /HEAD .*u\/s3\/c\.bin/, status: 403, times: 1 });
    let renewed = 0;
    await uploadBlobBlocks({
      file,
      ticket: t,
      renewTicket: async () => {
        renewed++;
        return t;
      },
      ...base,
    });
    expect(renewed).toBe(1);
    expect(srv.state.store.sha256Of('u/s3/c.bin')).toBe(sha(data));
  });

  test('an expired ticket is renewed before the first call; an already-committed blob is done at once', async () => {
    const data = new Uint8Array(randomBytes(64 * 1024 + 1));
    const file = new File([data], 'd.bin');
    srv.state.store.put('u/s4/d.bin', data);
    const stale = ticketFor('u/s4/d.bin', -1000);
    const fresh = ticketFor('u/s4/d.bin');
    let renewed = 0;
    srv.state.log.length = 0;
    const progress: number[] = [];
    await uploadBlobBlocks({
      file,
      ticket: stale,
      renewTicket: async () => {
        renewed++;
        return fresh;
      },
      onProgress: (n) => progress.push(n),
      ...base,
    });
    expect(renewed).toBe(1);
    expect(progress).toEqual([data.length]);
    expect(srv.state.log.filter((l) => l.startsWith('PUT')).length).toBe(0);
  });

  test('a spent resume window rejects with the last blob error', async () => {
    const data = new Uint8Array(randomBytes(64 * 1024));
    const file = new File([data], 'e.bin');
    const t = ticketFor('u/s5/e.bin');
    srv.state.faults.push({ match: /PUT .*u\/s5\/e\.bin.*comp=block/, status: 500, times: 99 });
    let clock = 0;
    const err = await uploadBlobBlocks({
      file,
      ticket: t,
      renewTicket: async () => t,
      now: () => clock,
      sleep: async () => {
        clock += 10_000;
      },
      isOnline: () => true,
      onOnline: () => () => {},
      resumeWindowMs: 25_000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BlobUploadError);
    expect((err as BlobUploadError).status).toBe(500);
    srv.state.faults.length = 0;
  });

  test('abort rejects with an AbortError', async () => {
    const data = new Uint8Array(randomBytes(64 * 1024 * 4));
    const file = new File([data], 'f.bin');
    const t = ticketFor('u/s6/f.bin');
    const ac = new AbortController();
    const p = uploadBlobBlocks({
      file,
      ticket: t,
      renewTicket: async () => t,
      onProgress: () => ac.abort(),
      signal: ac.signal,
      ...base,
    });
    const err = await p.catch((e) => e);
    expect((err as Error).name).toBe('AbortError');
  });
});

/**
 * The lifted darth-uploads module (src/lib/server/darth-uploads.ts) over
 * the in-memory FakeBlob: config parsing, the write ticket, and the
 * hash-verified pull (happy path, size mismatch, hash mismatch, a read that
 * dies mid-way). Lifted subset of ../chat/test/darth-uploads.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  BlobHashMismatchError,
  createUploadTicket,
  pullBlob,
  uploadsConfigFromEnv,
  type PullSink,
} from '../darth-uploads';
import { DARTH_UPLOADS_ACCOUNT_ENV, DARTH_UPLOADS_CONTAINER_ENV } from '../../darth-uploads-shared';
import { FakeBlob } from './helpers/fake-blob';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function collectSink() {
  const chunks: Uint8Array[] = [];
  const state = { ended: false, aborted: false };
  const sink: PullSink = {
    async write(c) {
      chunks.push(c);
    },
    async end() {
      state.ended = true;
    },
    async abort() {
      state.aborted = true;
    },
  };
  return { sink, state, bytes: () => Buffer.concat(chunks.map((c) => Buffer.from(c))) };
}

describe('uploadsConfigFromEnv', () => {
  test('unset → null; account only → the meetings container', () => {
    expect(uploadsConfigFromEnv({}, 'meetings')).toBeNull();
    expect(uploadsConfigFromEnv({ [DARTH_UPLOADS_ACCOUNT_ENV]: '  ' }, 'meetings')).toBeNull();
    expect(uploadsConfigFromEnv({ [DARTH_UPLOADS_ACCOUNT_ENV]: 'darthuploads' }, 'meetings')).toEqual({ account: 'darthuploads', container: 'meetings' });
    expect(uploadsConfigFromEnv({ [DARTH_UPLOADS_ACCOUNT_ENV]: 'darthuploads', [DARTH_UPLOADS_CONTAINER_ENV]: 'chat' }, 'meetings')).toEqual({ account: 'darthuploads', container: 'chat' });
  });
  test('bad names throw', () => {
    expect(() => uploadsConfigFromEnv({ [DARTH_UPLOADS_ACCOUNT_ENV]: 'Bad_Name' }, 'meetings')).toThrow(/storage account name/);
    expect(() => uploadsConfigFromEnv({ [DARTH_UPLOADS_ACCOUNT_ENV]: 'darthuploads', [DARTH_UPLOADS_CONTAINER_ENV]: '-x' }, 'meetings')).toThrow(/container name/);
  });
});

describe('createUploadTicket', () => {
  test('blob name = user/session/sanitised name; racw SAS for the TTL', async () => {
    const store = new FakeBlob();
    const now = () => 1_000_000;
    const t = await createUploadTicket(store, { userId: 'u1', sessionId: 's1', name: 'my call (1).m4a', ttlMs: 60_000, now });
    expect(t.blobName).toBe('u1/s1/my-call-1.m4a');
    expect(t.expiresAt.getTime()).toBe(1_060_000);
    expect(t.sasUrl).toContain('/meetings/u1/s1/my-call-1.m4a?');
    expect(t.sasUrl).toContain('sp=racw');
    expect(store.calls).toEqual(['sasUrl u1/s1/my-call-1.m4a racw']);
  });
});

describe('pullBlob', () => {
  test('streams the committed blob into the sink and verifies size + sha256', async () => {
    const store = new FakeBlob();
    const data = new Uint8Array(randomBytes(200_001));
    store.put('u/s/f.bin', data);
    const c = collectSink();
    const seen: number[] = [];
    const r = await pullBlob(store, { blobName: 'u/s/f.bin', sha256: sha(data), size: data.length, sink: c.sink, onProgress: (b) => seen.push(b) });
    expect(r.bytes).toBe(data.length);
    expect(r.sha256).toBe(sha(data));
    expect(c.state.ended).toBe(true);
    expect(c.bytes().equals(Buffer.from(data))).toBe(true);
    expect(seen[seen.length - 1]).toBe(data.length);
    expect(store.blobs.has('u/s/f.bin')).toBe(true); // the caller deletes after finalising
  });

  test('a hash mismatch aborts the sink, DELETES the blob and throws', async () => {
    const store = new FakeBlob();
    const data = new Uint8Array(randomBytes(70_000));
    store.put('u/s/f.bin', data);
    const c = collectSink();
    await expect(pullBlob(store, { blobName: 'u/s/f.bin', sha256: '0'.repeat(64), size: data.length, sink: c.sink })).rejects.toBeInstanceOf(BlobHashMismatchError);
    expect(c.state.aborted).toBe(true);
    expect(c.state.ended).toBe(false);
    expect(store.blobs.has('u/s/f.bin')).toBe(false);
  });

  test('a blob larger than the ticket is cut off at once and deleted', async () => {
    const store = new FakeBlob();
    const data = new Uint8Array(randomBytes(300_000));
    store.put('u/s/f.bin', data);
    const c = collectSink();
    const err = await pullBlob(store, { blobName: 'u/s/f.bin', sha256: sha(data), size: 100_000, sink: c.sink }).catch((e) => e);
    expect(err).toBeInstanceOf(BlobHashMismatchError);
    expect((err as BlobHashMismatchError).actual.sha256).toBeNull();
    expect(store.blobs.has('u/s/f.bin')).toBe(false);
  });

  test('a read that dies mid-way aborts the sink but KEEPS the blob for a retry', async () => {
    const store = new FakeBlob();
    const data = new Uint8Array(randomBytes(300_000));
    store.put('u/s/f.bin', data);
    store.failRead = { afterBytes: 100_000, error: new Error('socket hang up') };
    const c = collectSink();
    await expect(pullBlob(store, { blobName: 'u/s/f.bin', sha256: sha(data), size: data.length, sink: c.sink })).rejects.toThrow(/socket hang up/);
    expect(c.state.aborted).toBe(true);
    expect(store.blobs.has('u/s/f.bin')).toBe(true);
  });
});

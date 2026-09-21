/**
 * `FakeBlob` + the four methods the PERMANENT media store adds
 * (`src/lib/server/media-store.ts`): `putStream`, `setMetadata`,
 * `properties` and `readRange` (Stage B's proxy path). A subclass rather
 * than an edit to `fake-blob.ts`, which is
 * the lifted transit fake and stays in step with ../chat.
 *
 * Knobs for the archive's failure paths: `failPutAfterBytes` (a write that
 * dies mid-stream — an interrupted upload, which on real Blob leaves
 * uncommitted blocks and NO committed blob, so the fake leaves the blob
 * absent too), `truncateOnPut` (fewer bytes land than we sent — a partial
 * commit, which the verify catches on size) and `dropMetadataOnSet` (the
 * sha256/kind stamp silently fails to stick).
 */
import { FakeBlob } from './fake-blob';
import type { MediaBlobLike, MediaBlobProperties, MediaPutOptions } from '../../media-store';

export class FakeMediaBlob extends FakeBlob implements MediaBlobLike {
  /** blob name → metadata, as Azure stores it (keys lower-cased on the way out). */
  readonly metadata = new Map<string, Record<string, string>>();
  /** Throw once, after this many bytes have been read off the body. */
  failPutAfterBytes: { bytes: number; error: Error } | null = null;
  /** Commit this many bytes fewer than were sent (a partial commit). */
  truncateOnPut = 0;
  /** Accept `setMetadata` and keep nothing (the stamp did not stick). */
  dropMetadataOnSet = false;

  constructor(container = 'meetings-media', account = 'fakemedia') {
    super(container, account);
  }

  async putStream(
    blobName: string,
    body: ReadableStream<Uint8Array>,
    opts: MediaPutOptions = {}
  ): Promise<{ bytes: number }> {
    this.calls.push(`putStream ${blobName}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
      if (this.failPutAfterBytes && total >= this.failPutAfterBytes.bytes) {
        const err = this.failPutAfterBytes.error;
        this.failPutAfterBytes = null;
        await reader.cancel().catch(() => {});
        // Real Blob commits nothing until Put Block List: an interrupted
        // upload leaves staged blocks and no readable blob.
        this.staged.set(blobName, new Map(chunks.map((c, i) => [String(i), c])));
        throw err;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    const committed = this.truncateOnPut > 0 ? out.subarray(0, Math.max(0, out.byteLength - this.truncateOnPut)) : out;
    this.blobs.set(blobName, { bytes: committed, contentType: opts.contentType });
    this.staged.delete(blobName);
    return { bytes: total };
  }

  async setMetadata(blobName: string, metadata: Record<string, string>): Promise<void> {
    this.calls.push(`setMetadata ${blobName}`);
    if (!this.blobs.has(blobName)) {
      throw Object.assign(new Error(`BlobNotFound: ${blobName}`), { statusCode: 404 });
    }
    if (this.dropMetadataOnSet) return;
    this.metadata.set(
      blobName,
      Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k.toLowerCase(), v]))
    );
  }

  async properties(blobName: string): Promise<MediaBlobProperties | null> {
    this.calls.push(`properties ${blobName}`);
    const b = this.blobs.get(blobName);
    if (!b) return null;
    return {
      bytes: b.bytes.byteLength,
      contentType: b.contentType ?? null,
      metadata: this.metadata.get(blobName) ?? {},
    };
  }

  async readRange(blobName: string, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
    this.calls.push(`readRange ${blobName} ${start}-${end}`);
    const b = this.blobs.get(blobName);
    if (!b) throw Object.assign(new Error(`BlobNotFound: ${blobName}`), { statusCode: 404 });
    const slice = b.bytes.subarray(start, end + 1);
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(slice);
        c.close();
      },
    });
  }

  override async delete(blobName: string): Promise<boolean> {
    this.metadata.delete(blobName);
    return super.delete(blobName);
  }
}

/**
 * `FakeBlob` + the five methods the PERMANENT media store adds
 * (`src/lib/server/media-store.ts`): `putStream`, `setMetadata`,
 * `properties`, `readRange` (Stage B's proxy path) and `copyFromUrl`
 * (Stage C's server-side copy). A subclass rather than an edit to
 * `fake-blob.ts`, which is the lifted transit fake and stays in step
 * with ../chat.
 *
 * Knobs for the archive's failure paths: `failPutAfterBytes` (a write that
 * dies mid-stream — an interrupted upload, which on real Blob leaves
 * uncommitted blocks and NO committed blob, so the fake leaves the blob
 * absent too), `truncateOnPut` (fewer bytes land than we sent — a partial
 * commit, which the verify catches on size), `dropMetadataOnSet` (the
 * sha256/kind stamp silently fails to stick), `failCopy` (the server-side
 * copy is refused — Stage C must fall back to the pull path) and
 * `truncateOnCopy` (a copy that commits fewer bytes than the source).
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
  /** Make `copyFromUrl` reject (Azure refused the copy). */
  failCopy: Error | null = null;
  /** Commit this many bytes fewer than the source has (a partial copy). */
  truncateOnCopy = 0;
  /**
   * Stores this one may copy FROM, by account name: `copyFromUrl` resolves a
   * source URL the way Azure does — it fetches it. The fake's `sasUrl` shape
   * is `https://<account>.blob.fake/<container>/<name>?…`.
   */
  readonly sources = new Map<string, FakeBlob>();

  constructor(container = 'meetings-media', account = 'fakemedia') {
    super(container, account);
  }

  /** Let `copyFromUrl` read from `store` (the transit fake, in Stage C). */
  copySource(store: FakeBlob): void {
    this.sources.set(store.account, store);
  }

  async copyFromUrl(
    blobName: string,
    sourceUrl: string,
    totalBytes: number,
    opts: MediaPutOptions = {}
  ): Promise<{ bytes: number }> {
    // The call log deliberately drops the query string: it is the SAS.
    this.calls.push(`copyFromUrl ${blobName} <- ${sourceUrl.split('?')[0]}`);
    if (this.failCopy) throw this.failCopy;
    const url = new URL(sourceUrl);
    const account = url.hostname.split('.')[0]!;
    const source = this.sources.get(account);
    if (!source) {
      throw Object.assign(new Error(`CannotVerifyCopySource: ${account}`), { statusCode: 404 });
    }
    const name = decodeURIComponent(url.pathname.replace(`/${source.container}/`, ''));
    const entry = source.blobs.get(name);
    if (!entry) {
      throw Object.assign(new Error(`CannotVerifyCopySource: ${name}`), { statusCode: 404 });
    }
    const wanted = entry.bytes.subarray(0, Math.min(totalBytes, entry.bytes.byteLength));
    const committed =
      this.truncateOnCopy > 0
        ? wanted.subarray(0, Math.max(0, wanted.byteLength - this.truncateOnCopy))
        : wanted;
    this.blobs.set(blobName, { bytes: committed, contentType: opts.contentType });
    return { bytes: totalBytes };
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

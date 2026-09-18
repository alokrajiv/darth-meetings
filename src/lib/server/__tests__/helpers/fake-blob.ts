/**
 * In-memory `BlobLike` (src/lib/darth-uploads.ts) for every unit / route test
 * of E8c-7: committed blobs, staged (uncommitted) blocks, a call log, and
 * knobs for the failure paths (a read that throws mid-way, a slow read for
 * the 202 path). test/helpers/fake-blob-server.ts wraps one of these behind
 * the Azure REST subset for the client tests and the browser rig.
 */
import { createHash } from "node:crypto";
import type { BlobLike, BlobSasPermissions, UncommittedBlock } from "../../darth-uploads";

export type FakeBlobEntry = { bytes: Uint8Array; contentType?: string };

export class FakeBlob implements BlobLike {
  readonly account: string;
  readonly container: string;
  /** Committed blobs by name. */
  readonly blobs = new Map<string, FakeBlobEntry>();
  /** Staged blocks by blob name → block id → bytes (insertion order = staging order). */
  readonly staged = new Map<string, Map<string, Uint8Array>>();
  /** Every call, as "<method> <blobName>" (plus the perms for sasUrl). */
  readonly calls: string[] = [];
  /** Read knobs: chunk size, a delay per chunk (ms), an error to throw after `failAfterBytes` bytes. */
  readChunk = 64 * 1024;
  readDelayMs = 0;
  failRead: { afterBytes: number; error: Error } | null = null;
  /** Make `write` reject (the push failure path). */
  failWrite: Error | null = null;

  constructor(container = "meetings", account = "fakeaccount") {
    this.container = container;
    this.account = account;
  }

  // ---- test helpers ----
  put(blobName: string, bytes: Uint8Array, contentType?: string): void {
    this.blobs.set(blobName, { bytes, contentType });
  }
  stageBlock(blobName: string, id: string, bytes: Uint8Array): void {
    let m = this.staged.get(blobName);
    if (!m) this.staged.set(blobName, (m = new Map()));
    m.set(id, bytes);
  }
  /** Put Block List: every id must be staged (else false, nothing changes); the blob becomes the concatenation. */
  commit(blobName: string, ids: readonly string[], contentType?: string): boolean {
    const m = this.staged.get(blobName);
    if (!m) return false;
    for (const id of ids) if (!m.has(id)) return false;
    let total = 0;
    for (const id of ids) total += m.get(id)!.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const id of ids) {
      out.set(m.get(id)!, off);
      off += m.get(id)!.byteLength;
    }
    this.blobs.set(blobName, { bytes: out, contentType });
    this.staged.delete(blobName);
    return true;
  }
  sha256Of(blobName: string): string | null {
    const b = this.blobs.get(blobName);
    return b ? createHash("sha256").update(b.bytes).digest("hex") : null;
  }

  // ---- BlobLike ----
  async sasUrl(blobName: string, perms: BlobSasPermissions, expiresAt: Date): Promise<string> {
    this.calls.push(`sasUrl ${blobName} ${perms}`);
    return `https://${this.account}.blob.fake/${this.container}/${blobName}?sig=fake&sp=${perms}&se=${encodeURIComponent(expiresAt.toISOString())}`;
  }
  async stat(blobName: string): Promise<{ bytes: number } | null> {
    this.calls.push(`stat ${blobName}`);
    const b = this.blobs.get(blobName);
    return b ? { bytes: b.bytes.byteLength } : null;
  }
  async uncommittedBlocks(blobName: string): Promise<UncommittedBlock[]> {
    this.calls.push(`uncommittedBlocks ${blobName}`);
    return [...(this.staged.get(blobName) ?? new Map<string, Uint8Array>()).entries()].map(([id, bytes]) => ({ id, size: bytes.byteLength }));
  }
  async read(blobName: string): Promise<ReadableStream<Uint8Array>> {
    this.calls.push(`read ${blobName}`);
    const b = this.blobs.get(blobName);
    if (!b) throw Object.assign(new Error(`BlobNotFound: ${blobName}`), { statusCode: 404 });
    const bytes = b.bytes;
    const chunk = this.readChunk;
    const delay = this.readDelayMs;
    const fail = this.failRead;
    let off = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (c) => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (fail && off >= fail.afterBytes) {
          c.error(fail.error);
          return;
        }
        if (off >= bytes.byteLength) {
          c.close();
          return;
        }
        const end = Math.min(bytes.byteLength, off + chunk);
        c.enqueue(bytes.subarray(off, end));
        off = end;
      },
    });
  }
  async write(blobName: string, body: ReadableStream<Uint8Array>, opts: { contentType?: string } = {}): Promise<{ bytes: number }> {
    this.calls.push(`write ${blobName}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    if (this.failWrite) throw this.failWrite;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    this.blobs.set(blobName, { bytes: out, contentType: opts.contentType });
    return { bytes: total };
  }
  async delete(blobName: string): Promise<boolean> {
    this.calls.push(`delete ${blobName}`);
    const had = this.blobs.delete(blobName);
    const hadStaged = this.staged.delete(blobName);
    return had || hadStaged;
  }
}

/**
 * Streaming SHA-256 in plain JavaScript (E8c-7, SPEC §20.23-3): the browser
 * hashes a file BEFORE asking for an upload ticket, so the ticket — and the
 * blob name — are keyed on the file's content and a re-pick after a reload
 * resumes against the same blob. `crypto.subtle.digest` cannot stream (it
 * wants the whole buffer), so this is a small vendored implementation
 * (FIPS 180-4, no dependencies), run in a Web Worker over `File.slice` so a
 * 1 GB file never freezes the page.
 *
 * `sha256Factory` is deliberately self-contained (no closure over anything
 * outside it, ES2015 only): the worker's source is its `toString()` plus a
 * message loop (`sha256WorkerSource`), started from a Blob URL — no separate
 * worker file to bundle. test/sha256.test.ts runs the vectors against
 * node:crypto AND evaluates the worker source standalone with `new Function`.
 */

export type Sha256 = {
  update(data: Uint8Array): void;
  /** Hex digest; the instance is spent afterwards. */
  digest(): string;
};

/* eslint-disable no-var -- the factory is ES2015-only on purpose: its toString() IS the worker's source */
/** Everything the hash needs, closed over nothing. Returns `{ create }`. */
export function sha256Factory(): { create(): Sha256 } {
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  var HEX = "0123456789abcdef";
  function create(): Sha256 {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var w = new Uint32Array(64);
    var buf = new Uint8Array(64);
    var bufLen = 0;
    var totalLo = 0; // bytes, low 32 bits
    var totalHi = 0; // bytes, high bits
    var spent = false;
    function block(p: Uint8Array, off: number): void {
      var i: number;
      for (i = 0; i < 16; i++) w[i] = ((p[off + i * 4]! << 24) | (p[off + i * 4 + 1]! << 16) | (p[off + i * 4 + 2]! << 8) | p[off + i * 4 + 3]!) >>> 0;
      for (i = 16; i < 64; i++) {
        var x = w[i - 15]!;
        var y = w[i - 2]!;
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }
    function update(data: Uint8Array): void {
      if (spent) throw new Error("sha256: digest already taken");
      var n = data.length;
      // 64-bit byte count as two 32-bit halves (one call never adds 2^32 bytes, so a single carry suffices).
      var lo = (totalLo + n) >>> 0;
      if (lo < totalLo) totalHi = (totalHi + 1) >>> 0;
      totalLo = lo;
      var off = 0;
      if (bufLen > 0) {
        var take = Math.min(64 - bufLen, n);
        buf.set(data.subarray(0, take), bufLen);
        bufLen += take;
        off = take;
        if (bufLen < 64) return;
        block(buf, 0);
        bufLen = 0;
      }
      while (off + 64 <= n) {
        block(data, off);
        off += 64;
      }
      if (off < n) {
        buf.set(data.subarray(off), 0);
        bufLen = n - off;
      }
    }
    function digest(): string {
      if (spent) throw new Error("sha256: digest already taken");
      spent = true;
      // Length in bits (64-bit big-endian): bytes * 8.
      var bitsLo = (totalLo << 3) >>> 0;
      var bitsHi = ((totalHi << 3) | (totalLo >>> 29)) >>> 0;
      var pad = new Uint8Array(bufLen < 56 ? 64 : 128);
      pad.set(buf.subarray(0, bufLen), 0);
      pad[bufLen] = 0x80;
      var L = pad.length;
      pad[L - 8] = (bitsHi >>> 24) & 0xff; pad[L - 7] = (bitsHi >>> 16) & 0xff; pad[L - 6] = (bitsHi >>> 8) & 0xff; pad[L - 5] = bitsHi & 0xff;
      pad[L - 4] = (bitsLo >>> 24) & 0xff; pad[L - 3] = (bitsLo >>> 16) & 0xff; pad[L - 2] = (bitsLo >>> 8) & 0xff; pad[L - 1] = bitsLo & 0xff;
      block(pad, 0);
      if (L === 128) block(pad, 64);
      var words = [h0, h1, h2, h3, h4, h5, h6, h7];
      var out = "";
      for (var i = 0; i < 8; i++) {
        var v = words[i]!;
        for (var s = 28; s >= 0; s -= 4) out += HEX.charAt((v >>> s) & 0xf);
      }
      return out;
    }
    return { update: update, digest: digest };
  }
  return { create: create };
}
/* eslint-enable no-var */

/** Hex sha256 of a byte array on the main thread (small inputs, tests). */
export function sha256Hex(data: Uint8Array): string {
  const h = sha256Factory().create();
  h.update(data);
  return h.digest();
}

/** Bytes per `File.slice` read inside the worker. */
export const HASH_SLICE_BYTES = 8 * 1024 * 1024;

/**
 * The worker's whole source: the factory plus a message loop. Message in:
 * `{file: Blob, chunk: number}`; messages out: `{pct}` per slice, then
 * `{hex}`, or `{error}`.
 */
export function sha256WorkerSource(): string {
  return `var factory = (${sha256Factory.toString()});
var create = factory().create;
self.onmessage = function (e) {
  var file = e.data.file; var chunk = e.data.chunk; var size = file.size; var off = 0; var h = create();
  function step() {
    if (off >= size) { self.postMessage({ hex: h.digest() }); return; }
    var end = Math.min(size, off + chunk);
    file.slice(off, end).arrayBuffer().then(function (ab) {
      h.update(new Uint8Array(ab)); off = end;
      self.postMessage({ pct: Math.floor((off / size) * 100) });
      step();
    }, function (err) { self.postMessage({ error: String(err && err.message ? err.message : err) }); });
  }
  if (size === 0) { self.postMessage({ hex: h.digest() }); return; }
  step();
};
`;
}

/** True when this browser can hash in a worker (Worker + Blob URLs); false → the caller takes the direct upload with a chip note. */
export function hashingAvailable(): boolean {
  return typeof Worker === "function" && typeof Blob === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/**
 * Hex sha256 of `file`, computed in a worker; `onPct` gets 0..100 per slice.
 * Rejects when the worker fails or `signal` aborts (the worker is terminated).
 */
export function hashFile(file: Blob, onPct?: (pct: number) => void, signal?: AbortSignal, chunk = HASH_SLICE_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("hash cancelled", "AbortError"));
      return;
    }
    const url = URL.createObjectURL(new Blob([sha256WorkerSource()], { type: "text/javascript" }));
    let worker: Worker;
    try {
      worker = new Worker(url);
    } catch (e) {
      URL.revokeObjectURL(url);
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    const onAbort = () => {
      finish();
      reject(new DOMException("hash cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<{ pct?: number; hex?: string; error?: string }>) => {
      const m = e.data;
      if (typeof m.pct === "number") onPct?.(m.pct);
      else if (typeof m.hex === "string") {
        finish();
        resolve(m.hex);
      } else if (typeof m.error === "string") {
        finish();
        reject(new Error(m.error));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(new Error(e.message || "hash worker failed"));
    };
    worker.postMessage({ file, chunk });
  });
}

/**
 * Lifted from ../chat (E8c-7): the vendored streaming SHA-256 (src/lib/
 * sha256.ts) against FIPS 180-4 vectors and node:crypto — one-shot and
 * streamed across every awkward chunk boundary (55/56/64/65 bytes, a 1 MiB
 * run, random splits), a multi-block message, an empty message — plus the
 * worker source evaluated standalone (`new Function`), which is exactly how
 * the browser runs it from a Blob URL.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { HASH_SLICE_BYTES, sha256Factory, sha256Hex, sha256WorkerSource } from "../sha256";

const node = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

describe("sha256Factory", () => {
  test("FIPS 180-4 vectors", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Hex(enc.encode("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"))).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
    const million = new Uint8Array(1_000_000).fill(0x61);
    expect(sha256Hex(million)).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  test("padding boundaries: 55, 56, 63, 64, 65, 119, 120, 128 bytes match node:crypto", () => {
    for (const n of [1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
      const b = randomBytes(n);
      expect(sha256Hex(new Uint8Array(b)), `n=${n}`).toBe(node(b));
    }
  });

  test("streaming: any split of the input gives the one-shot digest", () => {
    const data = new Uint8Array(randomBytes(4096 + 17));
    const want = node(data);
    for (const splits of [[1], [63], [64], [65], [100, 200, 300], [4096], [4096 + 16], [7, 57, 64, 128, 1000, 3000]]) {
      const h = sha256Factory().create();
      let off = 0;
      for (const s of splits) {
        h.update(data.subarray(off, Math.min(data.length, s)));
        off = Math.min(data.length, s);
      }
      h.update(data.subarray(off));
      expect(h.digest(), `splits=${splits.join(",")}`).toBe(want);
    }
    // Byte at a time.
    const one = sha256Factory().create();
    for (let i = 0; i < 300; i++) one.update(data.subarray(i, i + 1));
    one.update(data.subarray(300));
    expect(one.digest()).toBe(want);
  });

  test("a digest can be taken once; a large multi-slice input (12 MiB, HASH_SLICE_BYTES pieces) matches", () => {
    const h = sha256Factory().create();
    h.update(enc.encode("x"));
    h.digest();
    expect(() => h.digest()).toThrow(/already/);
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4099) big[i] = i & 0xff;
    const s = sha256Factory().create();
    for (let off = 0; off < big.length; off += HASH_SLICE_BYTES) s.update(big.subarray(off, Math.min(big.length, off + HASH_SLICE_BYTES)));
    expect(s.digest()).toBe(node(big));
  });

  test("the worker source stands alone: evaluated with new Function, the factory it embeds hashes the vectors", () => {
    const src = sha256WorkerSource();
    // The source references `self`; give it a stub and pull the factory out by evaluating only its prelude.
    const prelude = src.slice(0, src.indexOf("self.onmessage"));
    const factory = new Function(`${prelude}; return factory;`)() as typeof sha256Factory;
    const h = factory().create();
    h.update(enc.encode("abc"));
    expect(h.digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(src).toContain("self.onmessage");
    expect(src).toContain("postMessage({ hex:");
    expect(src).toContain("postMessage({ pct:");
  });

  test("the worker message loop, driven with a stub `self` and a Blob, streams slices and posts pct then hex", async () => {
    const data = new Uint8Array(randomBytes(3 * 1024 + 5));
    const posted: Array<Record<string, unknown>> = [];
    let handler: ((e: { data: { file: Blob; chunk: number } }) => void) | null = null;
    const self = {
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      set onmessage(fn: (e: { data: { file: Blob; chunk: number } }) => void) {
        handler = fn;
      },
    };
    new Function("self", sha256WorkerSource())(self);
    expect(handler).not.toBeNull();
    handler!({ data: { file: new Blob([data]), chunk: 1024 } });
    await new Promise((r) => setTimeout(r, 50));
    const pcts = posted.filter((m) => typeof m.pct === "number").map((m) => m.pct);
    expect(pcts).toEqual([33, 66, 99, 100]);
    expect(posted[posted.length - 1]!.hex).toBe(node(data));
  });
});

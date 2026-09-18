/**
 * A `BlobLike` that speaks the Azure Blob REST subset the browser client
 * uses (Put Block / Get Block List / Put Block List / Get Blob / Get
 * Properties / Delete Blob) over plain `fetch` with NO authentication — the
 * browser rig's store (E8c-7, SPEC §20.23-6): `DARTH_UPLOADS_FAKE_URL`
 * points the app at the fake blob endpoint the rig's fake-auth process
 * serves (test/helpers/fake-blob-server.ts), so the real client code runs
 * the real request shapes end to end against a server on the laptop.
 *
 * Never used against the real account (it has no shared key and the REST
 * calls here carry no SAS). `sasUrl` appends a fixed `sig=rig` query so the
 * client's "append `&comp=…` to the SAS URL" logic is exercised as it is.
 *
 * Node runtime only; no Bun globals.
 */
import type { BlobLike, BlobSasPermissions, UncommittedBlock } from "./darth-uploads";

export type RestStoreConfig = { baseUrl: string; container: string; account?: string };

/** The fixed query the fake store's "SAS" URLs carry (the fake server does not check it; the client treats it as opaque). */
export const REST_FAKE_SIG = "sig=rig";

/** `<Name>…</Name><Size>…</Size>` pairs under `<UncommittedBlocks>` (the same parser shape the client uses). Pure. */
export function parseUncommittedBlocks(xml: string): UncommittedBlock[] {
  const section = /<UncommittedBlocks>([\s\S]*?)<\/UncommittedBlocks>/.exec(xml)?.[1] ?? "";
  const out: UncommittedBlock[] = [];
  for (const m of section.matchAll(/<Block>\s*<Name>([^<]*)<\/Name>\s*<Size>(\d+)<\/Size>\s*<\/Block>/g)) out.push({ id: m[1]!, size: Number(m[2]) });
  return out;
}

export function createRestBlobStore(cfg: RestStoreConfig, fetchFn: typeof fetch = fetch): BlobLike {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const url = (blobName: string) => `${base}/${encodeURIComponent(cfg.container)}/${blobName.split("/").map(encodeURIComponent).join("/")}`;
  return {
    account: cfg.account ?? "fake",
    container: cfg.container,
    async sasUrl(blobName: string, perms: BlobSasPermissions, expiresAt: Date) {
      return `${url(blobName)}?${REST_FAKE_SIG}&sp=${perms}&se=${encodeURIComponent(expiresAt.toISOString())}`;
    },
    async stat(blobName) {
      const res = await fetchFn(url(blobName), { method: "HEAD" });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`rest blob store: HEAD ${blobName} → ${res.status}`);
      return { bytes: Number(res.headers.get("content-length") ?? 0) };
    },
    async uncommittedBlocks(blobName) {
      const res = await fetchFn(`${url(blobName)}?comp=blocklist&blocklisttype=uncommitted`);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`rest blob store: block list ${blobName} → ${res.status}`);
      return parseUncommittedBlocks(await res.text());
    },
    async read(blobName) {
      const res = await fetchFn(url(blobName));
      if (!res.ok || !res.body) throw new Error(`rest blob store: GET ${blobName} → ${res.status}`);
      return res.body;
    },
    async write(blobName, body, opts = {}) {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          bytes += value.byteLength;
        }
      }
      const whole = new Uint8Array(bytes);
      let off = 0;
      for (const c of chunks) {
        whole.set(c, off);
        off += c.byteLength;
      }
      const res = await fetchFn(url(blobName), { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", ...(opts.contentType ? { "content-type": opts.contentType } : {}) }, body: whole });
      if (!res.ok) throw new Error(`rest blob store: PUT ${blobName} → ${res.status}`);
      return { bytes };
    },
    async delete(blobName) {
      const res = await fetchFn(url(blobName), { method: "DELETE" });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`rest blob store: DELETE ${blobName} → ${res.status}`);
      return true;
    },
  };
}

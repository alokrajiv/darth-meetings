/**
 * The Azure Blob REST subset the browser client speaks (E8c-7, SPEC
 * §20.23-3/6), served over a FakeBlob: PUT ?comp=block&blockid=, PUT
 * ?comp=blocklist, GET ?comp=blocklist&blocklisttype=uncommitted, GET / HEAD /
 * DELETE of the blob, PUT of a whole block blob (the REST store's write),
 * and CORS preflights (the browser rig PUTs cross-origin from the app's
 * origin). `handleBlobRequest` is mounted by the rig's fake-auth process
 * under `/blob/` and by `startFakeBlobServer` for the unit tests.
 *
 * Fault injection for the resume tests: `faults` is a list of
 * {match, status, times} — a request whose "<METHOD> <url>" matches gets
 * `status` (or a dropped connection when status is 0) `times` times, then
 * passes. Every request is logged in `log` as "<METHOD> <path>?<query>".
 * Bun only (test helpers).
 */
import { FakeBlob } from "./fake-blob";

export type BlobFault = { match: RegExp; status: number; times: number };

export type FakeBlobState = {
  store: FakeBlob;
  faults: BlobFault[];
  log: string[];
};

export function newFakeBlobState(container = "meetings"): FakeBlobState {
  return { store: new FakeBlob(container), faults: [], log: [] };
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "PUT, GET, HEAD, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
  "access-control-max-age": "3600",
};

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Every request under `prefix` (default "/"): "/<container>/<blobName…>?<query>". Returns null when the path is not under the prefix. */
export async function handleBlobRequest(req: Request, state: FakeBlobState, prefix = "/"): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(prefix)) return null;
  const rel = url.pathname.slice(prefix.length).replace(/^\/+/, "");
  const [containerSeg, ...rest] = rel.split("/");
  const method = req.method.toUpperCase();
  state.log.push(`${method} ${url.pathname}${url.search}`);
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const container = decodeURIComponent(containerSeg ?? "");
  const blobName = rest.map(decodeURIComponent).join("/");
  if (container !== state.store.container || blobName === "") return new Response("<Error><Code>ResourceNotFound</Code></Error>", { status: 404, headers: CORS });
  // Faults first (the resume tests): a matching request fails `times` times.
  const key = `${method} ${url.pathname}${url.search}`;
  for (const f of state.faults) {
    if (f.times > 0 && f.match.test(key)) {
      f.times -= 1;
      if (f.status === 0) throw new Error(`fake-blob: dropping ${key}`); // Bun.serve turns a thrown error into a closed connection
      return new Response(`<Error><Code>Injected</Code></Error>`, { status: f.status, headers: CORS });
    }
  }
  const comp = url.searchParams.get("comp");
  const store = state.store;
  if (method === "PUT" && comp === "block") {
    const id = url.searchParams.get("blockid") ?? "";
    if (!id) return new Response("<Error><Code>InvalidQueryParameterValue</Code></Error>", { status: 400, headers: CORS });
    store.stageBlock(blobName, id, new Uint8Array(await req.arrayBuffer()));
    return new Response(null, { status: 201, headers: CORS });
  }
  if (method === "PUT" && comp === "blocklist") {
    const xml = await req.text();
    const ids = [...xml.matchAll(/<(?:Latest|Uncommitted|Committed)>([^<]*)<\/(?:Latest|Uncommitted|Committed)>/g)].map((m) => m[1]!);
    const ok = store.commit(blobName, ids, req.headers.get("x-ms-blob-content-type") ?? undefined);
    if (!ok) return new Response("<Error><Code>InvalidBlockList</Code></Error>", { status: 400, headers: CORS });
    return new Response(null, { status: 201, headers: CORS });
  }
  if (method === "PUT" && comp === null) {
    // Put Blob (the REST store's write): one body, no blocks.
    const bytes = new Uint8Array(await req.arrayBuffer());
    store.put(blobName, bytes, req.headers.get("content-type") ?? undefined);
    return new Response(null, { status: 201, headers: CORS });
  }
  if (method === "GET" && comp === "blocklist") {
    const staged = store.staged.get(blobName);
    const committed = store.blobs.get(blobName);
    if (!staged && !committed) return new Response("<Error><Code>BlobNotFound</Code></Error>", { status: 404, headers: CORS });
    const type = url.searchParams.get("blocklisttype") ?? "committed";
    const unc = type === "uncommitted" || type === "all" ? [...(staged ?? new Map<string, Uint8Array>()).entries()].map(([id, b]) => `<Block><Name>${xmlEscape(id)}</Name><Size>${b.byteLength}</Size></Block>`).join("") : "";
    const body = `<?xml version="1.0" encoding="utf-8"?><BlockList><CommittedBlocks></CommittedBlocks><UncommittedBlocks>${unc}</UncommittedBlocks></BlockList>`;
    return new Response(body, { status: 200, headers: { ...CORS, "content-type": "application/xml" } });
  }
  const entry = store.blobs.get(blobName);
  if (method === "HEAD") {
    if (!entry) return new Response(null, { status: 404, headers: CORS });
    return new Response(null, { status: 200, headers: { ...CORS, "content-length": String(entry.bytes.byteLength), "content-type": entry.contentType ?? "application/octet-stream" } });
  }
  if (method === "GET") {
    if (!entry) return new Response("<Error><Code>BlobNotFound</Code></Error>", { status: 404, headers: CORS });
    // `.slice()` = a copy on a plain ArrayBuffer (the strict typings refuse an ArrayBufferLike-backed view as a body).
    return new Response(entry.bytes.slice(), { status: 200, headers: { ...CORS, "content-length": String(entry.bytes.byteLength), "content-type": entry.contentType ?? "application/octet-stream" } });
  }
  if (method === "DELETE") {
    const had = await store.delete(blobName);
    return new Response(null, { status: had ? 202 : 404, headers: CORS });
  }
  return new Response("<Error><Code>UnsupportedHttpVerb</Code></Error>", { status: 405, headers: CORS });
}

export type FakeBlobServer = { url: string; port: number; state: FakeBlobState; stop(): void };

/** A standalone server for the unit tests (`url` is the base the REST store / the client's SAS URLs point at). */
export function startFakeBlobServer(container = "meetings", port = 0): FakeBlobServer {
  const state = newFakeBlobState(container);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    maxRequestBodySize: 4 * 1024 * 1024 * 1024,
    async fetch(req) {
      return (await handleBlobRequest(req, state, "/")) ?? new Response("not found", { status: 404 });
    },
    error() {
      return new Response(null, { status: 500 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, port: server.port ?? 0, state, stop: () => server.stop(true) };
}

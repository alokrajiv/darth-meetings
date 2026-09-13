import type { NextConfig } from "next";

// One id per build, baked into both the Next build id and the client bundle:
// the offline sync compares NEXT_PUBLIC_BUILD_ID (via /api/offline/plan)
// against the id it cached pages under and re-fetches documents + static
// chunks when they differ, so a deploy never leaves stale HTML pointing at
// chunks that no longer exist.
//
// `next build` loads this config in MORE THAN ONE process, so the id must be
// deterministic per build or the value inlined into the route chunks differs
// from .next/BUILD_ID. deploy.sh exports BUILD_ID (the VM checkout has no
// .git); a local build falls back to the git short sha; Date.now() is the
// last resort when neither is available.
function resolveBuildId(): string {
  if (process.env.BUILD_ID) return process.env.BUILD_ID;
  try {
    // getBuiltinModule (Node ≥ 22.3) instead of a static import: Turbopack
    // traces a static node:child_process import in the config into the
    // server bundle and warns "unexpected file in NFT list".
    const cp = process.getBuiltinModule?.("node:child_process") as typeof import("node:child_process") | undefined;
    const sha = cp
      ?.execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    /* no git here */
  }
  return String(Date.now());
}
const buildId = resolveBuildId();

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  generateBuildId: () => buildId,
  async headers() {
    return [
      {
        // The service worker must never be served stale: the browser checks
        // it on every navigation and a cached copy would pin an old fetch
        // handler across deploys.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  // Sibling repos under ~/crp-workspace/darth each carry a bun.lock; without this Next 16
  // infers the PARENT folder as the workspace root and Tailwind's PostCSS worker crash-loops
  // ("Can't resolve 'tailwindcss' in '/Users/alokrajiv/crp-workspace/darth'"), spawning thousands of workers.
  turbopack: { root: __dirname },
  experimental: {
    // Body-size cap for proxied routes. The proxy BUFFERS matched request
    // bodies in memory up to this limit (default 10MB, which silently
    // truncates and makes formData() throw) — so audio uploads do NOT go
    // through it: /api/transcripts is excluded from the proxy matcher (see
    // src/proxy.ts) and streams multi-GB bodies straight to disk. This cap
    // only needs to cover the other API routes (JSON edits, imports).
    proxyClientMaxBodySize: 500 * 1024 * 1024, // 500MB in bytes
  },
};

export default nextConfig;

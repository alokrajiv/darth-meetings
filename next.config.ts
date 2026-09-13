import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

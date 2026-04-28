import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Meeting audio files can be 100s of MB. Next 16's proxy (formerly
    // middleware) defaults to 10MB which silently truncates the body and
    // causes formData() to throw "Failed to parse body as FormData".
    proxyClientMaxBodySize: 500 * 1024 * 1024, // 500MB in bytes
  },
};

export default nextConfig;

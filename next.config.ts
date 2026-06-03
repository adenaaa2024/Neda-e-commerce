import type { NextConfig } from "next";

/** ETL traffic is proxied by `app/api/etl/[[...path]]/route.ts` (streaming) — no rewrites needed. */
const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Service-Worker-Allowed", value: "/" },
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      ],
    },
    {
      source: "/manifest.json",
      headers: [{ key: "Content-Type", value: "application/manifest+json; charset=utf-8" }],
    },
  ],
};

export default nextConfig;

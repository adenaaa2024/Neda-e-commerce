import type { NextConfig } from "next";

/** ETL traffic is proxied by `app/api/etl/[[...path]]/route.ts` (streaming) — no rewrites needed. */
const nextConfig: NextConfig = {
  // playwright is only used by local scripts (e.g. filing-packet PDF export). Keep it
  // out of the bundle so Turbopack never tries to process its `.ttf` recorder assets.
  serverExternalPackages: ["playwright", "playwright-core"],
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
    {
      source: "/favicon.ico",
      headers: [
        { key: "Content-Type", value: "image/x-icon" },
        { key: "Cache-Control", value: "public, max-age=86400, must-revalidate" },
      ],
    },
    {
      source: "/favicon-:size.png",
      headers: [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }],
    },
    {
      source: "/favicon.png",
      headers: [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }],
    },
    {
      source: "/apple-touch-icon.png",
      headers: [{ key: "Cache-Control", value: "public, max-age=86400, must-revalidate" }],
    },
  ],
};

export default nextConfig;

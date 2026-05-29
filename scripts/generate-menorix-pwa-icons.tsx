/**
 * One-off generator for Menorix PWA PNG icons (monogram fallback until brand assets exist).
 * Run: npx tsx scripts/generate-menorix-pwa-icons.tsx
 */
import React from "react";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ImageResponse } from "next/og";

const OUT_DIR = join(process.cwd(), "public", "icons");
const PUBLIC_ROOT = join(process.cwd(), "public");

function iconMarkup(size: number, borderPx: number, fontSize: number, radius: number) {
  return (
    <div
      style={{
        background: "#0f172a",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius,
        border: `${borderPx}px solid #0ea5e9`,
      }}
    >
      <div
        style={{
          fontSize,
          fontWeight: 700,
          color: "#38bdf8",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1,
        }}
      >
        M
      </div>
    </div>
  );
}

async function writePng(path: string, size: number, borderPx: number, fontSize: number, radius: number) {
  const res = new ImageResponse(iconMarkup(size, borderPx, fontSize, radius), {
    width: size,
    height: size,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  console.log(`wrote ${path} (${buf.length} bytes)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await writePng(join(OUT_DIR, "icon-192.png"), 192, 3, 96, 36);
  await writePng(join(OUT_DIR, "icon-512.png"), 512, 6, 240, 96);
  await writePng(join(PUBLIC_ROOT, "apple-touch-icon.png"), 180, 3, 88, 36);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

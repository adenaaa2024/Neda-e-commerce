/**
 * Sync Menorix PWA install icons from the official platform logo.
 * Source of truth: public.platform_settings.logo_url (logos bucket _platform/*).
 *
 * Run: npx tsx scripts/sync-menorix-brand-pwa-icons.ts
 */
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const BRAND_DIR = join(process.cwd(), "public", "brand");
const SOURCE_PATH = join(BRAND_DIR, "menorix-icon-source.png");
const ICON_192 = join(process.cwd(), "public", "icons", "icon-192.png");
const ICON_512 = join(process.cwd(), "public", "icons", "icon-512.png");
const APPLE_TOUCH = join(process.cwd(), "public", "apple-touch-icon.png");
const FAVICON = join(process.cwd(), "public", "favicon.ico");

function loadEnvLocal() {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

async function resolvePlatformLogoPublicUrl(): Promise<string> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await admin
    .from("platform_settings")
    .select("logo_url")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const logoUrl = String((data as { logo_url?: string | null } | null)?.logo_url ?? "").trim();
  if (!logoUrl) throw new Error("platform_settings.logo_url is empty");
  return logoUrl;
}

async function loadSourceBuffer(): Promise<Buffer> {
  if (existsSync(SOURCE_PATH)) {
    return readFileSync(SOURCE_PATH);
  }
  const logoUrl = await resolvePlatformLogoPublicUrl();
  const res = await fetch(logoUrl);
  if (!res.ok) throw new Error(`Failed to download platform logo: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("Downloaded logo is too small");
  mkdirSync(BRAND_DIR, { recursive: true });
  writeFileSync(SOURCE_PATH, buf);
  console.log(`saved source → public/brand/menorix-icon-source.png (${buf.length} bytes)`);
  return buf;
}

async function writeSquareIcon(input: Buffer, outPath: string, size: number, paddingRatio = 0.08) {
  const pad = Math.round(size * paddingRatio);
  const inner = size - pad * 2;
  const resized = await sharp(input)
    .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toFile(outPath);
  console.log(`wrote ${outPath} (${size}x${size})`);
}

async function main() {
  mkdirSync(join(process.cwd(), "public", "icons"), { recursive: true });
  const source = await loadSourceBuffer();
  const meta = await sharp(source).metadata();
  console.log(`source dimensions: ${meta.width}x${meta.height}, format=${meta.format}`);

  await writeSquareIcon(source, ICON_192, 192);
  await writeSquareIcon(source, ICON_512, 512);
  await writeSquareIcon(source, APPLE_TOUCH, 180);

  const faviconPng = join(process.cwd(), "public", "favicon.png");
  await sharp(source)
    .resize(48, 48, { fit: "contain", background: { r: 15, g: 23, b: 42, alpha: 1 } })
    .png()
    .toFile(faviconPng);
  await sharp(source)
    .resize(48, 48, { fit: "contain", background: { r: 15, g: 23, b: 42, alpha: 1 } })
    .toFile(FAVICON);
  console.log(`wrote ${faviconPng} and ${FAVICON} (48x48)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

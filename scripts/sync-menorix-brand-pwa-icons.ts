/**
 * Sync PWA install icons from parent/platform Menorix brand (NOT tenant logos).
 * Canonical source: public.platform_settings.logo_url — same as LogoMark / PlatformBrandingContext.
 *
 * Runs automatically before `npm run build` (prebuild). Manual: npm run sync:pwa-icons
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (reads platform_settings only).
 * Skip DB: SKIP_PWA_ICON_SYNC=1 — uses committed public/brand/menorix-icon-source.png
 */
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

const BRAND_DIR = join(process.cwd(), "public", "brand");
const SOURCE_PATH = join(BRAND_DIR, "menorix-icon-source.png");
const SOURCE_KEY_PATH = join(BRAND_DIR, "platform-logo-storage-key.txt");
const ICON_192 = join(process.cwd(), "public", "icons", "icon-192.png");
const ICON_512 = join(process.cwd(), "public", "icons", "icon-512.png");
const APPLE_TOUCH = join(process.cwd(), "public", "apple-touch-icon.png");
const FAVICON_PNG = join(process.cwd(), "public", "favicon.png");
const APP_ICON = join(process.cwd(), "app", "icon.png");
const APP_APPLE_ICON = join(process.cwd(), "app", "apple-icon.png");

/** Matches official Menorix logo artboard (white), not ERP dark shell. */
const ICON_BG = { r: 255, g: 255, b: 255, alpha: 1 as const };
/** PWA splash / home-screen — same as operator-mobile canvas (#050607). */
const PWA_ICON_BG = { r: 5, g: 6, b: 7, alpha: 1 as const };

const ICON_512_MASKABLE = join(process.cwd(), "public", "icons", "icon-512-maskable.png");

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

/** Stable storage object key (no host) — safe to commit for change detection. */
function storageKeyFromPublicLogoUrl(logoUrl: string): string {
  const u = logoUrl.trim();
  const marker = "/object/public/";
  const idx = u.indexOf(marker);
  if (idx >= 0) {
    return u.slice(idx + marker.length).replace(/^logos\//, "logos/");
  }
  return createHash("sha256").update(u).digest("hex").slice(0, 16);
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
  if (!logoUrl) throw new Error("platform_settings.logo_url is empty — upload Platform Product Branding logo first");
  return logoUrl;
}

async function downloadPlatformLogo(): Promise<{ buf: Buffer; storageKey: string }> {
  const logoUrl = await resolvePlatformLogoPublicUrl();
  const storageKey = storageKeyFromPublicLogoUrl(logoUrl);
  const res = await fetch(logoUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to download platform logo: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("Downloaded platform logo is too small");
  return { buf, storageKey };
}

function readStoredStorageKey(): string {
  if (!existsSync(SOURCE_KEY_PATH)) return "";
  return readFileSync(SOURCE_KEY_PATH, "utf8").trim();
}

function iconsExist(): boolean {
  return existsSync(ICON_192) && existsSync(ICON_512) && existsSync(APPLE_TOUCH);
}

async function resolveSourceBuffer(): Promise<{ buf: Buffer; from: "platform_settings" | "committed" }> {
  if (process.env.SKIP_PWA_ICON_SYNC === "1") {
    if (!existsSync(SOURCE_PATH)) throw new Error("SKIP_PWA_ICON_SYNC set but no committed source PNG");
    console.log("[pwa-icons] SKIP_PWA_ICON_SYNC — using committed source");
    return { buf: readFileSync(SOURCE_PATH), from: "committed" };
  }

  loadEnvLocal();
  const hasDbEnv =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());

  if (!hasDbEnv) {
    if (existsSync(SOURCE_PATH) && iconsExist()) {
      console.warn("[pwa-icons] no Supabase env — using committed brand PNG + icons");
      return { buf: readFileSync(SOURCE_PATH), from: "committed" };
    }
    throw new Error("No Supabase env and no committed PWA icons — cannot sync");
  }

  const { buf, storageKey } = await downloadPlatformLogo();
  const prevKey = readStoredStorageKey();
  if (prevKey === storageKey && existsSync(SOURCE_PATH) && iconsExist()) {
    console.log(`[pwa-icons] platform logo unchanged (${storageKey}) — regenerating icons from cached source`);
    return { buf: readFileSync(SOURCE_PATH), from: "platform_settings" };
  }

  mkdirSync(BRAND_DIR, { recursive: true });
  writeFileSync(SOURCE_PATH, buf);
  writeFileSync(SOURCE_KEY_PATH, storageKey);
  console.log(`[pwa-icons] downloaded platform_settings.logo_url → public/brand/menorix-icon-source.png (${buf.length} bytes, key=${storageKey})`);
  return { buf, from: "platform_settings" };
}

async function writeSquareIcon(
  input: Buffer,
  outPath: string,
  size: number,
  paddingRatio = 0.06,
  background: { r: number; g: number; b: number; alpha: number } = ICON_BG,
) {
  const pad = Math.round(size * paddingRatio);
  const inner = size - pad * 2;
  const resized = await sharp(input)
    .resize(inner, inner, { fit: "contain", background })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background,
    },
  })
    .composite([{ input: resized, gravity: "center" }])
    .png()
    .toFile(outPath);
  console.log(`[pwa-icons] wrote ${outPath.replace(process.cwd(), ".")} (${size}x${size})`);
}

async function main() {
  mkdirSync(join(process.cwd(), "public", "icons"), { recursive: true });
  const { buf, from } = await resolveSourceBuffer();
  const meta = await sharp(buf).metadata();
  console.log(`[pwa-icons] source=${from}, ${meta.width}x${meta.height}, format=${meta.format}`);

  await writeSquareIcon(buf, ICON_192, 192, 0.1, PWA_ICON_BG);
  await writeSquareIcon(buf, ICON_512, 512, 0.1, PWA_ICON_BG);
  await writeSquareIcon(buf, ICON_512_MASKABLE, 512, 0.24, PWA_ICON_BG);
  await writeSquareIcon(buf, APPLE_TOUCH, 180, 0.1, PWA_ICON_BG);

  await sharp(buf)
    .resize(48, 48, { fit: "contain", background: ICON_BG })
    .png()
    .toFile(FAVICON_PNG);
  console.log(`[pwa-icons] wrote public/favicon.png (48x48)`);

  // Next.js App Router favicons (override any stale default / Vercel placeholder)
  await writeSquareIcon(buf, APP_ICON, 512, 0.06);
  await writeSquareIcon(buf, APP_APPLE_ICON, 180, 0.08);
  console.log("[pwa-icons] wrote app/icon.png + app/apple-icon.png (Next.js metadata)");
}

main().catch((e) => {
  console.error("[pwa-icons] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});

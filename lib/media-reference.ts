import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Values that may appear in DB for pallet/package evidence — full public URLs,
 * protocol-relative URLs, site-relative `/...` paths, or storage object paths
 * (e.g. `org-uuid/incident/file.jpg`).
 */
export function isAcceptableStoredMediaReference(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 2048) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (t.startsWith("//")) return true;
  if (t.startsWith("/")) return true;
  if (t.startsWith("data:") || t.startsWith("blob:")) return true;
  if (!/[\s<>"{}|\\^`]/.test(t) && t.includes("/")) return true;
  return false;
}

/** Reject ephemeral browser-only refs when persisting to Supabase JSON/columns server-side. */
export function isPersistableStoredMediaReference(s: string): boolean {
  const t = s.trim();
  if (t.startsWith("data:") || t.startsWith("blob:")) return false;
  return isAcceptableStoredMediaReference(t);
}

/**
 * Convert stored evidence ref to a browser-loadable `<img src>` URL.
 * Unknown relative paths assume the `media` bucket; manifest-folder paths prefer `manifests`.
 */
export function resolveViewableMediaUrl(raw: string, client: SupabaseClient): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return `https:${t}`;
  if (t.startsWith("/")) return t;
  if (t.startsWith("data:") || t.startsWith("blob:")) return t;
  const path = t.replace(/^\/+/, "");
  const tryManifestsFirst =
    /\/(packages\/manifest|pallets\/manifest)\//i.test(path) || /(^|\/)manifest\//i.test(path);
  const bucket = tryManifestsFirst ? "manifests" : "media";
  const { data } = client.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

export function normalizePalletDocumentationImageUrls(
  urls: string[],
  client: SupabaseClient,
  max = 3,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const resolved = resolveViewableMediaUrl(raw, client);
    if (!resolved) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= max) break;
  }
  return out;
}

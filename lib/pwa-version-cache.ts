import type { PwaVersionEndpointPayload } from "./pwa-settings-types";

export const PWA_VERSION_CACHE_KEY = "menorix:pwaVersionPolicy:v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CachedPwaVersionPolicy = {
  payload: PwaVersionEndpointPayload;
  cachedAt: number;
};

export function readCachedPwaVersionPolicy(): CachedPwaVersionPolicy | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PWA_VERSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPwaVersionPolicy;
    if (!parsed?.payload?.ok || typeof parsed.cachedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedPwaVersionPolicy(payload: PwaVersionEndpointPayload): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CachedPwaVersionPolicy = { payload, cachedAt: Date.now() };
    localStorage.setItem(PWA_VERSION_CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* ignore quota */
  }
}

export function clearCachedPwaVersionPolicy(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PWA_VERSION_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

export function isPwaVersionCacheExpired(cachedAt: number, now = Date.now()): boolean {
  return now - cachedAt > CACHE_TTL_MS;
}

export const PWA_VERSION_CACHE_TTL_MS = CACHE_TTL_MS;

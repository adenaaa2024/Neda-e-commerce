import { PWA_APP_VERSION } from "./pwa-app-version";
import { clearCachedPwaVersionPolicy } from "./pwa-version-cache";
import { setSwUpdateAvailable } from "./pwa-sw-update";

const MENORIX_LS_PREFIXES = ["menorix:", "operatorMobile:pwa", "operatorMobile:startup"];

function shouldClearLocalStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return MENORIX_LS_PREFIXES.some((prefix) => key.startsWith(prefix)) || lower.includes("pwaversion");
}

/** Clear Menorix PWA version caches, install dismiss keys, and SW update state. */
export function clearMenorixPwaLocalCaches(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && shouldClearLocalStorageKey(key)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    /* ignore */
  }
  clearCachedPwaVersionPolicy();
  setSwUpdateAvailable(false);
}

/** Unregister all service workers and wipe Cache API stores. */
export async function unregisterMenorixServiceWorkers(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((reg) => reg.unregister()));
  setSwUpdateAvailable(false);
}

export async function clearMenorixCacheApi(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
}

/** Full runtime reset before a cache-busting reload. */
export async function clearMenorixPwaRuntimeCaches(): Promise<void> {
  clearMenorixPwaLocalCaches();
  await unregisterMenorixServiceWorkers();
  await clearMenorixCacheApi();
}

export function reloadMenorixWithCacheBust(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("_mxReload", String(Date.now()));
  url.searchParams.set("_mxV", PWA_APP_VERSION);
  window.location.replace(url.toString());
}

/**
 * PWA update path: unregister SW, clear caches, reload with cache-bust, then re-check version.
 * Does not ask user to uninstall unless this fails repeatedly (caller handles that).
 */
export async function performMenorixPwaUpdate(): Promise<void> {
  await clearMenorixPwaRuntimeCaches();
  reloadMenorixWithCacheBust();
}

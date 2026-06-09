import { PWA_APP_VERSION } from "./pwa-app-version";
import { isVersionBelow } from "./pwa-version-policy";
import type { PwaVersionEndpointPayload } from "./pwa-settings-types";
import {
  isPwaVersionCacheExpired,
  readCachedPwaVersionPolicy,
  writeCachedPwaVersionPolicy,
} from "./pwa-version-cache";

export type PwaVersionCheckResult =
  | {
      status: "ok";
      source: "network";
      payload: PwaVersionEndpointPayload;
    }
  | {
      status: "cache";
      payload: PwaVersionEndpointPayload;
    }
  | {
      status: "fetch_failed";
      cacheExpired: boolean;
      cached: PwaVersionEndpointPayload | null;
    };

const VERSION_ENDPOINT = "/api/scanner/pwa-version";

/** @deprecated Hard version blocks removed — use `shouldShowPwaSoftUpdateBanner` in `pwa-version-boot.ts`. */
export function shouldHardBlockStaleInstalledPwa(
  payload: PwaVersionEndpointPayload,
  isStandalone: boolean,
): boolean {
  if (!isStandalone) return false;
  if (!payload.enable_version_enforcement) return false;
  return isVersionBelow(PWA_APP_VERSION, payload.minimum_supported_version);
}

export async function fetchPwaVersionPolicy(): Promise<PwaVersionEndpointPayload> {
  const res = await fetch(VERSION_ENDPOINT, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) {
    throw new Error(`Version endpoint returned ${res.status}`);
  }
  const json = (await res.json()) as PwaVersionEndpointPayload;
  if (!json?.ok) {
    throw new Error("Version endpoint payload invalid");
  }
  writeCachedPwaVersionPolicy(json);
  return json;
}

/**
 * Fetch server policy — network always wins when reachable.
 * Cache is advisory fallback for installed PWA offline checks only.
 */
export async function checkPwaVersionPolicy(): Promise<PwaVersionCheckResult> {
  try {
    const payload = await fetchPwaVersionPolicy();
    return { status: "ok", source: "network", payload };
  } catch {
    const cached = readCachedPwaVersionPolicy();
    if (!cached) {
      return { status: "fetch_failed", cacheExpired: true, cached: null };
    }
    const expired = isPwaVersionCacheExpired(cached.cachedAt);
    if (expired) {
      return { status: "fetch_failed", cacheExpired: true, cached: cached.payload };
    }
    return { status: "cache", payload: cached.payload };
  }
}

import { PWA_APP_VERSION } from "./pwa-app-version";
import { buildPwaVersionEndpointPayload } from "./pwa-settings-payload";
import { DEFAULT_PLATFORM_PWA_SETTINGS, type PwaVersionEndpointPayload } from "./pwa-settings-types";
import { isSwUpdateAvailable } from "./pwa-sw-update";
import { checkPwaVersionPolicy } from "./pwa-version-check";
import { isVersionBelow } from "./pwa-version-policy";

const BOOT_SESSION_KEY = "menorix:pwaVersionBootChecked:v1";
export const PWA_UPDATE_RELOAD_SESSION_KEY = "menorix:pwaUpdateReloaded:v1";

export type PwaVersionBootState = {
  payload: PwaVersionEndpointPayload;
  /** Server policy or waiting service worker indicates a newer build. */
  updateAvailable: boolean;
  /** Network fetch failed and no fresh cache — non-fatal; app continues. */
  checkFailed: boolean;
};

let bootState: PwaVersionBootState | null = null;
let bootPromise: Promise<PwaVersionBootState> | null = null;

/** True for the remainder of this tab session after a cache-bust update reload. */
export function wasJustUpdatedThisSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (sessionStorage.getItem(PWA_UPDATE_RELOAD_SESSION_KEY) === "1") return true;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("_mxReload")) return false;
    sessionStorage.setItem(PWA_UPDATE_RELOAD_SESSION_KEY, "1");
    url.searchParams.delete("_mxReload");
    url.searchParams.delete("_mxV");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", next);
    return true;
  } catch {
    return false;
  }
}

export function shouldShowPwaSoftUpdateBanner(payload: PwaVersionEndpointPayload): boolean {
  if (wasJustUpdatedThisSession()) return false;
  if (isSwUpdateAvailable()) return true;
  return isVersionBelow(PWA_APP_VERSION, payload.latest_available_version);
}

function buildBootState(payload: PwaVersionEndpointPayload, checkFailed: boolean): PwaVersionBootState {
  return {
    payload,
    updateAvailable: shouldShowPwaSoftUpdateBanner(payload),
    checkFailed,
  };
}

export function getPwaVersionBootState(): PwaVersionBootState | null {
  return bootState;
}

/**
 * Fetch PWA version policy once per tab session. Never throws; failures are non-blocking.
 */
export async function runPwaVersionBootCheckOnce(): Promise<PwaVersionBootState> {
  if (bootState) return bootState;
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    let payload = buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS);
    let checkFailed = false;

    const result = await checkPwaVersionPolicy();
    if (result.status === "ok" || result.status === "cache") {
      payload = result.payload;
    } else {
      checkFailed = true;
      if (result.cached) payload = result.cached;
    }

    bootState = buildBootState(payload, checkFailed);

    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(BOOT_SESSION_KEY, "1");
      } catch {
        /* ignore */
      }
    }

    return bootState;
  })();

  return bootPromise;
}

/** Recompute banner visibility after service worker reports an update. */
export function refreshPwaUpdateBannerAvailability(): boolean {
  if (!bootState) return isSwUpdateAvailable() && !wasJustUpdatedThisSession();
  bootState = {
    ...bootState,
    updateAvailable: shouldShowPwaSoftUpdateBanner(bootState.payload),
  };
  return bootState.updateAvailable;
}

import { SCANNER_OPERATOR_HOME_PATH } from "@/lib/pwa-standalone";

const ACTIVE_SESSION_KEY = "operatorMobile:inActiveSession";

/** Marks an in-memory app session (cleared when the browser/PWA process ends). */
export function markOperatorMobileActiveSession(): void {
  try {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function hasOperatorMobileActiveSession(): boolean {
  try {
    return sessionStorage.getItem(ACTIVE_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function isColdAppEntryNavigation(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return !nav || nav.type === "navigate";
  } catch {
    return true;
  }
}

/**
 * After process kill / fresh load, land on home — not scan or a stale deep route.
 * Keeps scan deep links when `?code=` is present.
 */
export function shouldRedirectColdEntryToHome(pathname: string, scanCode: string | null): boolean {
  if (!pathname.startsWith("/scanner/operator-mobile")) return false;
  if (pathname === SCANNER_OPERATOR_HOME_PATH || pathname === `${SCANNER_OPERATOR_HOME_PATH}/`) {
    return false;
  }
  if (pathname.startsWith("/scanner/operator-mobile/scan") && scanCode) {
    return false;
  }
  return true;
}

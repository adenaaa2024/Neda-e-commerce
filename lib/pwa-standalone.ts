/** Operator-mobile route constants (shared by PWA, nav, and redirects). */
export const SCANNER_OPERATOR_HOME_PATH = "/scanner/operator-mobile";
export const SCANNER_OPERATOR_SCAN_PATH = "/scanner/operator-mobile/scan";

/** Installed PWA cold-open target — operator home, not scan. */
export const SCANNER_PWA_ENTRY_PATH = SCANNER_OPERATOR_HOME_PATH;

export const SCANNER_PWA_START_URL = `${SCANNER_OPERATOR_HOME_PATH}?source=pwa`;

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function isScannerPwaEntryPath(pathname: string): boolean {
  return pathname.startsWith("/scanner/operator-mobile");
}

/** Installed PWA entry — warehouse mobile scanner. */
export const SCANNER_PWA_ENTRY_PATH = "/scanner/operator-mobile/scan";

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function isScannerPwaEntryPath(pathname: string): boolean {
  return pathname.startsWith("/scanner/operator-mobile");
}

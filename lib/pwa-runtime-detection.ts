import { isMobileUserAgent } from "./pwa-device-support";

/** Installed Menorix PWA shell — not a normal browser tab. */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

/** Mobile UA opened in a browser tab (not installed PWA). */
export function isMobileBrowser(): boolean {
  return isMobileUserAgent() && !isStandalonePwa();
}

/** Desktop/laptop browser tab (not installed PWA). */
export function isDesktopBrowser(): boolean {
  return !isMobileUserAgent() && !isStandalonePwa();
}

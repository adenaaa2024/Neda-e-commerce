/** Shared Claims hub route matching for sidebar + in-app workflow nav. */

export const CLAIMS_HUB_DEFAULT_PATH = "/claim-engine/inbox";

export const CLAIMS_SETTINGS_TAB = "claim_engine";

export const CLAIMS_SETTINGS_HREF = `/settings?tab=${CLAIMS_SETTINGS_TAB}`;

export function normalizeAppPath(pathname: string): string {
  return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

/** True for any in-app Claims workflow screen (sidebar highlights single "Claims" entry). */
export function isClaimsHubRoute(pathname: string): boolean {
  const path = normalizeAppPath(pathname);
  if (path === "/returns/claims" || path.startsWith("/returns/claims/")) return true;
  if (path === "/claim-engine" || path.startsWith("/claim-engine/")) return true;
  return false;
}

export function isClaimsSettingsRoute(pathname: string, settingsTab: string | null | undefined): boolean {
  return normalizeAppPath(pathname) === "/settings" && settingsTab === CLAIMS_SETTINGS_TAB;
}

export function isClaimsSidebarActive(pathname: string, settingsTab?: string | null): boolean {
  return isClaimsHubRoute(pathname) || isClaimsSettingsRoute(pathname, settingsTab);
}

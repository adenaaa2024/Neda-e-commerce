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

/** Claim Center V1 read shell — separate sidebar leaf from legacy Claim Engine. */
export function isClaimCenterRoute(pathname: string): boolean {
  const path = normalizeAppPath(pathname);
  return path === "/claim-center" || path.startsWith("/claim-center/");
}

export function isClaimCenterSidebarActive(pathname: string): boolean {
  return isClaimCenterRoute(pathname);
}

export function isClaimsSettingsRoute(pathname: string, settingsTab: string | null | undefined): boolean {
  return normalizeAppPath(pathname) === "/settings" && settingsTab === CLAIMS_SETTINGS_TAB;
}

/** Claim Engine draft pool — part of Claims hub, not Returns Processing. */
export function isReturnsClaimsDraftPoolRoute(pathname: string): boolean {
  const path = normalizeAppPath(pathname);
  return path === "/returns/claims" || path.startsWith("/returns/claims/");
}

/** Sidebar "Returns Processing" (/returns) — excludes Claim Engine draft pool routes. */
export function isReturnsProcessingRoute(pathname: string): boolean {
  const path = normalizeAppPath(pathname);
  if (isReturnsClaimsDraftPoolRoute(path)) return false;
  return path === "/returns" || path.startsWith("/returns/");
}

export function isClaimsSidebarActive(pathname: string, settingsTab?: string | null): boolean {
  if (isClaimCenterRoute(pathname)) return false;
  return isClaimsHubRoute(pathname) || isClaimsSettingsRoute(pathname, settingsTab);
}

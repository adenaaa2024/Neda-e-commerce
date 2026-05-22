/**
 * Deep-link workspace org for internal staff (operable smoke, PIM catalog links).
 * Query: `workspace_org` (preferred) or `organization_id`.
 */

import { isUuidString } from "./uuid";

export const WORKSPACE_ORG_QUERY_KEYS = ["workspace_org", "organization_id"] as const;

export function readWorkspaceOrganizationIdFromSearch(
  search: string | URLSearchParams,
): string | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  for (const key of WORKSPACE_ORG_QUERY_KEYS) {
    const raw = params.get(key)?.trim() ?? "";
    if (isUuidString(raw)) return raw;
  }
  return null;
}

/** Operable staging tenant — Sam Distribution Inc (17k+ PIM products on Sam AM). */
export const OPERABLE_SAM_DISTRIBUTION_ORG_ID = "00000000-0000-0000-0000-000000000001";
/** Operable staging store — Sam AM. */
export const OPERABLE_SAM_AM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

export function buildPimCatalogDeepLink(basePath = "/dashboard/products"): string {
  const u = new URL(basePath, "http://local");
  u.searchParams.set("workspace_org", OPERABLE_SAM_DISTRIBUTION_ORG_ID);
  u.searchParams.set("store", OPERABLE_SAM_AM_STORE_ID);
  return `${u.pathname}${u.search}`;
}

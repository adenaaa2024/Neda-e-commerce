import { isUuidString } from "./uuid";

/** Same key as `UserRoleContext` workspace picker — canonical “viewing as org” for internal staff. */
export const WORKSPACE_SELECTED_ORGANIZATION_ID_KEY = "workspace_selected_organization_id";

/** Fired on `window` when the workspace org changes (same-tab; `storage` does not fire for own writes). */
export const WORKSPACE_ORGANIZATION_CHANGED_EVENT = "ecommerce-os-workspace-organization-changed";

export function readWorkspaceSelectedOrganizationIdFromStorage(): string {
  if (typeof window === "undefined") return "";
  const t = window.localStorage.getItem(WORKSPACE_SELECTED_ORGANIZATION_ID_KEY)?.trim();
  return t && isUuidString(t) ? t : "";
}

/**
 * Active tenant org for data scope (stores, branding hints, etc.).
 *
 * 1. `workspace_selected_organization_id` (header workspace switcher).
 * 2. Else `profiles.organization_id` (`profileOrganizationId`).
 * 3. Else `UserRoleContext.organizationId` (`contextOrganizationId`).
 *
 * Whatever id ends up here is passed straight to the database — no special handling
 * for the platform shell UUID, callers can pick any organization they need.
 */
export function resolveActiveTenantOrganizationId(opts: {
  workspaceSwitcherOrganizationId: string;
  contextOrganizationId: string | null | undefined;
  profileOrganizationId: string | null | undefined;
}): string | null {
  const lsRaw = (opts.workspaceSwitcherOrganizationId ?? "").trim();
  const ls = lsRaw && isUuidString(lsRaw) ? lsRaw.toLowerCase() : "";
  const ctxRaw = (opts.contextOrganizationId ?? "").trim();
  const ctx = ctxRaw && isUuidString(ctxRaw) ? ctxRaw.toLowerCase() : "";
  const homeRaw = (opts.profileOrganizationId ?? "").trim();
  const home = homeRaw && isUuidString(homeRaw) ? homeRaw.toLowerCase() : "";

  if (ls) return ls;
  if (home) return home;
  if (ctx) return ctx;
  return null;
}

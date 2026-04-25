/**
 * Single source of truth for who may edit tenant company branding
 * (`organization_settings.company_display_name`, `organization_settings.logo_url`).
 * Use canonical `roles.key` (or legacy `profiles.role` when joined) — not UI tier labels.
 */
const TENANT_ORGANIZATION_BRANDING_EDITOR_ROLE_KEYS = new Set([
  "tenant_admin",
  /** Legacy tenant admin key — same privilege as `tenant_admin`. */
  "admin",
  "super_admin",
  "programmer",
  "system_admin",
]);

/** Canonical keys that may read/write branding for a client-selected workspace org (header/switcher). */
const WORKSPACE_ORGANIZATION_PICKER_ROLE_KEYS = new Set([
  "super_admin",
  "programmer",
  "system_admin",
]);

/**
 * Maps `roles.key`, legacy `profiles.role`, and UI labels to a single snake_case key
 * so permission checks match Postgres catalog values even when legacy rows store
 * human-readable text (e.g. "Super Admin" → `super_admin`).
 */
export function normalizeRoleKeyForBranding(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

export function canEditTenantOrganizationBrandingByRoleKey(
  roleKey: string | null | undefined,
): boolean {
  const k = normalizeRoleKeyForBranding(roleKey);
  return k.length > 0 && TENANT_ORGANIZATION_BRANDING_EDITOR_ROLE_KEYS.has(k);
}

export function canPickWorkspaceOrganizationForTenantBranding(
  roleKey: string | null | undefined,
): boolean {
  const k = normalizeRoleKeyForBranding(roleKey);
  return WORKSPACE_ORGANIZATION_PICKER_ROLE_KEYS.has(k);
}

/**
 * System Settings → Users (`/users`): who may create/edit/delete users and manage groups.
 * Canonical `tenant_admin` plus legacy `profiles.role` text `admin`.
 */
export function isTenantDirectoryAdminRoleKey(roleKey: string | null | undefined): boolean {
  const k = normalizeRoleKeyForBranding(roleKey);
  return k === "tenant_admin" || k === "admin";
}

const SYSTEM_SETTINGS_USERS_MUTATOR_KEYS = new Set([
  "tenant_admin",
  "admin",
  "super_admin",
  "system_employee",
  "system_admin",
  "programmer",
  "customer_service",
]);

/**
 * Who may use System Settings → Users (same idea as `isAdminRole` in UserRoleContext: not operator/employee).
 */
export function isSystemSettingsUsersMutatorRoleKey(roleKey: string | null | undefined): boolean {
  const k = normalizeRoleKeyForBranding(roleKey);
  return k.length > 0 && SYSTEM_SETTINGS_USERS_MUTATOR_KEYS.has(k);
}

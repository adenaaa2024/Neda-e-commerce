import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  CLAIM_ACCESS_RANK,
  CLAIM_PERMISSION_CATALOG,
  type ClaimPermissionKey,
  type StoreAccessFloor,
  isClaimPermissionKey,
} from "./claim-permissions";
import { isUuidString } from "./uuid";

let serviceClient: SupabaseClient | null = null;

function getServiceSupabase(): SupabaseClient {
  if (!serviceClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    }
    serviceClient = createClient(url, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: "no-store" }),
      },
    });
  }
  return serviceClient;
}

async function assertStoreInOrganization(
  organizationId: string,
  storeId: string,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data, error } = await getServiceSupabase()
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, status: 500 };
  if (!data) return { ok: false, error: "Store not found for this organization.", status: 403 };
  return { ok: true };
}

export type ClaimPermissionDenialCode =
  | "INVALID_INPUT"
  | "ORG_DENIED"
  | "STORE_DENIED"
  | "STORE_REQUIRED"
  | "ASSIGNMENT_DENIED"
  | "PERMISSION_DENIED"
  | "FAMILY_DENIED"
  | "INTERNAL_ERROR";

export type AssertClaimPermissionContext = {
  organizationId: string;
  storeId?: string | null;
  claimFamily?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

export type AssertClaimPermissionOk = {
  ok: true;
  userId: string;
  organizationId: string;
  storeId: string | null;
  permission: ClaimPermissionKey;
  accessLevel: StoreAccessFloor | null;
  meta?: {
    tenantAdminImplicit?: boolean;
    platformBypassAssignment?: boolean;
  };
};

export type AssertClaimPermissionDenied = {
  ok: false;
  code: ClaimPermissionDenialCode;
  message: string;
  httpStatus: number;
};

export type AssertClaimPermissionResult = AssertClaimPermissionOk | AssertClaimPermissionDenied;

export type UserStoreAssignmentRow = {
  store_id: string;
  access_level: StoreAccessFloor;
  starts_at: string;
  ends_at: string | null;
  source: string;
};

const PLATFORM_ACTIONS_NO_ASSIGNMENT: Set<ClaimPermissionKey> = new Set([
  "platform.claims.impersonate_read",
  "platform.claims.audit",
]);

function nowIso(): string {
  return new Date().toISOString();
}

function parseRoleKey(prof: unknown): string {
  const rolesRel = (prof as { roles?: { key?: string } | { key?: string }[] | null }).roles;
  const roleKeyRaw =
    Array.isArray(rolesRel) ? rolesRel[0]?.key : rolesRel && typeof rolesRel === "object" ? rolesRel.key : undefined;
  return String(roleKeyRaw ?? "").toLowerCase();
}

function legacyRoleText(prof: unknown): string {
  const r = (prof as { role?: string | null })?.role;
  return String(r ?? "").trim().toLowerCase();
}

/**
 * Mirrors assertUserCanAccessOrganization (pim-actions) using service-role DB read.
 * Keep aligned when changing org access rules.
 */
export async function userMayAccessOrganization(
  userId: string,
  organizationId: string,
): Promise<{ ok: true; roleKey: string; homeOrg: string; isPlatformStaff: boolean } | { ok: false }> {
  if (!isUuidString(userId) || !isUuidString(organizationId)) return { ok: false };

  const { data: prof, error } = await getServiceSupabase()
    .from("profiles")
    .select("organization_id, role, roles!profiles_role_id_fkey(key)")
    .eq("id", userId)
    .maybeSingle();

  if (error || !prof) return { ok: false };

  const homeOrg = String(prof.organization_id ?? "").trim();
  const roleKey = parseRoleKey(prof);
  const legacy = legacyRoleText(prof);

  const isPlatformStaff =
    roleKey === "super_admin" || roleKey === "system_employee" || roleKey === "system_admin" ||
    legacy === "super_admin" || legacy === "system_employee" || legacy === "system_admin";

  if (!isPlatformStaff && homeOrg !== organizationId) {
    return { ok: false };
  }

  return { ok: true, roleKey: roleKey || legacy, homeOrg, isPlatformStaff };
}

export async function loadUserOrgAccessFlags(
  userId: string,
  organizationId: string,
): Promise<
  | {
      ok: true;
      roleKey: string;
      homeOrg: string;
      isPlatformStaff: boolean;
      isTenantAdminHome: boolean;
    }
  | { ok: false }
> {
  if (!isUuidString(userId) || !isUuidString(organizationId)) return { ok: false };

  const { data: prof, error } = await getServiceSupabase()
    .from("profiles")
    .select("organization_id, role, roles!profiles_role_id_fkey(key)")
    .eq("id", userId)
    .maybeSingle();

  if (error || !prof) return { ok: false };

  const homeOrg = String(prof.organization_id ?? "").trim();
  const roleKey = parseRoleKey(prof);
  const legacy = legacyRoleText(prof);
  const isPlatformStaff =
    roleKey === "super_admin" || roleKey === "system_employee" || roleKey === "system_admin" ||
    legacy === "super_admin" || legacy === "system_employee" || legacy === "system_admin";

  if (!isPlatformStaff && homeOrg !== organizationId) {
    return { ok: false };
  }

  const isTenantAdminHome =
    (roleKey === "tenant_admin" || roleKey === "admin" || legacy === "admin" || legacy === "tenant_admin") &&
    homeOrg === organizationId &&
    !isPlatformStaff;

  return { ok: true, roleKey: roleKey || legacy, homeOrg, isPlatformStaff, isTenantAdminHome };
}

function rowIsActive(now: string, row: { revoked_at?: string | null; starts_at?: string; ends_at?: string | null }): boolean {
  if (row.revoked_at != null) return false;
  const start = row.starts_at ? Date.parse(row.starts_at) : NaN;
  const end = row.ends_at ? Date.parse(row.ends_at) : NaN;
  const t = Date.parse(now);
  if (Number.isFinite(start) && t < start) return false;
  if (Number.isFinite(end) && t >= end) return false;
  return true;
}

function maxAccess(a: StoreAccessFloor | null, b: StoreAccessFloor | null): StoreAccessFloor | null {
  if (!a) return b;
  if (!b) return a;
  return CLAIM_ACCESS_RANK[a] >= CLAIM_ACCESS_RANK[b] ? a : b;
}

/**
 * Active store assignments for a user in an organization (read-only).
 */
export async function getUserStoreAccessForOrganization(
  userId: string,
  organizationId: string,
): Promise<{ ok: true; rows: UserStoreAssignmentRow[] } | { ok: false; code: ClaimPermissionDenialCode; message: string }> {
  if (!isUuidString(userId) || !isUuidString(organizationId)) {
    return { ok: false, code: "INVALID_INPUT", message: "Invalid user or organization id." };
  }

  const now = nowIso();
  const { data, error } = await getServiceSupabase()
    .from("user_store_assignments")
    .select("store_id, access_level, starts_at, ends_at, revoked_at, source")
    .eq("organization_id", organizationId)
    .eq("profile_id", userId);

  if (error) {
    return { ok: false, code: "INTERNAL_ERROR", message: error.message };
  }

  const rows: UserStoreAssignmentRow[] = [];
  for (const raw of data ?? []) {
    const r = raw as {
      store_id: string;
      access_level: string;
      starts_at: string;
      ends_at: string | null;
      revoked_at: string | null;
      source: string;
    };
    if (!rowIsActive(now, r)) continue;
    const level = r.access_level as StoreAccessFloor;
    if (level !== "view" && level !== "act" && level !== "submit") continue;
    rows.push({
      store_id: r.store_id,
      access_level: level,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      source: r.source ?? "manual",
    });
  }
  return { ok: true, rows };
}

async function effectiveStoreAccess(
  userId: string,
  organizationId: string,
  storeId: string,
  flags: { isTenantAdminHome: boolean; isPlatformStaff: boolean },
  meta: { requireExplicitForAdmin: boolean },
): Promise<StoreAccessFloor | null> {
  const list = await getUserStoreAccessForOrganization(userId, organizationId);
  if (!list.ok) return null;
  let best: StoreAccessFloor | null = null;
  for (const r of list.rows) {
    if (r.store_id !== storeId) continue;
    best = maxAccess(best, r.access_level);
  }
  if (best) return best;

  if (flags.isPlatformStaff) {
    return "submit";
  }
  if (flags.isTenantAdminHome && !meta.requireExplicitForAdmin) {
    return "submit";
  }
  return null;
}

/**
 * Core evaluator (explicit userId) — for scripts/tests using service DB reads.
 */
export async function evaluateClaimPermissionForActor(
  action: string,
  userId: string,
  ctx: AssertClaimPermissionContext,
): Promise<AssertClaimPermissionResult> {
  try {
    if (!isClaimPermissionKey(action)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "Unknown permission action.",
        httpStatus: 400,
      };
    }
    const perm = CLAIM_PERMISSION_CATALOG[action];
    const { organizationId, storeId, claimFamily } = ctx;

    if (!isUuidString(organizationId)) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid organization id.", httpStatus: 400 };
    }
    if (storeId != null && storeId !== "" && !isUuidString(storeId)) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid store id.", httpStatus: 400 };
    }
    if (ctx.entityId != null && ctx.entityId !== "" && !isUuidString(ctx.entityId)) {
      return { ok: false, code: "INVALID_INPUT", message: "Invalid entity id.", httpStatus: 400 };
    }

    const flags = await loadUserOrgAccessFlags(userId, organizationId);
    if (!flags.ok) {
      return { ok: false, code: "ORG_DENIED", message: "You do not have access to this organization.", httpStatus: 403 };
    }

    if (claimFamily != null && claimFamily !== "") {
      /* Skeleton: no per-family matrix in catalog yet — do not FAMILY_DENIED. */
    }

    if (perm.requiredStore && (storeId == null || storeId === "")) {
      return {
        ok: false,
        code: "STORE_REQUIRED",
        message: "This action requires a store in context.",
        httpStatus: 400,
      };
    }

    const sid = storeId && storeId !== "" ? storeId : null;
    if (sid) {
      const storeGate = await assertStoreInOrganization(organizationId, sid);
      if (!storeGate.ok) {
        return {
          ok: false,
          code: "STORE_DENIED",
          message: storeGate.error,
          httpStatus: storeGate.status,
        };
      }
    }

    const requireExplicit = !!perm.requireExplicitAssignmentForTenantAdmin;
    const platformNoAssignment =
      flags.isPlatformStaff && PLATFORM_ACTIONS_NO_ASSIGNMENT.has(action) && !sid;

    if (platformNoAssignment) {
      return {
        ok: true,
        userId,
        organizationId,
        storeId: null,
        permission: action,
        accessLevel: null,
        meta: { platformBypassAssignment: true },
      };
    }

    const minRank = CLAIM_ACCESS_RANK[perm.minimumStoreAccess];

    if (!sid) {
      if (minRank <= CLAIM_ACCESS_RANK.view) {
        return {
          ok: true,
          userId,
          organizationId,
          storeId: null,
          permission: action,
          accessLevel: "view",
        };
      }
      if (minRank <= CLAIM_ACCESS_RANK.act) {
        if (flags.isTenantAdminHome || flags.isPlatformStaff) {
          return {
            ok: true,
            userId,
            organizationId,
            storeId: null,
            permission: action,
            accessLevel: "act",
            meta: { tenantAdminImplicit: flags.isTenantAdminHome },
          };
        }
        return {
          ok: false,
          code: "PERMISSION_DENIED",
          message: "This action requires tenant admin or platform access when no store is in context.",
          httpStatus: 403,
        };
      }
      if (flags.isPlatformStaff && !requireExplicit) {
        return {
          ok: true,
          userId,
          organizationId,
          storeId: null,
          permission: action,
          accessLevel: "submit",
          meta: { tenantAdminImplicit: false },
        };
      }
      if (flags.isTenantAdminHome && !requireExplicit) {
        return {
          ok: true,
          userId,
          organizationId,
          storeId: null,
          permission: action,
          accessLevel: "submit",
          meta: { tenantAdminImplicit: true },
        };
      }
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: "This action requires elevated org-wide permission or a store assignment.",
        httpStatus: 403,
      };
    }

    const eff = await effectiveStoreAccess(userId, organizationId, sid, flags, {
      requireExplicitForAdmin: requireExplicit,
    });
    if (!eff) {
      return {
        ok: false,
        code: "ASSIGNMENT_DENIED",
        message: "No active store assignment for this user and store.",
        httpStatus: 403,
      };
    }
    if (CLAIM_ACCESS_RANK[eff] < minRank) {
      return {
        ok: false,
        code: "PERMISSION_DENIED",
        message: `Requires at least ${perm.minimumStoreAccess} access on this store.`,
        httpStatus: 403,
      };
    }

    return {
      ok: true,
      userId,
      organizationId,
      storeId: sid,
      permission: action,
      accessLevel: eff,
      meta: {
        tenantAdminImplicit: flags.isTenantAdminHome && !requireExplicit,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "INTERNAL_ERROR", message: msg, httpStatus: 500 };
  }
}

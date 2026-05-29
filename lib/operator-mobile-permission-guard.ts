import "server-only";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import {
  isOperatorMobilePermissionKey,
  OPERATOR_MOBILE_PERMISSION_DENIED_MESSAGE,
  type OperatorMobilePermissionKey,
} from "@/lib/operator-mobile-permissions";
import { normalizeRoleKeyForBranding } from "@/lib/tenant-branding-permissions";
import { isUuidString } from "@/lib/uuid";

/** Bootstrap until Platform Access grants are configured (also satisfied by explicit permission keys). */
const BOOTSTRAP_CORRECTION_ROLE_KEYS = new Set(["super_admin", "admin", "tenant_admin"]);

export type AssertOperatorMobilePermissionResult =
  | { ok: true; userId: string }
  | { ok: false; message: string };

function splitJoined<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return (raw[0] as T | undefined) ?? null;
  return raw as T;
}

async function resolveRoleIdForProfile(profileId: string): Promise<string | null> {
  const { data: profile, error } = await supabaseServer
    .from("profiles")
    .select("role_id, role")
    .eq("id", profileId)
    .maybeSingle();
  if (error || !profile) return null;
  const p = profile as { role_id?: unknown; role?: unknown };
  const ridRaw = p.role_id;
  if (ridRaw != null && isUuidString(String(ridRaw))) {
    return String(ridRaw).trim();
  }
  const key = normalizeRoleKeyForBranding(p.role != null ? String(p.role) : null);
  if (!key) return null;
  const { data: roleRow } = await supabaseServer.from("roles").select("id").eq("key", key).maybeSingle();
  const id =
    roleRow && typeof (roleRow as { id?: unknown }).id === "string"
      ? String((roleRow as { id: string }).id)
      : "";
  return id || null;
}

async function resolveCanonicalRoleKey(profileId: string): Promise<string> {
  const { data: prof } = await supabaseServer
    .from("profiles")
    .select("role, roles!profiles_role_id_fkey(key)")
    .eq("id", profileId)
    .maybeSingle();
  if (!prof) return "";
  const roleJoin = splitJoined<{ key?: string | null }>(
    (prof as { roles?: unknown }).roles,
  );
  const keyFromJoin = roleJoin?.key != null ? String(roleJoin.key).trim() : "";
  const legacyRole = (prof as { role?: string | null }).role;
  return keyFromJoin || normalizeRoleKeyForBranding(legacyRole != null ? String(legacyRole) : null);
}

/**
 * Union of flat `permissions.key` values from role + org-scoped groups (Platform Access grants).
 */
export async function loadOperatorMobilePermissionKeysForUser(
  userId: string,
  organizationId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!isUuidString(userId) || !isUuidString(organizationId)) return keys;

  const permIdSet = new Set<string>();

  const roleId = await resolveRoleIdForProfile(userId);
  if (roleId) {
    const { data: rp } = await supabaseServer
      .from("role_permissions")
      .select("permission_id")
      .eq("role_id", roleId);
    for (const row of rp ?? []) {
      const id = String((row as { permission_id?: unknown }).permission_id ?? "").trim();
      if (id) permIdSet.add(id);
    }
  }

  const { data: ugRows } = await supabaseServer
    .from("user_groups")
    .select("group_id")
    .eq("profile_id", userId);
  const candidateGroupIds = [...new Set(
    (ugRows ?? [])
      .map((x) => String((x as { group_id?: unknown }).group_id ?? "").trim())
      .filter((id) => id && isUuidString(id)),
  )];
  if (candidateGroupIds.length > 0) {
    const { data: gRows } = await supabaseServer
      .from("groups")
      .select("id")
      .in("id", candidateGroupIds)
      .eq("organization_id", organizationId);
    const orgGroupIds = (gRows ?? [])
      .map((gr) => String((gr as { id?: unknown }).id ?? "").trim())
      .filter((id) => isUuidString(id));
    if (orgGroupIds.length > 0) {
      const { data: gpRows } = await supabaseServer
        .from("group_permissions")
        .select("permission_id")
        .in("group_id", orgGroupIds);
      for (const row of gpRows ?? []) {
        const id = String((row as { permission_id?: unknown }).permission_id ?? "").trim();
        if (id) permIdSet.add(id);
      }
    }
  }

  if (permIdSet.size === 0) return keys;

  const { data: permRows } = await supabaseServer
    .from("permissions")
    .select("key")
    .in("id", [...permIdSet]);
  for (const row of permRows ?? []) {
    const k = String((row as { key?: unknown }).key ?? "").trim();
    if (k) keys.add(k);
  }
  return keys;
}

export async function userHasOperatorMobilePermission(
  userId: string,
  organizationId: string,
  permissionKey: OperatorMobilePermissionKey,
): Promise<boolean> {
  if (!isOperatorMobilePermissionKey(permissionKey)) return false;
  const granted = await loadOperatorMobilePermissionKeysForUser(userId, organizationId);
  if (granted.has(permissionKey)) return true;
  const roleKey = normalizeRoleKeyForBranding(await resolveCanonicalRoleKey(userId));
  return BOOTSTRAP_CORRECTION_ROLE_KEYS.has(roleKey);
}

export async function assertOperatorMobilePermission(
  organizationId: string,
  permissionKey: OperatorMobilePermissionKey,
): Promise<AssertOperatorMobilePermissionResult> {
  const uid = await getSessionUserIdFromCookies();
  if (!uid || !isUuidString(uid)) {
    return { ok: false, message: "Not signed in." };
  }
  const org = await assertUserCanAccessOrganization(organizationId);
  if (!org.ok) {
    return { ok: false, message: org.error };
  }
  if (org.userId !== uid) {
    return { ok: false, message: "Session user mismatch." };
  }
  const allowed = await userHasOperatorMobilePermission(uid, organizationId, permissionKey);
  if (!allowed) {
    return { ok: false, message: OPERATOR_MOBILE_PERMISSION_DENIED_MESSAGE };
  }
  return { ok: true, userId: uid };
}

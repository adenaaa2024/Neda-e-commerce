import "server-only";

import type { StoreAccessFloor } from "./claim-permissions";
import { getUserStoreAccessForOrganization, loadUserOrgAccessFlags } from "./claim-permission-evaluate";
import { supabaseServer } from "./supabase-server";
import { isUuidString } from "./uuid";

export type MyStoreEntry = {
  store_id: string;
  name: string;
  platform: string;
  is_active: boolean;
  access_level: StoreAccessFloor;
  source: string;
  virtual: boolean;
  /** ISO timestamp from `user_store_assignments.ends_at`, or null. */
  expires_at: string | null;
};

export type MyStoresPayload = {
  organization_id: string;
  has_virtual_coverage: boolean;
  stores: MyStoreEntry[];
};

/**
 * Virtual rows use `submit` to match `effectiveStoreAccess` in claim-permission-evaluate
 * for tenant_admin / platform when no explicit assignment exists (non–requireExplicit paths).
 */
const VIRTUAL_ACCESS_LEVEL: StoreAccessFloor = "submit";

/**
 * Read-only: active assignments + store metadata, merged with virtual admin coverage.
 */
export async function getMyStoresForUser(
  userId: string,
  organizationId: string,
  options?: { includeInactive?: boolean },
): Promise<{ ok: true; payload: MyStoresPayload } | { ok: false; message: string; status: number }> {
  if (!isUuidString(userId) || !isUuidString(organizationId)) {
    return { ok: false, message: "Invalid user or organization id.", status: 400 };
  }

  const flags = await loadUserOrgAccessFlags(userId, organizationId);
  if (!flags.ok) {
    return { ok: false, message: "You do not have access to this organization.", status: 403 };
  }

  const includeInactive = options?.includeInactive === true;

  let storeQuery = supabaseServer
    .from("stores")
    .select("id, name, platform, is_active")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });

  if (!includeInactive) {
    storeQuery = storeQuery.eq("is_active", true);
  }

  const { data: storeRows, error: storeErr } = await storeQuery;
  if (storeErr) {
    return { ok: false, message: storeErr.message, status: 500 };
  }

  const storesById = new Map<string, { name: string; platform: string; is_active: boolean }>();
  for (const r of storeRows ?? []) {
    const row = r as { id: string; name: string; platform: string; is_active: boolean | null };
    if (!row?.id) continue;
    storesById.set(String(row.id), {
      name: String(row.name ?? ""),
      platform: String(row.platform ?? ""),
      is_active: row.is_active !== false,
    });
  }

  const assignRes = await getUserStoreAccessForOrganization(userId, organizationId);
  if (!assignRes.ok) {
    return { ok: false, message: assignRes.message, status: 500 };
  }

  const hasVirtualCoverage = flags.isTenantAdminHome || flags.isPlatformStaff;

  const merged = new Map<string, MyStoreEntry>();

  if (hasVirtualCoverage) {
    for (const [id, meta] of storesById) {
      merged.set(id, {
        store_id: id,
        name: meta.name,
        platform: meta.platform,
        is_active: meta.is_active,
        access_level: VIRTUAL_ACCESS_LEVEL,
        source: flags.isPlatformStaff ? "virtual_platform" : "virtual_tenant_admin",
        virtual: true,
        expires_at: null,
      });
    }
  }

  for (const row of assignRes.rows) {
    const meta = storesById.get(row.store_id);
    if (!meta) continue;
    if (!includeInactive && !meta.is_active) continue;

    merged.set(row.store_id, {
      store_id: row.store_id,
      name: meta.name,
      platform: meta.platform,
      is_active: meta.is_active,
      access_level: row.access_level,
      source: row.source,
      virtual: false,
      expires_at: row.ends_at,
    });
  }

  const stores = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    payload: {
      organization_id: organizationId,
      has_virtual_coverage: hasVirtualCoverage,
      stores,
    },
  };
}

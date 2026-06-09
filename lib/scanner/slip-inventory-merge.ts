import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import { findPackageIdsByColumnForStore } from "@/lib/scanner/package-tracking-lookup";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";
import type { VInventoryStatusRow } from "@/lib/scanner/v-inventory-status";

function coerceInt(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function scannedQty(row: { scanned_quantity?: number | null }): number {
  const n = Number(row.scanned_quantity ?? 1);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.trunc(n);
}

/** Same grain as `v_inventory_item_status` item_grouped (tracking + slip + sku + fnsku). */
export function inventoryItemGroupKey(row: {
  tracking_number?: string | null;
  id_slip_contents?: string | null;
  sku?: string | null;
  fnsku?: string | null;
}): string {
  const trackingRaw = String(row.tracking_number ?? "").trim();
  const tracking = normalizeTrackingKey(trackingRaw) || trackingRaw;
  return [
    tracking,
    String(row.id_slip_contents ?? "").trim(),
    String(row.sku ?? "").trim().toLowerCase(),
    String(row.fnsku ?? "").trim().toLowerCase(),
  ].join("\u0000");
}

function buildScannedGroupsFromPackagesAndReturnItems(
  orgId: string,
  sid: string,
  slipCode: string,
  packages: { id: string; tracking_number: string | null; id_slip_contents: string | null }[],
  retRows: Record<string, unknown>[],
): VInventoryStatusRow[] {
  const pkgById = new Map(packages.map((p) => [p.id, p]));
  type Acc = {
    tracking_number: string | null;
    id_slip_contents: string | null;
    sku: string | null;
    fnsku: string | null;
    scanned: number;
    resolved_product_id: string | null;
  };
  const groups = new Map<string, Acc>();

  for (const r of retRows) {
    if (
      shouldExcludeReturnItemFromScannerCounts({
        item_name: (r as { item_name?: string | null }).item_name,
        sku: (r as { sku?: string | null }).sku,
        fnsku: (r as { fnsku?: string | null }).fnsku,
        product_identifier: (r as { product_identifier?: string | null }).product_identifier,
        notes: (r as { notes?: string | null }).notes,
      })
    ) {
      continue;
    }
    const pkgId = String((r as { package_id?: string | null }).package_id ?? "");
    const pkg = pkgById.get(pkgId);
    if (!pkg) continue;

    const sku = String((r as { sku?: string | null }).sku ?? "").trim() || null;
    const fnsku = String((r as { fnsku?: string | null }).fnsku ?? "").trim() || null;
    const rowShape = {
      tracking_number: pkg.tracking_number,
      id_slip_contents: pkg.id_slip_contents ?? slipCode,
      sku,
      fnsku,
    };
    const key = inventoryItemGroupKey(rowShape);
    const qty = scannedQty(r as { scanned_quantity?: number | null });
    const prev = groups.get(key);
    if (prev) {
      prev.scanned += qty;
    } else {
      groups.set(key, {
        tracking_number: pkg.tracking_number,
        id_slip_contents: pkg.id_slip_contents ?? slipCode,
        sku,
        fnsku,
        scanned: qty,
        resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
      });
    }
  }

  const out: VInventoryStatusRow[] = [];
  for (const g of groups.values()) {
    out.push({
      expected_package_id: "",
      organization_id: orgId,
      store_id: sid,
      tracking_number: g.tracking_number,
      id_slip_contents: g.id_slip_contents,
      sku: g.sku,
      fnsku: g.fnsku,
      asin: null,
      order_id: null,
      status: null,
      product_name: null,
      product_display_name: null,
      product_id: null,
      resolved_product_id: g.resolved_product_id,
      resolved_catalog_product_id: null,
      product_linkage_status: null,
      identifier_resolution_status: null,
      identifier_resolution_confidence: null,
      carrier: null,
      total_expected: 0,
      total_scanned: g.scanned,
    });
  }
  return out;
}

/** Batched slip scanned groups: one package-id query + one return_items query. */
export async function fetchScannedInventoryGroupsForPackageIds(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  slipCode: string,
  packageIds: string[],
): Promise<VInventoryStatusRow[]> {
  const code = String(slipCode ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const ids = [...new Set(packageIds.filter(Boolean))];
  if (!code || !orgId || !sid || !ids.length) return [];

  const [pkgRes, retRes] = await Promise.all([
    supabase
      .from("packages")
      .select("id, tracking_number, id_slip_contents")
      .in("id", ids)
      .is("deleted_at", null),
    supabase
      .from(RETURN_ITEMS_TABLE)
      .select("sku, fnsku, resolved_product_id, scanned_quantity, package_id, item_name, product_identifier, notes")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .is("deleted_at", null)
      .in("package_id", ids),
  ]);

  if (pkgRes.error) throw pkgRes.error;
  if (retRes.error) throw retRes.error;
  const packages = pkgRes.data;
  if (!packages?.length) return [];

  const pkgMeta = packages.map((p) => ({
    id: String((p as { id: string }).id),
    tracking_number: (p as { tracking_number?: string | null }).tracking_number ?? null,
    id_slip_contents: (p as { id_slip_contents?: string | null }).id_slip_contents ?? null,
  }));

  return buildScannedGroupsFromPackagesAndReturnItems(orgId, sid, code, pkgMeta, retRes.data ?? []);
}

/**
 * Scanned-only inventory groups for a package slip code — mirrors `v_scanned_items_counted`
 * filtered to `packages.id_slip_contents` (base tables only; no aggregate views).
 */
export async function fetchScannedInventoryGroupsForPackageSlip(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  slipCode: string,
): Promise<VInventoryStatusRow[]> {
  const code = String(slipCode ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!code || !orgId || !sid) return [];

  const { data: packages, error: pkgErr } = await supabase
    .from("packages")
    .select("id, tracking_number, id_slip_contents")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq("id_slip_contents", code)
    .is("deleted_at", null);
  if (pkgErr) throw pkgErr;
  if (!packages?.length) return [];

  const ids = packages.map((p) => String((p as { id: string }).id));
  return fetchScannedInventoryGroupsForPackageIds(supabase, orgId, sid, code, ids);
}

/**
 * Union expected (EP) and scanned-only rows at view grain without duplicate groups.
 * Matches `v_inventory_item_status` combined_totals → item_grouped behavior.
 */
export function mergeExpectedAndScannedInventoryRows(
  expectedRows: VInventoryStatusRow[],
  scannedRows: VInventoryStatusRow[],
): VInventoryStatusRow[] {
  const map = new Map<string, VInventoryStatusRow>();

  for (const row of expectedRows) {
    const k = inventoryItemGroupKey(row);
    map.set(k, { ...row, total_scanned: 0 });
  }

  for (const row of scannedRows) {
    const k = inventoryItemGroupKey(row);
    const prev = map.get(k);
    if (prev) {
      map.set(k, {
        ...prev,
        total_scanned: prev.total_scanned + coerceInt(row.total_scanned),
        resolved_product_id: prev.resolved_product_id ?? row.resolved_product_id,
      });
    } else {
      map.set(k, { ...row, total_expected: 0 });
    }
  }

  return [...map.values()].filter((row) => row.total_expected > 0 || row.total_scanned > 0);
}

/** Single batched slip identity: EP aggregate + scanned union (no aggregate views). */
export async function resolveSlipIdentityRows(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  slipCode: string,
  epRows: Record<string, unknown>[],
  packageIds: string[],
  aggregateEpRows: (rows: Record<string, unknown>[], orgId: string, sid: string) => VInventoryStatusRow[],
): Promise<VInventoryStatusRow[]> {
  const code = String(slipCode ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!code || !orgId || !sid) return [];

  const expectedMapped = epRows.length ? aggregateEpRows(epRows, orgId, sid) : [];
  const scannedMapped = packageIds.length
    ? await fetchScannedInventoryGroupsForPackageIds(supabase, orgId, sid, code, packageIds)
    : [];

  return mergeExpectedAndScannedInventoryRows(expectedMapped, scannedMapped);
}

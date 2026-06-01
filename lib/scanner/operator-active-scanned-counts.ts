import type { SupabaseClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE } from "@/app/returns/returns-constants";
import { fetchReturnItemsScannedCountsForTracking } from "@/lib/scanner/operator-tracking-expectations";
import { shouldExcludeReturnItemFromScannerCounts } from "@/lib/scanner/return-items-test-data-guard";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";
import {
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";
import { isUuidString } from "@/lib/uuid";

const BASELINE_NOTES_PREFIX = "Shipment Entry baseline initialized for unlisted tracking ";

function sfKey(sku: string, fnsku: string): string {
  return `${sku.toLowerCase()}\u0000${fnsku.toLowerCase()}`;
}

function baselineTrackingFromNotes(notes: string | null | undefined): string | null {
  const raw = String(notes ?? "").trim();
  if (!raw.startsWith(BASELINE_NOTES_PREFIX)) return null;
  const rest = raw.slice(BASELINE_NOTES_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot < 0) return null;
  const tn = rest.slice(0, dot).trim();
  return tn || null;
}

async function hasActivePackageForCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
): Promise<boolean> {
  const trimmed = String(code ?? "").trim();
  if (!trimmed || !isUuidString(organizationId.trim()) || !isUuidString(storeId.trim())) {
    return false;
  }
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const key = normalizeTrackingKey(trimmed);

  for (const column of ["package_code", "tracking_number"] as const) {
    const { data, error } = await supabase
      .from("packages")
      .select("id, tracking_number, package_code")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .eq(column, trimmed)
      .is("deleted_at", null)
      .limit(5);
    if (error) throw error;
    if ((data ?? []).length > 0) return true;
  }

  if (!key) return false;

  const PAGE = 250;
  for (let off = 0; off < 4000; off += PAGE) {
    const { data: page, error } = await supabase
      .from("packages")
      .select("id, tracking_number")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .is("deleted_at", null)
      .not("tracking_number", "is", null)
      .range(off, off + PAGE - 1);
    if (error) throw error;
    for (const row of page ?? []) {
      if (normalizeTrackingKey(String((row as { tracking_number?: string | null }).tracking_number ?? "")) === key) {
        return true;
      }
    }
    if (!page?.length || page.length < PAGE) break;
  }
  return false;
}

async function loadActivePackageIdSet(
  supabase: SupabaseClient,
  packageIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(packageIds.filter((id) => isUuidString(id)))];
  if (!ids.length) return new Set();
  const active = new Set<string>();
  const chunkSize = 80;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("packages")
      .select("id")
      .in("id", chunk)
      .is("deleted_at", null);
    if (error) throw error;
    for (const row of data ?? []) {
      const id = String((row as { id?: string }).id ?? "").trim();
      if (id) active.add(id);
    }
  }
  return active;
}

/** Count active `return_items` for a SKU/FNSKU scan, excluding voided packages and orphaned baselines. */
export async function countActiveReturnItemsForIdentifierScan(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  field: "sku" | "fnsku",
  value: string,
): Promise<number> {
  const v = String(value ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!v || !orgId || !sid) return 0;

  const { data: items, error } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id, package_id, notes, item_name, sku, fnsku, product_identifier")
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq(field, v)
    .is("deleted_at", null);
  if (error) throw error;
  if (!items?.length) return 0;

  const activeItems = items.filter(
    (item) =>
      !shouldExcludeReturnItemFromScannerCounts({
        item_name: (item as { item_name?: string | null }).item_name,
        sku: (item as { sku?: string | null }).sku,
        fnsku: (item as { fnsku?: string | null }).fnsku,
        product_identifier: (item as { product_identifier?: string | null }).product_identifier,
        notes: (item as { notes?: string | null }).notes,
      }),
  );
  if (!activeItems.length) return 0;

  const activePackageIds = await loadActivePackageIdSet(
    supabase,
    activeItems.map((item) => String((item as { package_id?: string | null }).package_id ?? "")),
  );

  let count = 0;
  for (const item of activeItems) {
    const pkgId = String((item as { package_id?: string | null }).package_id ?? "").trim();
    if (pkgId) {
      if (activePackageIds.has(pkgId)) count++;
      continue;
    }
    const baselineTn = baselineTrackingFromNotes((item as { notes?: string | null }).notes);
    if (baselineTn) {
      if (await hasActivePackageForCode(supabase, orgId, sid, baselineTn)) count++;
      continue;
    }
    count++;
  }
  return count;
}

function rowIdentifierKey(row: VInventoryStatusRow): string {
  return sfKey(String(row.sku ?? "").trim(), String(row.fnsku ?? "").trim());
}

/**
 * Recompute Shipment Entry inventory rows so voided packages and orphaned direct-box baselines
 * do not inflate scanned counts or produce stale "unexpected" gate cards.
 */
export async function scrubInventoryRowsExcludingVoidedPackages(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rows: VInventoryStatusRow[],
  matchedField: InventoryViewMatchField | null,
  searchCode: string,
): Promise<VInventoryStatusRow[]> {
  if (!rows.length) return rows;
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!orgId || !sid) return rows;

  let adjusted: VInventoryStatusRow[];

  if (matchedField === "tracking_number") {
    const tn = String(searchCode ?? "").trim();
    const maps = await fetchReturnItemsScannedCountsForTracking(supabase, orgId, sid, tn);
    adjusted = rows.map((row) => {
      const key = rowIdentifierKey(row);
      const scanned = maps.bySkuFnsku.get(key) ?? 0;
      return { ...row, total_scanned: scanned };
    });
  } else if (matchedField === "sku") {
    const scanned = await countActiveReturnItemsForIdentifierScan(supabase, orgId, sid, "sku", searchCode);
    adjusted = rows.map((row) => ({ ...row, total_scanned: scanned }));
  } else if (matchedField === "fnsku") {
    const scanned = await countActiveReturnItemsForIdentifierScan(supabase, orgId, sid, "fnsku", searchCode);
    adjusted = rows.map((row) => ({ ...row, total_scanned: scanned }));
  } else if (matchedField === "id_slip_contents") {
    const code = String(searchCode ?? "").trim();
    const hasActive = code ? await hasActivePackageForCode(supabase, orgId, sid, code) : false;
    adjusted = rows.map((row) => ({
      ...row,
      total_scanned: hasActive ? row.total_scanned : 0,
    }));
  } else {
    adjusted = rows.map((row) => ({ ...row }));
    const activePackageIds = await loadActivePackageIdSet(
      supabase,
      rows
        .map((row) => String(row.expected_package_id ?? "").trim())
        .filter((id) => isUuidString(id)),
    );
    if (activePackageIds.size === 0 && rows.every((row) => row.total_scanned > 0)) {
      const code = String(searchCode ?? "").trim();
      if (code && !(await hasActivePackageForCode(supabase, orgId, sid, code))) {
        adjusted = adjusted.map((row) => ({ ...row, total_scanned: 0 }));
      }
    }
  }

  return adjusted.filter((row) => row.total_expected > 0 || row.total_scanned > 0);
}

/** Soft-delete Shipment Entry baseline loose `return_items` for voided direct-box codes. */
export async function softDeleteShipmentEntryBaselineReturnItems(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  codes: string[],
  nowIso: string,
): Promise<void> {
  const orgId = organizationId.trim();
  if (!orgId) return;
  const sid = String(storeId ?? "").trim();
  const uniqueCodes = [...new Set(codes.map((c) => String(c ?? "").trim()).filter(Boolean))];
  for (const code of uniqueCodes) {
    const notePattern = `${BASELINE_NOTES_PREFIX}${code}.`;
    let q = supabase
      .from(RETURN_ITEMS_TABLE)
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .eq("organization_id", orgId)
      .is("package_id", null)
      .is("deleted_at", null)
      .eq("notes", notePattern);
    if (sid && isUuidString(sid)) {
      q = q.eq("store_id", sid);
    }
    const { error } = await q;
    if (error) throw error;
  }
}

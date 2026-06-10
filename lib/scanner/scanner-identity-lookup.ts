import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EP_DETAIL_SELECT,
  fetchExpectedPackagesForTracking,
  type FetchExpectedPackagesOptions,
} from "@/lib/scanner/operator-tracking-expectations";
import { findPackageIdsByColumnForStore } from "@/lib/scanner/package-tracking-lookup";
import {
  fetchIdentityGateViaRpc,
  isStrongShipmentIdentityMatchType,
  type ScannerIdentityGateMatchType,
} from "@/lib/scanner/scanner-identity-gate-rpc";
import { resolveSlipIdentityRows } from "@/lib/scanner/slip-inventory-merge";
import { normalizeTrackingKey, slipIdLookupCandidates, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";
import {
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";

function coerceInt(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function isMissingColumnError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "");
  return /42703|column.*does not exist/i.test(msg);
}

function identitySelectFallback(select: string): string | null {
  return null;
}

/** Group raw EP rows to match `v_inventory_item_status` item_grouped grain. */
function aggregateEpRowsLikeInventoryView(
  rows: Record<string, unknown>[],
  orgId: string,
  storeId: string,
): VInventoryStatusRow[] {
  type Acc = {
    tracking: string;
    slip: string;
    sku: string;
    fnsku: string;
    orderId: string;
    expected: number;
    scanned: number;
    epIds: Set<string>;
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  const groups = new Map<string, Acc>();

  for (const r of rows) {
    const trackingRaw = String((r as { tracking_number?: string | null }).tracking_number ?? "").trim();
    const tracking = normalizeTrackingKey(trackingRaw) || trackingRaw;
    const slip = String((r as { id_slip_contents?: string | null }).id_slip_contents ?? "").trim();
    const sku = String((r as { sku?: string | null }).sku ?? "").trim();
    const fnsku = String((r as { fnsku?: string | null }).fnsku ?? "").trim();
    const key = [tracking, slip, sku, fnsku].join("\u0000");
    const exp = coerceInt((r as { expected_scan_quantity?: number }).expected_scan_quantity);
    const act = coerceInt((r as { actual_scanned_count?: number }).actual_scanned_count);
    const epId = String((r as { id?: string }).id ?? "").trim();

    const prev = groups.get(key);
    if (prev) {
      prev.expected += exp;
      prev.scanned += act;
      if (epId) prev.epIds.add(epId);
      if ((r as { order_id?: string | null }).order_id) {
        prev.orderId = String((r as { order_id?: string | null }).order_id);
      }
    } else {
      groups.set(key, {
        tracking,
        slip,
        sku,
        fnsku,
        orderId: String((r as { order_id?: string | null }).order_id ?? "").trim(),
        expected: exp,
        scanned: act,
        epIds: new Set(epId ? [epId] : []),
        resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
        resolved_catalog_product_id:
          (r as { resolved_catalog_product_id?: string | null }).resolved_catalog_product_id ?? null,
        identifier_resolution_status:
          (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
        identifier_resolution_confidence:
          (r as { identifier_resolution_confidence?: number | null }).identifier_resolution_confidence ?? null,
      });
    }
  }

  const out: VInventoryStatusRow[] = [];
  for (const g of groups.values()) {
    const epId = g.epIds.size === 1 ? [...g.epIds][0]! : "";
    out.push({
      expected_package_id: epId,
      organization_id: orgId,
      store_id: storeId,
      tracking_number: g.tracking || null,
      id_slip_contents: g.slip || null,
      sku: g.sku || null,
      fnsku: g.fnsku || null,
      asin: null,
      order_id: g.orderId || null,
      status: null,
      product_name: null,
      product_display_name: null,
      product_id: null,
      resolved_product_id: g.resolved_product_id,
      resolved_catalog_product_id: g.resolved_catalog_product_id,
      product_linkage_status: g.identifier_resolution_status,
      identifier_resolution_status: g.identifier_resolution_status,
      identifier_resolution_confidence: g.identifier_resolution_confidence,
      carrier: null,
      total_expected: g.expected,
      total_scanned: g.scanned,
    });
  }
  return out;
}

function mapEpRowsForMatchField(
  rows: Record<string, unknown>[],
  field: InventoryViewMatchField,
  orgId: string,
  storeId: string,
): VInventoryStatusRow[] {
  if (field === "tracking_number") {
    return rows.map((r) => expectedPackageRowToInventoryStatusRow(r, orgId, storeId));
  }
  return aggregateEpRowsLikeInventoryView(rows, orgId, storeId);
}

function asRowArray(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

/** Map `expected_packages` row → gate inventory row shape. */
export function expectedPackageRowToInventoryStatusRow(
  r: Record<string, unknown>,
  orgId: string,
  storeId: string,
): VInventoryStatusRow {
  return {
    expected_package_id: String((r as { id?: string }).id ?? ""),
    organization_id: orgId,
    store_id: storeId,
    tracking_number:
      (r as { tracking_number?: string | null }).tracking_number != null
        ? String((r as { tracking_number?: string | null }).tracking_number)
        : null,
    id_slip_contents:
      (r as { id_slip_contents?: string | null }).id_slip_contents != null
        ? String((r as { id_slip_contents?: string | null }).id_slip_contents)
        : (r as { slip_code?: string | null }).slip_code != null
          ? String((r as { slip_code?: string | null }).slip_code)
          : null,
    sku: (r as { sku?: string | null }).sku != null ? String((r as { sku?: string | null }).sku) : null,
    fnsku: (r as { fnsku?: string | null }).fnsku != null ? String((r as { fnsku?: string | null }).fnsku) : null,
    asin: (r as { asin?: string | null }).asin != null ? String((r as { asin?: string | null }).asin) : null,
    order_id:
      (r as { order_id?: string | null }).order_id != null
        ? String((r as { order_id?: string | null }).order_id)
        : null,
    status: null,
    product_name: null,
    product_display_name: null,
    product_id: (r as { product_id?: string | null }).product_id ?? null,
    resolved_product_id: (r as { resolved_product_id?: string | null }).resolved_product_id ?? null,
    resolved_catalog_product_id:
      (r as { resolved_catalog_product_id?: string | null }).resolved_catalog_product_id ?? null,
    product_linkage_status:
      (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
    identifier_resolution_status:
      (r as { identifier_resolution_status?: string | null }).identifier_resolution_status ?? null,
    identifier_resolution_confidence:
      (r as { identifier_resolution_confidence?: number | null }).identifier_resolution_confidence ?? null,
    carrier: null,
    total_expected: coerceInt((r as { expected_scan_quantity?: number }).expected_scan_quantity),
    total_scanned: coerceInt((r as { actual_scanned_count?: number }).actual_scanned_count),
  };
}

async function fetchExpectedPackagesByExactField(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  field: Exclude<InventoryViewMatchField, "tracking_number">,
  value: string,
  selectColumns: string,
): Promise<Record<string, unknown>[]> {
  const v = String(value ?? "").trim();
  if (!v) return [];

  const PAGE = 1000;
  const merged: Record<string, unknown>[] = [];
  let select = selectColumns;

  for (let from = 0; ; from += PAGE) {
    let { data, error } = await supabase
      .from("expected_packages")
      .select(select)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq(field, v)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error && isMissingColumnError(error)) {
      const fallback = identitySelectFallback(select);
      if (!fallback) throw error;
      select = fallback;
      ({ data, error } = await supabase
        .from("expected_packages")
        .select(select)
        .eq("organization_id", organizationId)
        .eq("store_id", storeId)
        .eq(field, v)
        .order("id", { ascending: true })
        .range(from, from + PAGE - 1));
    }
    if (error) throw error;

    const page = asRowArray(data);
    merged.push(...page);
    if (page.length < PAGE) break;
  }

  return merged;
}

/**
 * Phase 9B identity gate: indexed `expected_packages` lookup (fnsku → sku → tracking → slip).
 * Phase 9D: prefers single RPC round trip when `scanner_identity_gate_lookup` is available.
 * Does not query aggregate inventory views.
 */
export async function fetchIdentityStatusForScanCode(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
  options?: FetchExpectedPackagesOptions,
): Promise<{
  rows: VInventoryStatusRow[];
  raw: unknown;
  matchedField: InventoryViewMatchField | null;
  matchType?: ScannerIdentityGateMatchType | null;
  scrubApplied?: boolean;
}> {
  const code = String(rawCode ?? "")
    .trim()
    .replace(/^[\s\uFEFF\xA0\u200B-\u200D]+|[\s\uFEFF\xA0\u200B-\u200D]+$/g, "");
  if (!code) return { rows: [], raw: null, matchedField: null };

  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!orgId || !sid) return { rows: [], raw: null, matchedField: null };

  let legacyRpcStrongZero: {
    matchType: ScannerIdentityGateMatchType;
    matchedField: InventoryViewMatchField | null;
  } | null = null;

  const rpcHit = await fetchIdentityGateViaRpc(supabase, orgId, sid, code).catch(() => null);
  if (rpcHit) {
    const rpcStrongZeroRows =
      !rpcHit.rows.length && isStrongShipmentIdentityMatchType(rpcHit.matchType);
    const useRpcOnly =
      rpcHit.rows.length > 0 ||
      !rpcStrongZeroRows ||
      options?.gateFastNegative === true;
    if (useRpcOnly) {
      return {
        rows: rpcHit.rows,
        raw: {
          phase9d_rpc: true,
          package_ids: rpcHit.packageIds,
          tracking_numbers: rpcHit.trackingNumbers,
          match_type: rpcHit.matchType,
        },
        matchedField: rpcHit.matchedField,
        matchType: rpcHit.matchType,
        scrubApplied: rpcHit.scrubApplied,
      };
    }
    if (rpcHit.matchType) {
      legacyRpcStrongZero = { matchType: rpcHit.matchType, matchedField: rpcHit.matchedField };
    }
  }

  if (options?.gateFastNegative || options?.skipExpensiveFallback) {
    return {
      rows: [],
      raw: { gate_fast_negative: true },
      matchedField: null,
      matchType: null,
    };
  }

  let select = EP_DETAIL_SELECT;

  const tryField = async (
    field: InventoryViewMatchField,
    epRows: Record<string, unknown>[],
    matchType?: ScannerIdentityGateMatchType,
  ): Promise<{
    rows: VInventoryStatusRow[];
    raw: unknown;
    matchedField: InventoryViewMatchField;
    matchType?: ScannerIdentityGateMatchType;
  } | null> => {
    if (!epRows.length) return null;
    const mapped = mapEpRowsForMatchField(epRows, field, orgId, sid);
    return { rows: mapped, raw: epRows, matchedField: field, matchType };
  };

  let trackingRows: Record<string, unknown>[] = [];
  try {
    trackingRows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, code, select, options);
  } catch (err) {
    if (isMissingColumnError(err)) {
      select = EP_DETAIL_SELECT;
      trackingRows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, code, select, options);
    } else {
      throw err;
    }
  }
  const trackingHit = await tryField("tracking_number", trackingRows, "tracking");
  if (trackingHit) return trackingHit;

  const packageIdsByCode = await findPackageIdsByColumnForStore(supabase, orgId, sid, "package_code", code);
  if (packageIdsByCode.length) {
    const { data: pkgRows, error: pkgErr } = await supabase
      .from("packages")
      .select("tracking_number")
      .eq("organization_id", orgId)
      .eq("store_id", sid)
      .eq("package_code", code)
      .is("deleted_at", null)
      .limit(1);
    if (pkgErr) throw pkgErr;
    const pkgTracking = String((pkgRows?.[0] as { tracking_number?: string | null } | undefined)?.tracking_number ?? "").trim();
    if (pkgTracking) {
      const pkgEpRows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, pkgTracking, select, options);
      const pkgHit = await tryField("tracking_number", pkgEpRows, "package_code");
      if (pkgHit) return pkgHit;
    }
    return {
      rows: [],
      raw: { package_ids: packageIdsByCode },
      matchedField: "tracking_number",
      matchType: "package_code",
    };
  }

  const [slipRows, packageIds] = await Promise.all([
    fetchExpectedPackagesByExactField(supabase, orgId, sid, "id_slip_contents", code, select),
    findPackageIdsByColumnForStore(supabase, orgId, sid, "id_slip_contents", code),
  ]);
  const merged = await resolveSlipIdentityRows(
    supabase,
    orgId,
    sid,
    code,
    slipRows,
    packageIds,
    aggregateEpRowsLikeInventoryView,
  );
  if (merged.length) {
    return { rows: merged, raw: slipRows, matchedField: "id_slip_contents", matchType: "slip_code" };
  }

  const { data: orderEpData, error: orderEpErr } = await supabase
    .from("expected_packages")
    .select(select)
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .eq("order_id", code)
    .limit(1000);
  if (orderEpErr) throw orderEpErr;
  const orderEpRows = asRowArray(orderEpData);
  if (orderEpRows.length) {
    const orderHit = await tryField("tracking_number", orderEpRows, "removal_order_id");
    if (orderHit) return orderHit;
  }

  const fnskuRows = await fetchExpectedPackagesByExactField(supabase, orgId, sid, "fnsku", code, select);
  const fnskuHit = await tryField("fnsku", fnskuRows, "product_identifier_fallback");
  if (fnskuHit) return fnskuHit;

  const skuRows = await fetchExpectedPackagesByExactField(supabase, orgId, sid, "sku", code, select);
  const skuHit = await tryField("sku", skuRows, "product_identifier_fallback");
  if (skuHit) return skuHit;

  if (legacyRpcStrongZero) {
    return {
      rows: [],
      raw: { phase9d_rpc_strong_zero_legacy: true, match_type: legacyRpcStrongZero.matchType },
      matchedField: legacyRpcStrongZero.matchedField,
      matchType: legacyRpcStrongZero.matchType,
    };
  }

  return { rows: [], raw: null, matchedField: null, matchType: null };
}

/**
 * Item-level lines for a tracking scan from `expected_packages` (indexed), not aggregate views.
 */
export async function fetchIdentityItemStatusLinesForTrackingNormalized(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  trackingNumber: string,
  options?: FetchExpectedPackagesOptions,
): Promise<{ rows: VInventoryStatusRow[]; raw: unknown[] }> {
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const trimmed = String(trackingNumber ?? "").trim();
  const key = normalizeTrackingKey(trimmed);
  if (!key || !orgId || !sid) return { rows: [], raw: [] };

  let select = EP_DETAIL_SELECT;
  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const candidate of slipIdLookupCandidates(trimmed, key)) {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, candidate, select, options);
    } catch (err) {
      if (isMissingColumnError(err)) {
        select = EP_DETAIL_SELECT;
        rows = await fetchExpectedPackagesForTracking(supabase, orgId, sid, candidate, select, options);
      } else {
        throw err;
      }
    }
    for (const r of rows) {
      if (!trackingKeysEqual((r as { tracking_number?: string | null }).tracking_number, trimmed)) continue;
      const id = String((r as { id?: string }).id ?? "");
      const dedupe = id || JSON.stringify(r);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      merged.push(r);
    }
    if (merged.length) break;
  }

  const mapped = merged.map((r) => expectedPackageRowToInventoryStatusRow(r, orgId, sid));
  return { rows: mapped, raw: merged };
}

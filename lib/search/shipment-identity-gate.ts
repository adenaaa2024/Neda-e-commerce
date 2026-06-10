/**
 * Phase 10 — canonical shipment identity gate (RPC-first + fast-negative probes).
 * Used by scanner Shipment Entry, inventory tracking panels, and package lookup.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchIdentityGateViaRpc,
  isStrongShipmentIdentityMatchType,
  type ScannerIdentityGateMatchType,
  type ScannerIdentityGateRpcResult,
} from "@/lib/scanner/scanner-identity-gate-rpc";
import {
  isLikelyShipmentTrackingCode,
  preferExactTrackingFilter,
} from "@/lib/search/tracking-resolve";

export { preferExactTrackingFilter };
import type { InventoryViewMatchField } from "@/lib/scanner/v-inventory-status";

export {
  fetchIdentityGateViaRpc,
  isStrongShipmentIdentityMatchType,
  type ScannerIdentityGateMatchType,
  type ScannerIdentityGateRpcResult,
};

export type ShipmentIdentityGateOptions = {
  skipExpensiveFallback?: boolean;
  gateFastNegative?: boolean;
};

const PACKAGE_PROBE_SELECT =
  "id, organization_id, store_id, package_code, id_slip_contents, rma_number, tracking_number, expected_item_count, actual_item_count, status";

export function isGateFastNegativeEnabled(opts?: ShipmentIdentityGateOptions): boolean {
  return Boolean(opts?.skipExpensiveFallback || opts?.gateFastNegative);
}

/** Limited barcode probe for fast-negative gate (package_code / slip / rma only). */
export function shouldTryLimitedBarcodeProbe(code: string): boolean {
  const c = code.trim();
  if (!c || isLikelyShipmentTrackingCode(c)) return false;
  if (/^\d{1,8}$/.test(c)) return true;
  return c.length <= 16;
}

/**
 * Single RPC round trip — primary shipment identity resolution.
 * Returns null when RPC is unavailable (callers fall back to legacy multi-query path).
 */
export async function lookupShipmentIdentityViaRpc(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
): Promise<ScannerIdentityGateRpcResult | null> {
  return fetchIdentityGateViaRpc(supabase, organizationId, storeId, code);
}

export type PackageSlipFastProbeResult = {
  found: boolean;
  package_id: string | null;
  package_code: string | null;
  slip_code: string | null;
  tracking_number: string | null;
};

/** Indexed package_code / slip / rma probe — no tracking ILIKE (Phase 9H fast-negative). */
export async function probePackageSlipRmaFast(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
): Promise<PackageSlipFastProbeResult> {
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  const trimmed = code.trim();
  if (!trimmed || !orgId || !sid) {
    return { found: false, package_id: null, package_code: null, slip_code: null, tracking_number: null };
  }

  const { data, error } = await supabase
    .from("packages")
    .select(PACKAGE_PROBE_SELECT)
    .eq("organization_id", orgId)
    .eq("store_id", sid)
    .is("deleted_at", null)
    .or(`package_code.eq.${trimmed},id_slip_contents.eq.${trimmed},rma_number.eq.${trimmed}`)
    .limit(1);
  if (error) throw error;

  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { found: false, package_id: null, package_code: null, slip_code: null, tracking_number: null };
  }

  return {
    found: true,
    package_id: String(row.id ?? "").trim() || null,
    package_code: String(row.package_code ?? "").trim() || null,
    slip_code: String(row.id_slip_contents ?? "").trim() || null,
    tracking_number: String(row.tracking_number ?? "").trim() || null,
  };
}

export type ShipmentIdentityTrackingHit = {
  tracking_numbers: string[];
  package_ids: string[];
  matched_field: InventoryViewMatchField | null;
  match_type: ScannerIdentityGateMatchType | null;
};

/**
 * Resolve tracking / package / slip for inventory panels — RPC-first, no view ILIKE.
 * Returns tracking numbers to use for exact view `.eq` filters when possible.
 */
export async function resolveShipmentIdentityForTrackingPanel(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  code: string,
  opts?: ShipmentIdentityGateOptions,
): Promise<ShipmentIdentityTrackingHit> {
  const trimmed = String(code ?? "").trim();
  if (!trimmed) {
    return { tracking_numbers: [], package_ids: [], matched_field: null, match_type: null };
  }

  const rpc = await lookupShipmentIdentityViaRpc(supabase, organizationId, storeId, trimmed);
  if (rpc && (rpc.rows.length || rpc.trackingNumbers.length || rpc.packageIds.length)) {
    const tracking_numbers = [
      ...new Set([
        ...rpc.trackingNumbers,
        ...rpc.rows.map((r) => String(r.tracking_number ?? "").trim()).filter(Boolean),
      ]),
    ];
    return {
      tracking_numbers,
      package_ids: rpc.packageIds,
      matched_field: rpc.matchedField,
      match_type: rpc.matchType,
    };
  }

  if (isGateFastNegativeEnabled(opts)) {
    const probe = await probePackageSlipRmaFast(supabase, organizationId, storeId, trimmed);
    if (probe.found) {
      return {
        tracking_numbers: probe.tracking_number ? [probe.tracking_number] : [],
        package_ids: probe.package_id ? [probe.package_id] : [],
        matched_field: probe.slip_code === trimmed ? "id_slip_contents" : "tracking_number",
        match_type: probe.slip_code === trimmed ? "slip_code" : "package_code",
      };
    }
    return { tracking_numbers: [], package_ids: [], matched_field: null, match_type: null };
  }

  return { tracking_numbers: [trimmed], package_ids: [], matched_field: "tracking_number", match_type: "tracking" };
}

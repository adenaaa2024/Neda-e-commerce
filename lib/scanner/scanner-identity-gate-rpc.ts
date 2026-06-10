import type { SupabaseClient } from "@supabase/supabase-js";
import type { InventoryViewMatchField, VInventoryStatusRow } from "@/lib/scanner/v-inventory-status";

export type ScannerIdentityGateMatchType =
  | "tracking"
  | "package_code"
  | "slip_code"
  | "amazon_order_id"
  | "removal_order_id"
  | "shipment_id"
  | "product_identifier_fallback";

const STRONG_SHIPMENT_IDENTITY_MATCH_TYPES: ReadonlySet<ScannerIdentityGateMatchType> = new Set([
  "tracking",
  "package_code",
  "slip_code",
  "amazon_order_id",
  "removal_order_id",
  "shipment_id",
]);

export function isStrongShipmentIdentityMatchType(
  matchType: ScannerIdentityGateMatchType | null | undefined,
): boolean {
  return matchType != null && STRONG_SHIPMENT_IDENTITY_MATCH_TYPES.has(matchType);
}

export type ScannerIdentityGateRpcResult = {
  rows: VInventoryStatusRow[];
  matchedField: InventoryViewMatchField | null;
  matchType: ScannerIdentityGateMatchType | null;
  packageIds: string[];
  trackingNumbers: string[];
  scrubApplied: boolean;
};

function isMissingRpcError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  return (
    msg.includes("scanner_identity_gate_lookup") &&
    (msg.includes("could not find") ||
      msg.includes("42883") ||
      msg.includes("does not exist") ||
      msg.includes("schema cache"))
  );
}

function coerceInt(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function mapRpcRow(raw: Record<string, unknown>, orgId: string, storeId: string): VInventoryStatusRow {
  return {
    expected_package_id: String(raw.expected_package_id ?? ""),
    organization_id: String(raw.organization_id ?? orgId),
    store_id: String(raw.store_id ?? storeId),
    tracking_number:
      raw.tracking_number != null && String(raw.tracking_number).trim()
        ? String(raw.tracking_number)
        : null,
    id_slip_contents:
      raw.id_slip_contents != null && String(raw.id_slip_contents).trim()
        ? String(raw.id_slip_contents)
        : null,
    sku: raw.sku != null && String(raw.sku).trim() ? String(raw.sku) : null,
    fnsku: raw.fnsku != null && String(raw.fnsku).trim() ? String(raw.fnsku) : null,
    asin: null,
    order_id: raw.order_id != null && String(raw.order_id).trim() ? String(raw.order_id) : null,
    status: null,
    product_name: null,
    product_display_name: null,
    product_id: null,
    resolved_product_id:
      raw.resolved_product_id != null && String(raw.resolved_product_id).trim()
        ? String(raw.resolved_product_id)
        : null,
    resolved_catalog_product_id:
      raw.resolved_catalog_product_id != null && String(raw.resolved_catalog_product_id).trim()
        ? String(raw.resolved_catalog_product_id)
        : null,
    product_linkage_status:
      raw.identifier_resolution_status != null
        ? String(raw.identifier_resolution_status)
        : null,
    identifier_resolution_status:
      raw.identifier_resolution_status != null
        ? String(raw.identifier_resolution_status)
        : null,
    identifier_resolution_confidence: (() => {
      const n = Number(raw.identifier_resolution_confidence);
      return Number.isFinite(n) ? n : null;
    })(),
    carrier: null,
    total_expected: coerceInt(raw.total_expected),
    total_scanned: coerceInt(raw.total_scanned),
  };
}

function parseMatchedField(raw: unknown): InventoryViewMatchField | null {
  const v = String(raw ?? "").trim();
  if (v === "fnsku" || v === "sku" || v === "tracking_number" || v === "id_slip_contents") {
    return v;
  }
  if (v === "package_code" || v === "order_id" || v === "shipment_id") {
    return "tracking_number";
  }
  return null;
}

function parseMatchType(raw: unknown): ScannerIdentityGateMatchType | null {
  const v = String(raw ?? "").trim();
  if (
    v === "tracking" ||
    v === "package_code" ||
    v === "slip_code" ||
    v === "amazon_order_id" ||
    v === "removal_order_id" ||
    v === "shipment_id" ||
    v === "product_identifier_fallback"
  ) {
    return v;
  }
  return null;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
}

/**
 * Phase 9D — single server-side identity gate (one PostgREST round trip).
 * Returns null when RPC is unavailable so callers can fall back to multi-query path.
 */
export async function fetchIdentityGateViaRpc(
  supabase: SupabaseClient,
  organizationId: string,
  storeId: string,
  rawCode: string,
): Promise<ScannerIdentityGateRpcResult | null> {
  const code = String(rawCode ?? "").trim();
  const orgId = organizationId.trim();
  const sid = storeId.trim();
  if (!code || !orgId || !sid) {
    return {
      rows: [],
      matchedField: null,
      matchType: null,
      packageIds: [],
      trackingNumbers: [],
      scrubApplied: true,
    };
  }

  const { data, error } = await supabase.rpc("scanner_identity_gate_lookup", {
    p_organization_id: orgId,
    p_store_id: sid,
    p_code: code,
  });

  if (error) {
    if (isMissingRpcError(error)) return null;
    throw error;
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.ok === false) return null;

  const rowsRaw = payload.rows;
  const rows: VInventoryStatusRow[] = [];
  if (Array.isArray(rowsRaw)) {
    for (const item of rowsRaw) {
      if (item && typeof item === "object") {
        rows.push(mapRpcRow(item as Record<string, unknown>, orgId, sid));
      }
    }
  }

  return {
    rows,
    matchedField: parseMatchedField(payload.matched_field),
    matchType: parseMatchType(payload.match_type),
    packageIds: parseStringArray(payload.package_ids),
    trackingNumbers: parseStringArray(payload.tracking_numbers),
    scrubApplied: payload.scrub_applied !== false,
  };
}

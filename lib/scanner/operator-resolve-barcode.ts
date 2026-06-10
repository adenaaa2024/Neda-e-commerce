import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchExpectedPackagesForTracking,
  type FetchExpectedPackagesOptions,
} from "./operator-tracking-expectations";
import { findPalletByTrackingNormalized } from "./operator-pallet-tracking";
import { normalizeTrackingKey } from "./tracking-normalize";

/**
 * Resolution order: **Tracking → Package → Slip → Pallet → Item**
 * - package_barcode → `packages.package_code` (or `packages.id_slip_contents` for printed S… ids)
 * - slip (packing / RMA slip) → `packages.rma_number`
 * - pallet_barcode → `pallets.pallet_number`
 */
export type OperatorResolveKind = "tracking" | "package" | "slip" | "pallet" | "item";

export type OperatorResolveMatchedField = "sku" | "barcode" | "fnsku" | "asin" | "upc_code";

export type OperatorResolveResult =
  | { kind: "tracking"; row: Record<string, unknown> }
  | { kind: "package"; row: Record<string, unknown> }
  | { kind: "slip"; row: Record<string, unknown> }
  | { kind: "pallet"; row: Record<string, unknown> }
  | { kind: "item"; row: Record<string, unknown>; matchedField: OperatorResolveMatchedField }
  | { kind: "unknown"; code: string };

export type ResolveOptions = {
  only?: OperatorResolveKind;
  /** Required for tracking resolution against `expected_packages` (scoped by store). */
  storeId?: string | null;
  /** Forwarded to `fetchExpectedPackagesForTracking` (fast not-found skip for tracking codes). */
  fetchOptions?: FetchExpectedPackagesOptions;
};

function norm(s: string) {
  return s.trim();
}

function eqCi(a: unknown, b: string) {
  return String(a ?? "").trim().toLowerCase() === b.toLowerCase();
}

function detectProductMatchField(row: Record<string, unknown>, code: string): OperatorResolveMatchedField {
  if (eqCi(row.sku, code)) return "sku";
  if (eqCi(row.barcode, code)) return "barcode";
  if (eqCi(row.fnsku, code)) return "fnsku";
  if (eqCi(row.asin, code)) return "asin";
  return "sku";
}

/** Offline / demo resolver when Supabase is not configured. */
export function mockResolveOperatorBarcode(raw: string, only?: OperatorResolveKind): OperatorResolveResult {
  const code = norm(raw);
  if (!code) return { kind: "unknown", code: "" };

  if (only === "pallet") {
    return { kind: "pallet", row: { id: "demo-pallet", pallet_number: code, organization_id: null } };
  }
  if (only === "tracking") {
    return { kind: "tracking", row: { id: "demo-ep", tracking_number: code, order_id: "DEMO-ORDER", sku: "DEMO-SKU" } };
  }
  if (only === "package") {
    return { kind: "package", row: { id: "demo-pkg", package_code: code, tracking_number: null, pallet_id: null } };
  }
  if (only === "slip") {
    return { kind: "slip", row: { id: "demo-slip-pkg", package_code: "PKG-DEMO", rma_number: code, pallet_id: null } };
  }
  if (only === "item") {
    return { kind: "item", row: { id: "demo-item", sku: code, product_name: "Demo product" }, matchedField: "sku" };
  }

  const u = code.toUpperCase();
  if (u.startsWith("1Z") || u.startsWith("TRACK") || u.startsWith("TN-")) {
    return {
      kind: "tracking",
      row: { id: "demo-ep", tracking_number: code, order_id: "DEMO-ORDER", sku: "DEMO-SKU" },
    };
  }
  if (u.startsWith("BOX") || u.startsWith("PKG")) {
    return {
      kind: "package",
      row: { id: "demo-pkg", package_code: code, tracking_number: null, pallet_id: null },
    };
  }
  if (u.startsWith("SLIP") || u.startsWith("RMA")) {
    return {
      kind: "slip",
      row: { id: "demo-slip-pkg", package_code: "PKG-SLIP-DEMO", rma_number: code, pallet_id: null },
    };
  }
  if (u.startsWith("PLT")) {
    return { kind: "pallet", row: { id: "demo-pallet", pallet_number: code, organization_id: null } };
  }
  if (u.startsWith("B0") && u.length >= 8) {
    return { kind: "item", row: { id: "demo-asin", sku: "DEMO-SKU", asin: code }, matchedField: "asin" };
  }
  if (u.includes("SKU") || /^[A-Z]{2,}-\d+/i.test(code)) {
    return { kind: "item", row: { id: "demo-sku", sku: code, product_name: "Demo product" }, matchedField: "sku" };
  }
  return { kind: "unknown", code };
}

async function firstPackageByColumn(
  supabase: SupabaseClient,
  organizationId: string,
  column: "package_code" | "id_slip_contents" | "tracking_number",
  code: string,
) {
  const { data, error } = await supabase
    .from("packages")
    .select("id, organization_id, pallet_id, package_code, id_slip_contents, tracking_number, rma_number, expected_item_count, actual_item_count, status")
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .ilike(column, code)
    .limit(1);
  if (error) throw error;
  return data?.[0] as Record<string, unknown> | undefined;
}

import { findFirstPackageByTrackingNormalized } from "@/lib/scanner/package-tracking-lookup";

async function firstProductByIdentifier(supabase: SupabaseClient, organizationId: string, code: string) {
  const cols = ["sku", "barcode", "fnsku", "asin"] as const;
  for (const col of cols) {
    const { data, error } = await supabase
      .from("products")
      .select("id, organization_id, store_id, sku, product_name, barcode, fnsku, asin")
      .eq("organization_id", organizationId)
      .ilike(col, code)
      .limit(1);
    if (error) throw error;
    if (data?.length) {
      const row = data[0] as Record<string, unknown>;
      return { kind: "item" as const, row, matchedField: detectProductMatchField(row, code) };
    }
  }
  return null;
}

export async function resolveOperatorBarcode(
  supabase: SupabaseClient,
  organizationId: string,
  raw: string,
  options?: ResolveOptions,
): Promise<OperatorResolveResult> {
  const code = norm(raw);
  if (!code) return { kind: "unknown", code: "" };

  const only = options?.only;
  const storeId = options?.storeId ?? null;

  const runTracking = async (): Promise<OperatorResolveResult | null> => {
    if (!storeId) return null;
    const rows = await fetchExpectedPackagesForTracking(
      supabase,
      organizationId,
      storeId,
      code,
      undefined,
      options?.fetchOptions,
    );
    if (rows?.length) return { kind: "tracking", row: rows[0] as Record<string, unknown> };
    return null;
  };

  const runPackage = async (): Promise<OperatorResolveResult | null> => {
    const byPkg = await firstPackageByColumn(supabase, organizationId, "package_code", code);
    if (byPkg) return { kind: "package", row: byPkg };
    const bySlip = await firstPackageByColumn(supabase, organizationId, "id_slip_contents", code);
    if (bySlip) return { kind: "package", row: bySlip };
    const byTn = await firstPackageByColumn(supabase, organizationId, "tracking_number", code);
    if (byTn) return { kind: "package", row: byTn };
    const deepSearch = !(
      options?.fetchOptions?.skipExpensiveFallback || options?.fetchOptions?.gateFastNegative
    );
    const byTnNorm = await findFirstPackageByTrackingNormalized(supabase, organizationId, storeId, code, {
      deepSearch,
    });
    if (byTnNorm) return { kind: "package", row: byTnNorm };
    return null;
  };

  /** Packing slip / RMA slip barcode on the physical package row */
  const runSlip = async (): Promise<OperatorResolveResult | null> => {
    const { data, error } = await supabase
      .from("packages")
      .select("id, organization_id, pallet_id, package_code, id_slip_contents, tracking_number, rma_number, expected_item_count, actual_item_count, status")
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .ilike("rma_number", code)
      .limit(1);
    if (error) throw error;
    if (data?.length) return { kind: "slip", row: data[0] as Record<string, unknown> };
    return null;
  };

  const runPallet = async (): Promise<OperatorResolveResult | null> => {
    const { data, error } = await supabase
      .from("pallets")
      .select(
        "id, organization_id, pallet_number, status, item_count, tracking_number, carrier_name, order_id",
      )
      .eq("organization_id", organizationId)
      .is("deleted_at", null)
      .ilike("pallet_number", code)
      .limit(1);
    if (error) throw error;
    if (data?.length) return { kind: "pallet", row: data[0] as Record<string, unknown> };
    return null;
  };

  /** Receiving pallet already created for this carrier tracking (off-manifest or prior session). */
  const runPalletByInboundTracking = async (): Promise<OperatorResolveResult | null> => {
    const row = await findPalletByTrackingNormalized(supabase, organizationId, code);
    if (!row) return null;
    return {
      kind: "pallet",
      row: {
        id: row.id,
        organization_id: row.organization_id,
        pallet_number: row.pallet_number,
        status: row.status,
        item_count: row.item_count,
        tracking_number: row.tracking_number,
        carrier_name: row.carrier_name,
        order_id: row.order_id,
      },
    };
  };

  const runItem = async (): Promise<OperatorResolveResult | null> => {
    const prod = await firstProductByIdentifier(supabase, organizationId, code);
    if (prod) return prod;

    const { data: mapRows, error: mErr } = await supabase
      .from("product_identifier_map")
      .select("product_id, upc_code, organization_id, store_id")
      .eq("organization_id", organizationId)
      .ilike("upc_code", code)
      .limit(1);
    if (mErr) return null;
    if (!mapRows?.length) return null;
    const map = mapRows[0] as Record<string, unknown>;
    const pid = map.product_id as string | undefined;
    if (!pid) return null;
    const { data: pr, error: prErr } = await supabase
      .from("products")
      .select("id, organization_id, store_id, sku, product_name, barcode, fnsku, asin")
      .eq("id", pid)
      .limit(1);
    if (prErr) throw prErr;
    if (pr?.length) return { kind: "item", row: pr[0] as Record<string, unknown>, matchedField: "upc_code" };
    return null;
  };

  if (only === "tracking") {
    return (await runTracking()) ?? (await runPalletByInboundTracking()) ?? { kind: "unknown", code };
  }
  if (only === "package") return (await runPackage()) ?? { kind: "unknown", code };
  if (only === "slip") return (await runSlip()) ?? { kind: "unknown", code };
  if (only === "pallet") {
    return (await runPalletByInboundTracking()) ?? (await runPallet()) ?? { kind: "unknown", code };
  }
  if (only === "item") return (await runItem()) ?? { kind: "unknown", code };

  return (await runTracking())
    ?? (await runPackage())
    ?? (await runPalletByInboundTracking())
    ?? (await runSlip())
    ?? (await runPallet())
    ?? (await runItem())
    ?? { kind: "unknown", code };
}

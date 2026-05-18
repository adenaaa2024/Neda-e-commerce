import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ExpectedItem } from "../app/returns/returns-action-types";
import { resolveScannerProductIdentifiers } from "./scanner-product-resolve";

export type SlipContentsResolverPatch = {
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
};

const SLIP_ROW_SELECT =
  "id, organization_id, store_id, package_id, fnsku, upc, slip_code, resolved_product_id, identifier_resolution_status";

function readStr(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Patch resolver columns on one slip_contents row (no product creation). */
export async function patchSlipContentResolverColumns(
  supabase: SupabaseClient,
  organizationId: string,
  slipRowId: string,
  patch: SlipContentsResolverPatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("slip_contents")
    .update(patch)
    .eq("id", slipRowId)
    .eq("organization_id", organizationId);

  if (error) {
    if (error.code === "42P01" || error.message.includes("slip_contents")) {
      return { ok: false, error: "slip_contents table not available in this environment." };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/** Resolve identifiers for one slip row and persist resolver columns only. */
export async function resolveAndPatchSlipContentRow(
  supabase: SupabaseClient,
  organizationId: string,
  slipRow: Record<string, unknown>,
  storeId: string | null,
): Promise<{ ok: true; patched: boolean } | { ok: false; error: string }> {
  const id = readStr(slipRow, "id");
  if (!id) return { ok: false, error: "slip row missing id" };

  const legacyProductId = readStr(slipRow, "product_id");
  const res = await resolveScannerProductIdentifiers(supabase, {
    organizationId,
    storeId,
    sku: readStr(slipRow, "sku", "seller_sku"),
    asin: readStr(slipRow, "asin"),
    fnsku: readStr(slipRow, "fnsku"),
    legacyProductId,
  });

  const patchRes = await patchSlipContentResolverColumns(supabase, organizationId, id, {
    resolved_product_id: res.resolved_product_id,
    resolved_catalog_product_id: res.resolved_catalog_product_id,
    identifier_resolution_status: res.identifier_resolution_status,
    identifier_resolution_confidence: res.identifier_resolution_confidence,
  });
  if (!patchRes.ok) return patchRes;
  return { ok: true, patched: true };
}

/**
 * When slip_contents rows exist for a package, align resolver columns with manifest lines
 * (same store + identifiers). Does not insert slip rows or create products.
 */
export async function syncSlipContentsResolverForPackage(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    packageId: string;
    storeId: string | null;
    manifestLines?: ExpectedItem[] | null;
  },
): Promise<{ ok: true; rows_patched: number; rows_seen: number } | { ok: false; error: string }> {
  const { data: slips, error } = await supabase
    .from("slip_contents")
    .select(SLIP_ROW_SELECT)
    .eq("organization_id", args.organizationId)
    .eq("package_id", args.packageId)
    .limit(500);

  if (error) {
    if (error.code === "42P01") {
      return { ok: true, rows_patched: 0, rows_seen: 0 };
    }
    return { ok: false, error: error.message };
  }

  const rows = (slips ?? []) as Record<string, unknown>[];
  let patched = 0;

  for (const slip of rows) {
    const sku = readStr(slip, "sku", "seller_sku", "upc");
    const asin = readStr(slip, "asin");
    const fnsku = readStr(slip, "fnsku");

    let lineMatch: ExpectedItem | undefined;
    if (args.manifestLines?.length && sku) {
      lineMatch = args.manifestLines.find((l) => l.sku?.trim() === sku);
    }

    const res = await resolveScannerProductIdentifiers(supabase, {
      organizationId: args.organizationId,
      storeId: args.storeId,
      sku: lineMatch?.sku ?? sku,
      asin: lineMatch?.asin ?? asin,
      fnsku: lineMatch?.fnsku ?? fnsku,
      legacyProductId: readStr(slip, "product_id"),
    });

    const id = readStr(slip, "id");
    if (!id) continue;

    const patchRes = await patchSlipContentResolverColumns(supabase, args.organizationId, id, {
      resolved_product_id: res.resolved_product_id,
      resolved_catalog_product_id: res.resolved_catalog_product_id,
      identifier_resolution_status: res.identifier_resolution_status,
      identifier_resolution_confidence: res.identifier_resolution_confidence,
    });
    if (patchRes.ok) patched += 1;
    else return patchRes;
  }

  return { ok: true, rows_patched: patched, rows_seen: rows.length };
}

/** Read-path smoke: select resolver columns (no writes). */
export async function verifySlipContentsResolverReadable(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ ok: true; sample_count: number } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("slip_contents")
    .select("id, resolved_product_id, identifier_resolution_status, identifier_resolution_confidence")
    .eq("organization_id", organizationId)
    .limit(1);

  if (error) {
    if (error.code === "42P01") {
      return { ok: true, sample_count: 0 };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, sample_count: data?.length ?? 0 };
}

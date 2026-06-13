/**
 * Fee-adjusted Amazon payout read-model — SELECT only, no writes.
 * PHASE-AMAZON-FEE-ADJUSTED-REIMBURSEMENT-READMODEL-IMPLEMENT-V1
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadClaimIntakeSettings } from "@/lib/claims/intake/claim-intake-settings";
import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import {
  computeFeeAdjustedMoneyOutput,
  FEE_ADJUSTED_REIMBURSEMENT_FORMULA,
  type FeeComponentKey,
  type FeeSourceCode,
  type PriceSourceCode,
} from "@/lib/fees/amazon-fee-adjusted-reimbursement-estimate-model-v1";

export type FeeAdjustedEstimatePayload = {
  read_only: true;
  no_db_writes: true;
  disclaimer: string;
  generated_at: string;
  product_id: string;
  organization_id: string;
  store_id: string;
  identifiers: { fnsku: string[]; asin: string[]; sku: string[] };
  linkage_status: "resolved" | "ambiguous" | "unresolved";
  product_linkage_resolved: boolean;
  disputed_row_excluded: boolean;
  sale_price_source: PriceSourceCode;
  latest_valid_sale_price: number | null;
  estimated_referral_fee: number | null;
  estimated_fba_fulfillment_fee: number | null;
  estimated_other_fees: number | null;
  estimated_total_amazon_fees: number | null;
  estimated_amazon_payout: number | null;
  internal_cost_loss: number | null;
  unit_cost_basis: number | null;
  unit_cost_source: string | null;
  clean_qty: number | null;
  observed_reimbursement: number | null;
  observed_reimbursement_sources: string[];
  estimated_reimbursement_gap: number | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  confidence_reasons: string[];
  missing_inputs: string[];
  fee_component_sources: Partial<Record<FeeComponentKey, FeeSourceCode>>;
  source_row_counts: {
    product_prices: number;
    amazon_fee_preview: number;
    amazon_settlements: number;
    amazon_reimbursements: number;
    amazon_manage_fba_inventory: number;
    amazon_listing_report_rows_raw: number;
    financial_reference_resolver: number;
    return_items_with_estimate: number;
  };
  is_estimate_not_guaranteed: true;
};

type ProductIdentifiers = { fnsku: string[]; asin: string[]; sku: string[] };
type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function positiveNum(v: unknown): number | null {
  const n = num(v);
  return n != null && n > 0 ? n : null;
}

function rawPrice(raw: unknown, keys: string[]): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  for (const k of keys) {
    const direct = positiveNum(o[k]);
    if (direct != null) return direct;
    const lower = positiveNum(o[k.toLowerCase()]);
    if (lower != null) return lower;
  }
  return null;
}

async function loadIdentifiers(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
): Promise<{ identifiers: ProductIdentifiers; linkage_status: FeeAdjustedEstimatePayload["linkage_status"] }> {
  const fnskuSet = new Set<string>();
  const asinSet = new Set<string>();
  const skuSet = new Set<string>();

  const { data: product } = await client
    .from("products")
    .select("asin, sku, fnsku")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .maybeSingle();

  if (product) {
    const p = product as { asin?: string; sku?: string; fnsku?: string };
    if (p.fnsku?.trim()) fnskuSet.add(p.fnsku.trim().toUpperCase());
    if (p.asin?.trim()) asinSet.add(p.asin.trim().toUpperCase());
    if (p.sku?.trim()) skuSet.add(p.sku.trim());
  }

  const { data: maps } = await client
    .from("product_identifier_map")
    .select("fnsku, asin, seller_sku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId);

  for (const m of maps ?? []) {
    const row = m as { fnsku?: string; asin?: string; seller_sku?: string };
    if (row.fnsku?.trim()) fnskuSet.add(row.fnsku.trim().toUpperCase());
    if (row.asin?.trim()) asinSet.add(row.asin.trim().toUpperCase());
    if (row.seller_sku?.trim()) skuSet.add(row.seller_sku.trim());
  }

  const identifiers: ProductIdentifiers = {
    fnsku: [...fnskuSet],
    asin: [...asinSet],
    sku: [...skuSet],
  };

  if (identifiers.fnsku.length === 0 && identifiers.asin.length === 0 && identifiers.sku.length === 0) {
    return { identifiers, linkage_status: "unresolved" };
  }

  let ambiguous = false;
  for (const f of identifiers.fnsku) {
    const { data: peers } = await client
      .from("product_identifier_map")
      .select("product_id")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .ilike("fnsku", f)
      .limit(5);
    const pids = new Set((peers ?? []).map((r) => String((r as { product_id: string }).product_id)));
    if (pids.size > 1) {
      ambiguous = true;
      break;
    }
  }

  return { identifiers, linkage_status: ambiguous ? "ambiguous" : "resolved" };
}

function buildOrFilter(ids: ProductIdentifiers, skuCol = "sku"): string {
  const parts: string[] = [];
  for (const f of ids.fnsku) parts.push(`fnsku.ilike.${f}`);
  for (const a of ids.asin) parts.push(`asin.ilike.${a}`);
  for (const s of ids.sku) parts.push(`${skuCol}.ilike.${s}`);
  return parts.join(",");
}

async function queryScopedRows(
  client: SupabaseClient,
  table: string,
  select: string,
  organizationId: string,
  storeId: string,
  productId: string,
  ids: ProductIdentifiers,
  opts?: { skuCol?: string; limit?: number },
): Promise<Row[]> {
  const limit = opts?.limit ?? 500;
  const skuCol = opts?.skuCol ?? "sku";

  let byProduct = client
    .from(table)
    .select(select)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("resolved_product_id", productId)
    .limit(limit);
  const { data: resolved } = await byProduct;
  if (resolved?.length) return resolved as unknown as Row[];

  const orFilter = buildOrFilter(ids, skuCol);
  if (!orFilter) return [];

  const { data } = await client
    .from(table)
    .select(select)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .or(orFilter)
    .limit(limit);
  return (data ?? []) as unknown as Row[];
}

async function hasDisputedExpectedPackages(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
  ids: ProductIdentifiers,
): Promise<boolean> {
  const rows = await queryScopedRows(
    client,
    "expected_packages",
    "build_status, expected_scan_quantity",
    organizationId,
    storeId,
    productId,
    ids,
    { limit: 200 },
  );
  for (const r of rows) {
    const split = splitExpectedQuantityByBuildStatus(
      String(r.build_status ?? ""),
      Number(r.expected_scan_quantity ?? 0),
    );
    if (split.disputed > 0 && !isCleanExpectedPackageBuildStatus(String(r.build_status ?? ""))) {
      return true;
    }
  }
  return false;
}

function resolveCogsOverride(
  overrides: Record<string, unknown>,
  ids: ProductIdentifiers,
): { value: number | null; key: string | null } {
  for (const f of ids.fnsku) {
    const v = positiveNum(overrides[f] ?? overrides[f.toLowerCase()]);
    if (v != null) return { value: v, key: `fnsku:${f}` };
  }
  for (const s of ids.sku) {
    const v = positiveNum(overrides[s]);
    if (v != null) return { value: v, key: `sku:${s}` };
  }
  for (const a of ids.asin) {
    const v = positiveNum(overrides[a]);
    if (v != null) return { value: v, key: `asin:${a}` };
  }
  return { value: null, key: null };
}

function extractFeePreviewComponents(row: Row): Partial<Record<FeeComponentKey, { amount: number; source: FeeSourceCode }>> {
  const out: Partial<Record<FeeComponentKey, { amount: number; source: FeeSourceCode }>> = {};
  const raw = row.raw_data;
  const referral = rawPrice(raw, [
    "estimated-referral-fee-per-unit",
    "estimated_referral_fee_per_unit",
    "referral-fee",
  ]);
  const fba = rawPrice(raw, [
    "expected-domestic-fulfilment-fee-per-unit",
    "expected_fulfillment_fee_per_unit",
    "expected-domestic-fulfillment-fee-per-unit",
  ]);
  if (referral != null) {
    out.referral_fee = { amount: referral, source: "fee_preview_report" };
  }
  if (fba != null) {
    out.fba_fulfillment_fee = { amount: fba, source: "fee_preview_report" };
  } else {
    const agg = positiveNum(row.estimated_fee);
    if (agg != null && referral != null && agg > referral) {
      out.fba_fulfillment_fee = { amount: agg - referral, source: "fee_preview_report" };
    } else if (agg != null && referral == null) {
      out.fba_fulfillment_fee = { amount: agg, source: "fee_preview_report" };
    }
  }
  return out;
}

function pickLatestSalePrice(
  settlementRows: Row[],
  priceRows: Row[],
  listingRows: Row[],
  manageRows: Row[],
): { price: number | null; source: PriceSourceCode } {
  let best: { price: number; source: PriceSourceCode; sortKey: string } | null = null;

  for (const r of settlementRows) {
    const p = positiveNum(r.product_sales) ?? rawPrice(r.raw_data, ["product-sales", "product_sales", "Product Sales"]);
    if (p == null) continue;
    const sortKey = String(r.transaction_release_date ?? r.created_at ?? "");
    if (!best || sortKey > best.sortKey) best = { price: p, source: "transaction_sale_price", sortKey };
  }

  for (const r of priceRows) {
    const p = positiveNum(r.amount);
    if (p == null) continue;
    const sortKey = String(r.observed_at ?? r.created_at ?? "");
    if (!best || sortKey > best.sortKey) best = { price: p, source: "product_prices_listing", sortKey };
  }

  for (const r of listingRows) {
    const p = rawPrice(r.raw_payload, ["price", "your-price", "your_price", "listing-price", "listing_price"]);
    if (p == null) continue;
    const sortKey = String(r.created_at ?? "");
    if (!best || sortKey > best.sortKey) best = { price: p, source: "open_listings_price", sortKey };
  }

  for (const r of manageRows) {
    const p = positiveNum(r.price) ?? rawPrice(r.raw_data, ["your-price", "your_price", "sales-price", "price"]);
    if (p == null) continue;
    const sortKey = String(r.created_at ?? "");
    if (!best || sortKey > best.sortKey) best = { price: p, source: "manage_fba_inventory_price", sortKey };
  }

  return best ? { price: best.price, source: best.source } : { price: null, source: "unavailable" };
}

export async function buildFeeAdjustedEstimate(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
): Promise<FeeAdjustedEstimatePayload> {
  const missing_inputs: string[] = [];
  const observed_sources: string[] = [];

  const { identifiers, linkage_status } = await loadIdentifiers(client, organizationId, storeId, productId);
  const product_linkage_resolved = linkage_status === "resolved";
  if (!product_linkage_resolved) {
    missing_inputs.push(
      linkage_status === "ambiguous" ? "product_linkage_ambiguous" : "product_linkage_unresolved",
    );
  }

  const disputed_row_excluded = await hasDisputedExpectedPackages(
    client,
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  if (disputed_row_excluded) missing_inputs.push("disputed_expected_packages_excluded");

  const { data: priceRows } = await client
    .from("product_prices")
    .select("amount, observed_at, created_at")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .order("observed_at", { ascending: false, nullsFirst: false })
    .limit(5);

  const feePreviewRows = await queryScopedRows(
    client,
    "amazon_fee_preview",
    "price, estimated_fee, raw_data, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
    { limit: 5 },
  );
  feePreviewRows.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));

  const settlementRows = await queryScopedRows(
    client,
    "amazon_settlements",
    "product_sales, selling_fees, fba_fees, other_transaction_fees, raw_data, transaction_release_date, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
    { limit: 50 },
  );

  const listingOrParts: string[] = [];
  for (const s of identifiers.sku) listingOrParts.push(`seller_sku.ilike.${s}`);
  for (const a of identifiers.asin) listingOrParts.push(`asin.ilike.${a}`);
  let listingRows: Row[] = [];
  if (listingOrParts.length > 0) {
    const { data } = await client
      .from("amazon_listing_report_rows_raw")
      .select("raw_payload, created_at, seller_sku, asin")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .or(listingOrParts.join(","))
      .order("created_at", { ascending: false })
      .limit(5);
    listingRows = (data ?? []) as unknown as Row[];
  }

  const manageRows = await queryScopedRows(
    client,
    "amazon_manage_fba_inventory",
    "price, raw_data, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
    { limit: 5 },
  );

  const salePick = pickLatestSalePrice(
    settlementRows,
    (priceRows ?? []) as unknown as Row[],
    listingRows,
    manageRows,
  );
  if (salePick.price == null) {
    missing_inputs.push("latest_valid_sale_price");
  }
  if (feePreviewRows[0]?.price && salePick.price == null) {
    const fpPrice = positiveNum(feePreviewRows[0].price);
    if (fpPrice != null) {
      salePick.price = fpPrice;
      salePick.source = "open_listings_price";
    }
  }

  const fee_components: Partial<Record<FeeComponentKey, { amount: number | null; source: FeeSourceCode }>> = {};
  if (feePreviewRows[0]) {
    Object.assign(fee_components, extractFeePreviewComponents(feePreviewRows[0]));
  } else {
    missing_inputs.push("amazon_fee_preview");
  }

  if (!fee_components.referral_fee && settlementRows.length > 0) {
    const latest = [...settlementRows].sort((a, b) =>
      String(b.transaction_release_date ?? b.created_at ?? "").localeCompare(
        String(a.transaction_release_date ?? a.created_at ?? ""),
      ),
    )[0];
    const selling = positiveNum(latest?.selling_fees);
    if (selling != null) {
      fee_components.referral_fee = { amount: Math.abs(selling), source: "settlement_actual" };
    }
  }
  if (!fee_components.fba_fulfillment_fee && settlementRows.length > 0) {
    const latest = [...settlementRows].sort((a, b) =>
      String(b.transaction_release_date ?? b.created_at ?? "").localeCompare(
        String(a.transaction_release_date ?? a.created_at ?? ""),
      ),
    )[0];
    const fba = positiveNum(latest?.fba_fees);
    if (fba != null) {
      fee_components.fba_fulfillment_fee = { amount: Math.abs(fba), source: "settlement_actual" };
    }
  }
  if (!fee_components.referral_fee && !fee_components.fba_fulfillment_fee) {
    missing_inputs.push("estimated_fee_components");
  }

  const reimbRows = await queryScopedRows(
    client,
    "amazon_reimbursements",
    "amount_total",
    organizationId,
    storeId,
    productId,
    identifiers,
    { limit: 500 },
  );
  let observed_reimbursement: number | null = null;
  if (reimbRows.length > 0) {
    const sum = reimbRows.reduce((s, r) => s + (num(r.amount_total) ?? 0), 0);
    observed_reimbursement = sum > 0 ? sum : null;
    if (observed_reimbursement != null) observed_sources.push("amazon_reimbursements");
  } else {
    missing_inputs.push("observed_reimbursement_rows");
  }

  let frrCount = 0;
  try {
    const { data: frrRows } = await client
      .from("financial_reference_resolver")
      .select("amount")
      .eq("organization_id", organizationId)
      .eq("resolved_product_id", productId)
      .limit(100);
    frrCount = frrRows?.length ?? 0;
    if (frrRows?.length && observed_reimbursement == null) {
      const frrSum = frrRows.reduce((s, r) => s + (num((r as { amount?: unknown }).amount) ?? 0), 0);
      if (frrSum > 0) {
        observed_reimbursement = frrSum;
        observed_sources.push("financial_reference_resolver");
      }
    }
  } catch {
    missing_inputs.push("financial_reference_resolver_unavailable");
  }

  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const cogsHit = resolveCogsOverride(settings.cogs_overrides, identifiers);
  let unit_cost_basis: number | null = cogsHit.value;
  let unit_cost_source: string | null = cogsHit.key ? `cogs_overrides:${cogsHit.key}` : null;

  if (unit_cost_basis == null) {
    const { data: riRows } = await client
      .from("return_items")
      .select("estimated_value, created_at")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("resolved_product_id", productId)
      .is("deleted_at", null)
      .not("estimated_value", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const ev = positiveNum((riRows?.[0] as { estimated_value?: unknown } | undefined)?.estimated_value);
    if (ev != null) {
      unit_cost_basis = ev;
      unit_cost_source = "return_items.estimated_value (low-confidence operational fallback)";
      missing_inputs.push("product_cost_snapshots_missing_using_return_estimate");
    } else {
      missing_inputs.push("unit_cost_basis");
    }
  }

  const output = computeFeeAdjustedMoneyOutput({
    product_linkage_resolved,
    disputed_row_excluded,
    clean_qty: 1,
    unit_cost_basis,
    latest_valid_sale_price: salePick.price,
    latest_valid_sale_price_source: salePick.source,
    fee_components,
    observed_reimbursement,
  });

  if (output.estimated_amazon_payout == null && salePick.price != null) {
    missing_inputs.push("estimated_amazon_payout_requires_fee_components");
  }

  const fee_component_sources = Object.fromEntries(
    Object.entries(fee_components).map(([k, v]) => [k, v?.source ?? "unavailable"]),
  ) as Partial<Record<FeeComponentKey, FeeSourceCode>>;

  return {
    read_only: true,
    no_db_writes: true,
    disclaimer: FEE_ADJUSTED_REIMBURSEMENT_FORMULA.disclaimer,
    generated_at: new Date().toISOString(),
    product_id: productId,
    organization_id: organizationId,
    store_id: storeId,
    identifiers,
    linkage_status,
    product_linkage_resolved,
    disputed_row_excluded,
    sale_price_source: output.latest_valid_sale_price_source,
    latest_valid_sale_price: output.latest_valid_sale_price,
    estimated_referral_fee: output.estimated_referral_fee,
    estimated_fba_fulfillment_fee: output.estimated_fba_fulfillment_fee,
    estimated_other_fees: output.estimated_other_fees,
    estimated_total_amazon_fees: output.estimated_total_amazon_fees,
    estimated_amazon_payout: output.estimated_amazon_payout,
    internal_cost_loss: output.internal_cost_loss,
    unit_cost_basis: output.unit_cost_basis,
    unit_cost_source,
    clean_qty: output.clean_qty,
    observed_reimbursement: output.observed_reimbursement,
    observed_reimbursement_sources: observed_sources,
    estimated_reimbursement_gap: output.estimated_reimbursement_gap,
    confidence: output.confidence,
    confidence_reasons: [...output.confidence_reasons, ...missing_inputs.filter((m) => m.startsWith("product_cost"))],
    missing_inputs,
    fee_component_sources,
    source_row_counts: {
      product_prices: priceRows?.length ?? 0,
      amazon_fee_preview: feePreviewRows.length,
      amazon_settlements: settlementRows.length,
      amazon_reimbursements: reimbRows.length,
      amazon_manage_fba_inventory: manageRows.length,
      amazon_listing_report_rows_raw: listingRows.length,
      financial_reference_resolver: frrCount,
      return_items_with_estimate: unit_cost_source?.includes("return_items") ? 1 : 0,
    },
    is_estimate_not_guaranteed: true,
  };
}

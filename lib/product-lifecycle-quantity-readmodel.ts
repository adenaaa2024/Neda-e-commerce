/**
 * Product Amazon lifecycle quantity read-model — SELECT only, no writes.
 * PHASE-PRODUCT-AMAZON-LIFECYCLE-QUANTITY-READMODEL-IMPLEMENT-V1
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import {
  classifyAllRemovalDetailRows,
  type RemovalDetailRowLike,
} from "@/lib/claims/removal/removal-source-supersession-readmodel";
import {
  LIFECYCLE_STATE_KEYS,
  LIFECYCLE_STATE_LABELS,
  type LifecycleConfidence,
  type LifecycleFreshness,
  type LifecycleSourceType,
  type LifecycleStateCounter,
  type LifecycleStateKey,
} from "@/lib/product-lifecycle-quantity-contract";

const STALE_DAYS = 45;

export type ProductLifecycleQuantitiesPayload = {
  read_only: true;
  no_db_writes: true;
  generated_at: string;
  product_id: string;
  organization_id: string;
  store_id: string;
  linkage_status: "resolved" | "ambiguous" | "unresolved";
  identifiers: { fnsku: string[]; asin: string[]; sku: string[] };
  states: LifecycleStateCounter[];
  disputed_bucket: {
    label: string;
    quantity: number;
    excluded_reasons: string[];
  };
  money_lanes: {
    sale_context: string | null;
    actual_cost: "unknown" | "partial";
    actual_cost_note: string;
    observed_reimbursement_amount: number | null;
    observed_reimbursement_note: string;
  };
  product_story_integration_notes: string;
  primary_total_rules: string[];
};

type ProductIdentifiers = {
  fnsku: string[];
  asin: string[];
  sku: string[];
};

type Row = Record<string, unknown>;

function qty(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function sumField(rows: Row[], field: string): number {
  return rows.reduce((s, r) => s + qty(r[field]), 0);
}

function maxDate(rows: Row[], ...fields: string[]): string | null {
  let best: string | null = null;
  for (const r of rows) {
    for (const f of fields) {
      const v = r[f];
      if (v == null) continue;
      const s = String(v);
      if (!best || s > best) best = s;
    }
  }
  return best;
}

function freshnessFromDate(lastAt: string | null, hasRows: boolean): LifecycleFreshness {
  if (!hasRows) return "missing";
  if (!lastAt) return "unknown";
  const ms = Date.now() - new Date(lastAt).getTime();
  if (Number.isNaN(ms)) return "unknown";
  return ms > STALE_DAYS * 86_400_000 ? "stale" : "fresh";
}

function counterBase(
  stateKey: LifecycleStateKey,
  overrides: Partial<LifecycleStateCounter> & Pick<LifecycleStateCounter, "source_type">,
): LifecycleStateCounter {
  return {
    state_key: stateKey,
    label: LIFECYCLE_STATE_LABELS[stateKey],
    quantity: null,
    quantity_display: "Source unavailable",
    amount: null,
    amount_display: null,
    as_of: null,
    source_table: null,
    confidence: "unavailable",
    freshness: "missing",
    claim_candidate_capable: "no",
    blocker_reason: null,
    disputed_quantity: null,
    excluded_from_primary_reason: null,
    ...overrides,
  };
}

function withQuantity(
  stateKey: LifecycleStateKey,
  quantity: number,
  opts: {
    source_table: string;
    source_type: LifecycleSourceType;
    as_of?: string | null;
    confidence?: LifecycleConfidence;
    freshness?: LifecycleFreshness;
    claim_candidate_capable?: "yes" | "no" | "partial";
    blocker_reason?: string | null;
    disputed_quantity?: number | null;
    excluded_from_primary_reason?: string | null;
    amount?: number | null;
    amount_display?: string | null;
  },
): LifecycleStateCounter {
  return counterBase(stateKey, {
    quantity,
    quantity_display: String(quantity),
    source_table: opts.source_table,
    source_type: opts.source_type,
    as_of: opts.as_of ?? null,
    confidence: opts.confidence ?? "medium",
    freshness: opts.freshness ?? "unknown",
    claim_candidate_capable: opts.claim_candidate_capable ?? "no",
    blocker_reason: opts.blocker_reason ?? null,
    disputed_quantity: opts.disputed_quantity ?? null,
    excluded_from_primary_reason: opts.excluded_from_primary_reason ?? null,
    amount: opts.amount ?? null,
    amount_display: opts.amount_display ?? null,
  });
}

function unavailable(
  stateKey: LifecycleStateKey,
  reason: string,
  source_table: string | null = null,
  source_type: LifecycleSourceType = "file",
): LifecycleStateCounter {
  return counterBase(stateKey, {
    source_table,
    source_type,
    blocker_reason: reason,
    quantity_display: "Source unavailable",
  });
}

async function loadIdentifiers(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
): Promise<{ identifiers: ProductIdentifiers; linkage_status: ProductLifecycleQuantitiesPayload["linkage_status"] }> {
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
    .eq("product_id", productId)
    .is("deleted_at", null);

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
      .is("deleted_at", null);
    const pids = new Set((peers ?? []).map((r) => String((r as { product_id: string }).product_id)));
    if (pids.size > 1) {
      ambiguous = true;
      break;
    }
  }

  return { identifiers, linkage_status: ambiguous ? "ambiguous" : "resolved" };
}

function buildOrFilter(ids: ProductIdentifiers, cols: { fnsku?: boolean; asin?: boolean; sku?: string }): string {
  const parts: string[] = [];
  const skuCol = cols.sku ?? "sku";
  if (cols.fnsku !== false) {
    for (const f of ids.fnsku) parts.push(`fnsku.ilike.${f}`);
  }
  if (cols.asin !== false) {
    for (const a of ids.asin) parts.push(`asin.ilike.${a}`);
  }
  for (const s of ids.sku) parts.push(`${skuCol}.ilike.${s}`);
  return parts.join(",");
}

async function queryScopedRows(
  client: SupabaseClient,
  table: string,
  select: string,
  organizationId: string,
  storeId: string | null,
  productId: string,
  ids: ProductIdentifiers,
  opts?: { storeScoped?: boolean; idColumns?: { fnsku?: boolean; asin?: boolean; sku?: string }; limit?: number },
): Promise<Row[]> {
  const storeScoped = opts?.storeScoped !== false;
  const limit = opts?.limit ?? 5000;

  let byProduct = client
    .from(table)
    .select(select)
    .eq("organization_id", organizationId)
    .eq("resolved_product_id", productId)
    .limit(limit);
  if (storeScoped && storeId) byProduct = byProduct.eq("store_id", storeId);
  const { data: resolved } = await byProduct;
  if (resolved?.length) return resolved as unknown as Row[];

  const orFilter = buildOrFilter(ids, opts?.idColumns ?? {});
  if (!orFilter) return [];

  let q = client.from(table).select(select).eq("organization_id", organizationId).or(orFilter).limit(limit);
  if (storeScoped && storeId) q = q.eq("store_id", storeId);
  const { data } = await q;
  return (data ?? []) as unknown as Row[];
}

async function buildRemovedShippedState(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
  ids: ProductIdentifiers,
): Promise<{ state: LifecycleStateCounter; disputedQty: number; excludedReasons: string[] }> {
  const shipments = await queryScopedRows(
    client,
    "amazon_removal_shipments",
    "id, shipped_quantity, shipment_date, created_at, tracking_number, fnsku",
    organizationId,
    storeId,
    productId,
    ids,
  );

  const epRows = await queryScopedRows(
    client,
    "expected_packages",
    "id, expected_scan_quantity, build_status, created_at, tracking_number, fnsku",
    organizationId,
    storeId,
    productId,
    ids,
  );

  let cleanEp = 0;
  let disputedEp = 0;
  const excludedReasons: string[] = [];
  for (const r of epRows) {
    const split = splitExpectedQuantityByBuildStatus(
      String(r.build_status ?? ""),
      qty(r.expected_scan_quantity),
    );
    cleanEp += split.clean;
    disputedEp += split.disputed;
    if (split.disputed > 0 && !isCleanExpectedPackageBuildStatus(String(r.build_status ?? ""))) {
      excludedReasons.push(`expected_packages:${String(r.id ?? "")}:build_status=${String(r.build_status ?? "")}`);
    }
  }

  const shipmentQty = sumField(shipments, "shipped_quantity");
  const primaryQty = shipmentQty > 0 ? shipmentQty : cleanEp;
  const asOf = maxDate(shipments, "shipment_date", "created_at") ?? maxDate(epRows, "created_at");
  const freshness = freshnessFromDate(asOf, shipments.length > 0 || epRows.length > 0);

  let confidence: LifecycleConfidence = "high";
  if (disputedEp > 0) confidence = "disputed";
  else if (shipments.length === 0 && epRows.length === 0) confidence = "unavailable";

  const state = withQuantity("removed_shipped", primaryQty, {
    source_table: shipmentQty > 0 ? "amazon_removal_shipments" : "expected_packages",
    source_type: "api",
    as_of: asOf,
    confidence,
    freshness,
    claim_candidate_capable: disputedEp > 0 ? "partial" : primaryQty > 0 ? "yes" : "no",
    disputed_quantity: disputedEp > 0 ? disputedEp : null,
    excluded_from_primary_reason:
      disputedEp > 0 ? "Disputed expected_packages rows excluded from primary total" : null,
    blocker_reason: primaryQty === 0 && disputedEp === 0 ? "no_removal_shipment_rows" : null,
  });

  return { state, disputedQty: disputedEp, excludedReasons };
}

async function buildRemovedCreatedState(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
  ids: ProductIdentifiers,
): Promise<LifecycleStateCounter> {
  const rows = await queryScopedRows(
    client,
    "amazon_removals",
    "id, requested_quantity, shipped_quantity, in_process_quantity, order_date, created_at, upload_id, order_id, sku, fnsku, disposition, order_type, organization_id, store_id",
    organizationId,
    storeId,
    productId,
    ids,
  );

  if (rows.length === 0) {
    return unavailable("removed_created", "no_removal_order_rows", "amazon_removals", "api");
  }

  const uploadIds = [...new Set(rows.map((r) => r.upload_id).filter(Boolean))] as string[];
  const uploadAt = new Map<string, string>();
  if (uploadIds.length > 0) {
    const { data: uploads } = await client
      .from("raw_report_uploads")
      .select("id, created_at")
      .in("id", uploadIds.slice(0, 200));
    for (const u of uploads ?? []) {
      uploadAt.set(String((u as { id: string }).id), String((u as { created_at: string }).created_at));
    }
  }

  const detailRows: RemovalDetailRowLike[] = rows.map((r) => ({
    id: String(r.id ?? ""),
    organization_id: organizationId,
    store_id: storeId,
    order_id: r.order_id != null ? String(r.order_id) : null,
    sku: r.sku != null ? String(r.sku) : null,
    fnsku: r.fnsku != null ? String(r.fnsku) : null,
    disposition: r.disposition != null ? String(r.disposition) : null,
    order_type: r.order_type != null ? String(r.order_type) : null,
    shipped_quantity: r.shipped_quantity != null ? qty(r.shipped_quantity) : null,
    in_process_quantity: r.in_process_quantity != null ? qty(r.in_process_quantity) : null,
    requested_quantity: r.requested_quantity != null ? qty(r.requested_quantity) : null,
    upload_id: r.upload_id != null ? String(r.upload_id) : null,
    created_at: r.created_at != null ? String(r.created_at) : null,
    upload_created_at: uploadAt.get(String(r.upload_id ?? "")) ?? null,
  }));

  const classified = classifyAllRemovalDetailRows(detailRows);
  const currentRows = classified.filter((r) => r.supersession_class === "current" && !r.is_partial_snapshot);
  const supersededQty = classified
    .filter((r) => r.supersession_class === "superseded_stale_partial")
    .reduce((s, r) => s + qty(r.requested_quantity ?? r.shipped_quantity), 0);

  const primaryQty = currentRows.reduce((s, r) => s + qty(r.requested_quantity ?? r.shipped_quantity), 0);
  const asOf = maxDate(rows, "order_date", "created_at");

  return withQuantity("removed_created", primaryQty, {
    source_table: "amazon_removals",
    source_type: "api",
    as_of: asOf,
    confidence: supersededQty > 0 ? "medium" : "high",
    freshness: freshnessFromDate(asOf, rows.length > 0),
    claim_candidate_capable: "yes",
    disputed_quantity: supersededQty > 0 ? supersededQty : null,
    excluded_from_primary_reason:
      supersededQty > 0 ? "superseded_stale_partial removal detail rows excluded" : null,
  });
}

async function buildSnapshotState(
  stateKey: "available_fba" | "reserved_fba",
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
  ids: ProductIdentifiers,
): Promise<LifecycleStateCounter> {
  const field = stateKey === "available_fba" ? "available" : "total_reserved_quantity";
  const tables = ["amazon_fba_inventory", "amazon_manage_fba_inventory"] as const;

  for (const table of tables) {
    const rows = await queryScopedRows(
      client,
      table,
      `snapshot_date, ${field}, created_at, updated_at`,
      organizationId,
      storeId,
      productId,
      ids,
    );
    if (rows.length === 0) continue;
    rows.sort((a, b) => String(b.snapshot_date ?? b.updated_at ?? "").localeCompare(String(a.snapshot_date ?? a.updated_at ?? "")));
    const latest = rows[0]!;
    const quantity = qty(latest[field]);
    const asOf = String(latest.snapshot_date ?? latest.updated_at ?? latest.created_at ?? "");
    return withQuantity(stateKey, quantity, {
      source_table: table,
      source_type: "file",
      as_of: asOf || null,
      confidence: "high",
      freshness: freshnessFromDate(asOf || null, true),
      claim_candidate_capable: "no",
    });
  }

  return unavailable(stateKey, "no_fba_inventory_snapshot", "amazon_fba_inventory", "file");
}

export async function buildProductLifecycleQuantities(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string,
): Promise<ProductLifecycleQuantitiesPayload> {
  const generatedAt = new Date().toISOString();
  const { identifiers, linkage_status } = await loadIdentifiers(client, organizationId, storeId, productId);

  const linkageBlocker =
    linkage_status === "unresolved"
      ? "unresolved_product_identifiers"
      : linkage_status === "ambiguous"
        ? "ambiguous_product_identifier_map"
        : null;

  const excludedReasons: string[] = [];
  let totalDisputed = 0;

  const inboundRows = await queryScopedRows(
    client,
    "amazon_inbound_performance",
    "expected_quantity, received_quantity, shipment_creation_date, issue_reported_date, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
  );

  const sentQty = sumField(inboundRows, "expected_quantity");
  const receivedQty = sumField(inboundRows, "received_quantity");
  const inboundAsOf = maxDate(inboundRows, "shipment_creation_date", "issue_reported_date", "created_at");
  const inboundFresh = freshnessFromDate(inboundAsOf, inboundRows.length > 0);

  const returnItems = await client
    .from("return_items")
    .select("id, created_at, conditions, product_id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .is("deleted_at", null)
    .limit(5000);
  const warehouseRows = (returnItems.data ?? []) as Row[];
  const warehouseQty = warehouseRows.length;

  const amazonReturns = await queryScopedRows(
    client,
    "amazon_returns",
    "id, return_date, created_at, disposition",
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  const customerReturnQty = amazonReturns.length > 0 ? amazonReturns.length : 0;

  const settlements = await queryScopedRows(
    client,
    "amazon_settlements",
    "quantity, amount, posted_date, created_at, amount_type, transaction_type",
    organizationId,
    storeId,
    productId,
    identifiers,
    { idColumns: { sku: "sku" } },
  );
  let soldQty = 0;
  let refundQty = 0;
  for (const r of settlements) {
    const q = qty(r.quantity);
    const tt = String(r.transaction_type ?? r.amount_type ?? "").toLowerCase();
    if (tt.includes("refund") || tt.includes("cancel") || Number(r.amount ?? 0) < 0) refundQty += Math.abs(q || 1);
    else if (q > 0) soldQty += q;
  }

  const ledgerRows = await queryScopedRows(
    client,
    "amazon_inventory_ledger",
    "quantity, unreconciled_quantity, event_date, created_at, event_type, reason_code, disposition",
    organizationId,
    null,
    productId,
    identifiers,
    { storeScoped: false },
  );

  let lostQty = 0;
  let disposedLedgerQty = 0;
  for (const r of ledgerRows) {
    const reason = String(r.reason_code ?? r.event_type ?? "").toLowerCase();
    const unrec = qty(r.unreconciled_quantity);
    if (unrec > 0 && (reason.includes("m") || reason.includes("lost") || reason.includes("adjust"))) {
      lostQty += unrec;
    }
    if (reason.includes("dispose") || String(r.disposition ?? "").toLowerCase().includes("dispose")) {
      disposedLedgerQty += Math.abs(qty(r.quantity));
    }
  }

  const removalDisposed = await queryScopedRows(
    client,
    "amazon_removals",
    "disposed_quantity, order_date, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  const disposedQty = sumField(removalDisposed, "disposed_quantity") + disposedLedgerQty;

  const damagedScanner = warehouseRows.filter((r) =>
    String(r.conditions ?? "")
      .toLowerCase()
      .includes("damage"),
  ).length;
  const damagedReturns = amazonReturns.filter((r) =>
    String(r.disposition ?? "")
      .toLowerCase()
      .includes("damage"),
  ).length;

  const expiredScanner = warehouseRows.filter((r) =>
    String(r.conditions ?? "")
      .toLowerCase()
      .includes("expir"),
  ).length;

  const fbaRows = await queryScopedRows(
    client,
    "amazon_fba_inventory",
    "inv_age_366_to_455_days, inv_age_456_plus_days, snapshot_date, alert, recommended_action, estimated_excess_quantity",
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  fbaRows.sort((a, b) => String(b.snapshot_date ?? "").localeCompare(String(a.snapshot_date ?? "")));
  const latestFba = fbaRows[0];
  const ageProxy =
    latestFba != null
      ? qty(latestFba.inv_age_456_plus_days) + qty(latestFba.inv_age_366_to_455_days)
      : 0;

  const reimbRows = await queryScopedRows(
    client,
    "amazon_reimbursements",
    "quantity_reimbursed_total, amount_total, approval_date, created_at",
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  const reimbursedQty = sumField(reimbRows, "quantity_reimbursed_total");
  const reimbursedAmount = reimbRows.reduce((s, r) => s + Number(r.amount_total ?? 0), 0);

  const { count: safetCount } = await client
    .from("amazon_safet_claims")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);

  const { count: feePreviewCount } = await client
    .from("amazon_fee_preview")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);

  const { count: storageFeeCount } = await client
    .from("amazon_monthly_storage_fees")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId);

  const { data: prices } = await client
    .from("product_prices")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .limit(1);

  const removedShipped = await buildRemovedShippedState(client, organizationId, storeId, productId, identifiers);
  const removedCreated = await buildRemovedCreatedState(client, organizationId, storeId, productId, identifiers);
  totalDisputed += removedShipped.disputedQty;
  excludedReasons.push(...removedShipped.excludedReasons);

  const availableFba = await buildSnapshotState(
    "available_fba",
    client,
    organizationId,
    storeId,
    productId,
    identifiers,
  );
  const reservedFba = await buildSnapshotState(
    "reserved_fba",
    client,
    organizationId,
    storeId,
    productId,
    identifiers,
  );

  let unreimbursedState: LifecycleStateCounter;
  if ((safetCount ?? 0) === 0 && lostQty === 0 && disposedQty === 0) {
    unreimbursedState = unavailable(
      "unreimbursed_gap",
      "amazon_safet_claims empty — SAFE-T unavailable not zero",
      "amazon_safet_claims",
      "file",
    );
  } else {
    const gapQty = Math.max(0, lostQty + disposedQty - reimbursedQty);
    unreimbursedState = withQuantity("unreimbursed_gap", gapQty, {
      source_table: "amazon_inventory_ledger",
      source_type: "computed",
      as_of: maxDate(ledgerRows, "event_date", "created_at"),
      confidence: (safetCount ?? 0) === 0 ? "low" : "medium",
      freshness: freshnessFromDate(maxDate(ledgerRows, "event_date", "created_at"), ledgerRows.length > 0),
      claim_candidate_capable: gapQty > 0 ? "partial" : "no",
      blocker_reason: (prices ?? []).length === 0 ? "cogs_unknown_not_zero" : null,
      amount: null,
      amount_display: (prices ?? []).length === 0 ? "Cost unknown" : null,
    });
  }

  const states: LifecycleStateCounter[] = [
    sentQty > 0 || inboundRows.length > 0
      ? withQuantity("sent_to_amazon", sentQty, {
          source_table: "amazon_inbound_performance",
          source_type: "file",
          as_of: inboundAsOf,
          confidence: linkageBlocker ? "medium" : "medium",
          freshness: inboundFresh,
          claim_candidate_capable: "no",
          blocker_reason: linkageBlocker,
        })
      : unavailable("sent_to_amazon", "no_inbound_performance_rows", "amazon_inbound_performance", "file"),

    receivedQty > 0 || inboundRows.length > 0
      ? withQuantity("received_by_amazon", receivedQty, {
          source_table: "amazon_inbound_performance",
          source_type: "file",
          as_of: inboundAsOf,
          confidence: linkageBlocker ? "medium" : "high",
          freshness: inboundFresh,
          claim_candidate_capable: "no",
          blocker_reason: linkageBlocker,
        })
      : unavailable("received_by_amazon", "no_inbound_performance_rows", "amazon_inbound_performance", "file"),

    availableFba,
    reservedFba,

    warehouseQty > 0
      ? withQuantity("warehouse_internal", warehouseQty, {
          source_table: "return_items",
          source_type: "scanner",
          as_of: maxDate(warehouseRows, "created_at"),
          confidence: "high",
          freshness: "fresh",
          claim_candidate_capable: linkageBlocker ? "partial" : "yes",
          blocker_reason: linkageBlocker,
        })
      : counterBase("warehouse_internal", {
          source_table: "return_items",
          source_type: "scanner",
          quantity: 0,
          quantity_display: "0",
          confidence: "high",
          freshness: "fresh",
          claim_candidate_capable: "no",
        }),

    soldQty > 0
      ? withQuantity("sold", soldQty, {
          source_table: "amazon_settlements",
          source_type: "file",
          as_of: maxDate(settlements, "posted_date", "created_at"),
          confidence: "medium",
          freshness: freshnessFromDate(maxDate(settlements, "posted_date", "created_at"), true),
          claim_candidate_capable: "no",
        })
      : unavailable("sold", settlements.length === 0 ? "no_settlement_rows" : "no_positive_sale_qty", "amazon_settlements", "file"),

    refundQty > 0
      ? withQuantity("refunded_or_canceled", refundQty, {
          source_table: "amazon_settlements",
          source_type: "file",
          as_of: maxDate(settlements, "posted_date", "created_at"),
          confidence: "medium",
          freshness: freshnessFromDate(maxDate(settlements, "posted_date", "created_at"), true),
          claim_candidate_capable: "partial",
        })
      : unavailable("refunded_or_canceled", "no_refund_settlement_rows", "amazon_settlements", "file"),

    customerReturnQty > 0
      ? withQuantity("customer_returned", customerReturnQty, {
          source_table: "amazon_returns",
          source_type: "file",
          as_of: maxDate(amazonReturns, "return_date", "created_at"),
          confidence: linkageBlocker ? "medium" : "high",
          freshness: freshnessFromDate(maxDate(amazonReturns, "return_date", "created_at"), true),
          claim_candidate_capable: "no",
          blocker_reason: "generator_not_built",
        })
      : unavailable("customer_returned", "no_fba_return_rows", "amazon_returns", "file"),

    removedCreated,
    removedShipped.state,

    disposedQty > 0
      ? withQuantity("disposed", disposedQty, {
          source_table: "amazon_removals",
          source_type: "api",
          as_of: maxDate(removalDisposed, "order_date", "created_at"),
          confidence: "medium",
          freshness: freshnessFromDate(maxDate(removalDisposed, "order_date", "created_at"), true),
          claim_candidate_capable: "partial",
        })
      : unavailable("disposed", "no_disposal_rows", "amazon_removals", "api"),

    damagedScanner + damagedReturns > 0
      ? withQuantity("damaged", damagedScanner + damagedReturns, {
          source_table: damagedScanner > 0 ? "return_items" : "amazon_returns",
          source_type: damagedScanner > 0 ? "scanner" : "file",
          confidence: "medium",
          freshness: "unknown",
          claim_candidate_capable: "partial",
        })
      : unavailable("damaged", "no_damaged_signal_rows", null, "file"),

    lostQty > 0
      ? withQuantity("lost", lostQty, {
          source_table: "amazon_inventory_ledger",
          source_type: "file",
          as_of: maxDate(ledgerRows, "event_date", "created_at"),
          confidence: linkageBlocker ? "medium" : "high",
          freshness: freshnessFromDate(maxDate(ledgerRows, "event_date", "created_at"), true),
          claim_candidate_capable: "yes",
          blocker_reason: linkageBlocker,
        })
      : unavailable("lost", ledgerRows.length === 0 ? "no_ledger_rows" : "no_unreconciled_loss", "amazon_inventory_ledger", "file"),

    expiredScanner > 0 || ageProxy > 0
      ? withQuantity("expired", expiredScanner > 0 ? expiredScanner : ageProxy, {
          source_table: expiredScanner > 0 ? "return_items" : "amazon_fba_inventory",
          source_type: expiredScanner > 0 ? "scanner" : "file",
          as_of: latestFba?.snapshot_date != null ? String(latestFba.snapshot_date) : maxDate(warehouseRows, "created_at"),
          confidence: expiredScanner > 0 ? "high" : "low",
          freshness: latestFba ? freshnessFromDate(String(latestFba.snapshot_date ?? ""), true) : "unknown",
          claim_candidate_capable: expiredScanner > 0 ? "yes" : "no",
          blocker_reason: expiredScanner === 0 && ageProxy > 0 ? "fba_age_proxy_not_expiry_date" : null,
        })
      : unavailable("expired", "no_expired_scanner_or_age_proxy", "return_items", "scanner"),

    unavailable(
      "stranded",
      "stranded_inventory_report_not_normalized",
      "amazon_fba_inventory",
      "file",
    ),

    reimbRows.length > 0
      ? withQuantity("reimbursed", reimbursedQty, {
          source_table: "amazon_reimbursements",
          source_type: "file",
          as_of: maxDate(reimbRows, "approval_date", "created_at"),
          confidence: "high",
          freshness: freshnessFromDate(maxDate(reimbRows, "approval_date", "created_at"), true),
          claim_candidate_capable: "no",
          amount: reimbursedAmount,
          amount_display: `$${reimbursedAmount.toFixed(2)} observed`,
          blocker_reason: "observed_not_expected_recovery",
        })
      : unavailable("reimbursed", "no_reimbursement_rows", "amazon_reimbursements", "file"),

    unreimbursedState,

    (feePreviewCount ?? 0) === 0 && (storageFeeCount ?? 0) === 0
      ? unavailable(
          "fee_or_dimension_issue",
          "fee_preview_and_monthly_storage_empty",
          "amazon_fee_preview",
          "file",
        )
      : counterBase("fee_or_dimension_issue", {
          source_table: "amazon_fee_preview",
          source_type: "file",
          quantity: null,
          quantity_display: "Policy deferred",
          confidence: "low",
          freshness: "missing",
          claim_candidate_capable: "no",
          blocker_reason: "generator_not_live",
        }),
  ];

  const ordered = LIFECYCLE_STATE_KEYS.map((key) => states.find((s) => s.state_key === key)!);

  return {
    read_only: true,
    no_db_writes: true,
    generated_at: generatedAt,
    product_id: productId,
    organization_id: organizationId,
    store_id: storeId,
    linkage_status,
    identifiers,
    states: ordered,
    disputed_bucket: {
      label: "Needs reconciliation",
      quantity: totalDisputed,
      excluded_reasons: excludedReasons,
    },
    money_lanes: {
      sale_context: (prices ?? []).length > 0 ? "product_prices" : null,
      actual_cost: (prices ?? []).length > 0 ? "partial" : "unknown",
      actual_cost_note: "SellerSnap COGS not wired; product_prices is sale context not unit COGS",
      observed_reimbursement_amount: reimbRows.length > 0 ? reimbursedAmount : null,
      observed_reimbursement_note: "Observed reimbursement is separate from expected recovery",
    },
    product_story_integration_notes:
      "ProductDetailDrawer can fetch GET /api/dashboard/products/{id}/lifecycle-quantities?organization_id=&store_id= for lifecycle chips; same RBAC as product detail.",
    primary_total_rules: [
      "Exclude disputed expected_packages build_status from removed_shipped primary",
      "Exclude superseded_stale_partial amazon_removals from removed_created primary",
      "SAFE-T empty → unreimbursed_gap unavailable not zero",
      "COGS missing → Cost unknown not $0",
      "Do not infer claim quantity from single conflicted source",
    ],
  };
}

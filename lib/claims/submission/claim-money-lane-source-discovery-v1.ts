/**
 * PHASE-CLAIM-MONEY-LANE-SOURCE-DISCOVERY-V1
 * Read-only discovery of money lane source paths for pilot submissions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import { buildClaimCaseReviewReadmodel } from "../pilot/claim-case-review-readmodel";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { extractCogsOverrideUnitCost } from "./cogs-override-value-v1";
import {
  composeReimbursementTrackingPreviewV1,
  extractJoinKeys,
  matchReimbursementRows,
  type ReimbursementTrackingPreviewRow,
} from "./claim-reimbursement-tracking-preview-v1";
import {
  extractClaimCaseIdFromSubmission,
  loadExistingPilotSubmissions,
  type ExistingPilotSubmission,
} from "./claim-submission-record-pilot-v1";

export const CLAIM_MONEY_LANE_SOURCE_DISCOVERY_V1_VERSION =
  "claim-money-lane-source-discovery-v1" as const;

export type FeeBreakdown = {
  principal: number | null;
  fba_per_unit_fulfillment_fee: number | null;
  commission: number | null;
  refund_commission: number | null;
  shipping: number | null;
  promotions: number | null;
  tax_passthrough: number | null;
  source_table: string | null;
  source_row_id: string | null;
  posted_date: string | null;
};

export type PerSubmissionSourceDiscovery = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  product_identifiers: {
    asin: string | null;
    fnsku: string | null;
    sku: string | null;
    resolved_product_id: string | null;
  };
  quantity: number | null;
  source_event_key: string | null;
  tracking: string | null;
  removal_order: string | null;
  removal_shipment: string | null;
  latest_sold_price_found: boolean;
  latest_sold_price_value: number | null;
  latest_sold_price_source: string | null;
  fee_deductions_found: boolean;
  fee_breakdown: FeeBreakdown | null;
  settlement_amount_found: boolean;
  settlement_amount: number | null;
  settlement_source: string | null;
  reimbursement_found: boolean;
  reimbursement_amount: number | null;
  reimbursement_source: string | null;
  cogs_found: boolean;
  cogs_value: number | null;
  cogs_source: string | null;
  estimated_recovery_possible: boolean;
  recovery_value_preview: number | null;
  blockers: string[];
};

export type OrgSourceInventory = {
  table: string;
  row_count: number;
  latest_row_at: string | null;
  sku_populated_count: number | null;
  note: string;
};

export type UploadInventoryRow = {
  report_type: string;
  upload_count: number;
  latest_upload_at: string | null;
  latest_status: string | null;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function absFee(v: number | null): number | null {
  if (v == null) return null;
  return Math.abs(v);
}

async function safeQuery(
  client: SupabaseClient,
  table: string,
  select: string,
  filters: Array<{ col: string; op: "eq" | "in" | "not" | "neq"; val: string | string[] }>,
  limit = 5,
  order?: { col: string; ascending: boolean },
): Promise<Record<string, unknown>[]> {
  let q = client.from(table).select(select).limit(limit);
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, f.val as string);
    else if (f.op === "in") q = q.in(f.col, f.val as string[]);
    else if (f.op === "not") q = q.not(f.col, "is", null);
    else if (f.op === "neq") q = q.neq(f.col, f.val as string);
  }
  if (order) q = q.order(order.col, { ascending: order.ascending });
  const { data, error } = await q;
  if (error) {
    if (
      error.message.includes("does not exist") ||
      error.message.includes("schema cache") ||
      error.message.includes("timeout")
    ) {
      return [];
    }
    throw new Error(`${table}: ${error.message}`);
  }
  return (data ?? []) as unknown as Record<string, unknown>[];
}

async function safeCount(
  client: SupabaseClient,
  table: string,
  filters: Array<{ col: string; op: "eq" | "in" | "not" | "neq"; val: string | string[] }>,
): Promise<number> {
  let q = client.from(table).select("id", { count: "exact", head: true });
  for (const f of filters) {
    if (f.op === "eq") q = q.eq(f.col, f.val as string);
    else if (f.op === "in") q = q.in(f.col, f.val as string[]);
    else if (f.op === "not") q = q.not(f.col, "is", null);
    else if (f.op === "neq") q = q.neq(f.col, f.val as string);
  }
  const { count, error } = await q;
  if (error) {
    if (
      error.message.includes("does not exist") ||
      error.message.includes("schema cache") ||
      error.message.includes("timeout")
    ) {
      return 0;
    }
    throw new Error(`${table}: ${error.message}`);
  }
  return count ?? 0;
}

function pickLatestRow(
  rows: Record<string, unknown>[],
  dateFields: string[],
): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const scored = rows
    .map((r) => {
      let best = "";
      for (const f of dateFields) {
        const d = str(r[f]);
        if (d && d > best) best = d;
      }
      return { row: r, date: best };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return scored[0]?.row ?? null;
}

function feeBreakdownFromWideRow(
  row: Record<string, unknown>,
  sourceTable: string,
): FeeBreakdown {
  const taxPassthrough =
    (num(row.product_sales_tax) ?? 0) +
    (num(row.marketplace_withheld_tax) ?? 0) +
    (num(row.shipping_credits_tax) ?? 0);
  return {
    principal: num(row.product_sales),
    fba_per_unit_fulfillment_fee: absFee(num(row.fba_fees)),
    commission: absFee(num(row.selling_fees)),
    refund_commission: null,
    shipping: num(row.shipping_credits),
    promotions: num(row.promotional_rebates),
    tax_passthrough: taxPassthrough !== 0 ? taxPassthrough : null,
    source_table: sourceTable,
    source_row_id: str(row.id) || null,
    posted_date: str(row.posted_date) || str(row.date_time) || str(row.purchase_date) || null,
  };
}

function hasFeeSignal(fee: FeeBreakdown | null): boolean {
  if (!fee) return false;
  return (
    fee.principal != null ||
    fee.fba_per_unit_fulfillment_fee != null ||
    fee.commission != null ||
    fee.shipping != null ||
    fee.promotions != null
  );
}

async function queryBySku(
  client: SupabaseClient,
  table: string,
  select: string,
  organizationId: string,
  storeId: string | null,
  sku: string | null,
  dateFields: string[],
  limit = 8,
): Promise<Record<string, unknown>[]> {
  if (!sku) return [];
  const filters: Array<{ col: string; op: "eq" | "in" | "not" | "neq"; val: string | string[] }> = [
    { col: "organization_id", op: "eq", val: organizationId },
    { col: "sku", op: "eq", val: sku },
  ];
  if (storeId && table !== "amazon_reports_repository") {
    filters.push({ col: "store_id", op: "eq", val: storeId });
  }
  return safeQuery(client, table, select, filters, limit).then((rows) =>
    [...rows].sort((a, b) => {
      const da = dateFields.map((f) => str(a[f])).filter(Boolean).sort().reverse()[0] ?? "";
      const db = dateFields.map((f) => str(b[f])).filter(Boolean).sort().reverse()[0] ?? "";
      return da < db ? 1 : da > db ? -1 : 0;
    }),
  );
}

async function resolveLatestSoldPrice(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  sku: string | null;
  asin: string | null;
}): Promise<{ found: boolean; value: number | null; source: string | null; row: Record<string, unknown> | null }> {
  const repoSelect =
    "id, sku, date_time, product_sales, selling_fees, fba_fees, shipping_credits, promotional_rebates, product_sales_tax, marketplace_withheld_tax, total_amount";
  const settlementSelect =
    "id, sku, posted_date, product_sales, selling_fees, fba_fees, shipping_credits, promotional_rebates, amount_total, transaction_type";
  const ordersSelect = "id, sku, purchase_date, item_price, quantity, order_id";

  const [repoRows, settlementRows, orderRows] = await Promise.all([
    queryBySku(args.client, "amazon_reports_repository", repoSelect, args.organizationId, null, args.sku, [
      "date_time",
    ]),
    queryBySku(args.client, "amazon_settlements", settlementSelect, args.organizationId, args.storeId, args.sku, [
      "posted_date",
    ]),
    queryBySku(args.client, "amazon_all_orders", ordersSelect, args.organizationId, args.storeId, args.sku, [
      "purchase_date",
    ]),
  ]);

  const candidates: Array<{ value: number | null; source: string; row: Record<string, unknown>; date: string }> = [];

  const repo = pickLatestRow(repoRows, ["date_time"]);
  if (repo && num(repo.product_sales) != null) {
    candidates.push({
      value: num(repo.product_sales),
      source: "amazon_reports_repository.product_sales",
      row: repo,
      date: str(repo.date_time),
    });
  }

  const settlement = pickLatestRow(settlementRows, ["posted_date"]);
  if (settlement && num(settlement.product_sales) != null) {
    candidates.push({
      value: num(settlement.product_sales),
      source: "amazon_settlements.product_sales",
      row: settlement,
      date: str(settlement.posted_date),
    });
  }

  const order = pickLatestRow(orderRows, ["purchase_date"]);
  if (order && num(order.item_price) != null) {
    candidates.push({
      value: num(order.item_price),
      source: "amazon_all_orders.item_price",
      row: order,
      date: str(order.purchase_date),
    });
  }

  if (candidates.length === 0) {
    return { found: false, value: null, source: null, row: null };
  }

  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const best = candidates[0]!;
  return { found: true, value: best.value, source: best.source, row: best.row };
}

async function resolveCogs(args: {
  client: SupabaseClient;
  organizationId: string;
  productId: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  candidateCogs: number | null;
  cogsOverrides: Record<string, unknown>;
}): Promise<{ found: boolean; value: number | null; source: string | null }> {
  if (args.candidateCogs != null) {
    return { found: true, value: args.candidateCogs, source: "claim_candidates.cogs_unit" };
  }

  for (const [key, src] of [
    [args.sku, "workspace_settings.claim_intake.cogs_overrides[sku]"],
    [args.fnsku, "workspace_settings.claim_intake.cogs_overrides[fnsku]"],
    [args.asin, "workspace_settings.claim_intake.cogs_overrides[asin]"],
  ] as const) {
    if (key && args.cogsOverrides[key] != null) {
      const v = extractCogsOverrideUnitCost(args.cogsOverrides[key]);
      if (v != null) return { found: true, value: v, source: src };
    }
  }

  if (args.productId) {
    const snaps = await safeQuery(
      args.client,
      "product_cost_snapshots",
      "id, product_id, unit_cost, source_code, effective_at",
      [
        { col: "organization_id", op: "eq", val: args.organizationId },
        { col: "product_id", op: "eq", val: args.productId! },
      ],
      3,
      { col: "effective_at", ascending: false },
    );
    const snap = snaps[0];
    if (snap && num(snap.unit_cost) != null) {
      return {
        found: true,
        value: num(snap.unit_cost),
        source: `product_cost_snapshots.${str(snap.source_code) || "unknown"}`,
      };
    }
  }

  return { found: false, value: null, source: null };
}

function extractRemovalRefs(
  submission: ExistingPilotSubmission,
  caseRow: ClaimCaseReviewRow | null,
): { tracking: string | null; removal_order: string | null; removal_shipment: string | null } {
  const joinKeys = extractJoinKeys({ submission, caseRow });
  return {
    tracking: [...joinKeys.tracking_numbers][0] ?? null,
    removal_order: [...joinKeys.removal_order_ids][0] ?? null,
    removal_shipment: [...joinKeys.removal_shipment_ids][0] ?? null,
  };
}

export async function loadOrgSourceInventory(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{
  tables: OrgSourceInventory[];
  uploads: UploadInventoryRow[];
}> {
  const tableSpecs: Array<{
    table: string;
    dateCol: string | null;
    skuFilter?: boolean;
    note: string;
  }> = [
    { table: "amazon_reports_repository", dateCol: "date_time", skuFilter: true, note: "Transaction View / Reports Repository" },
    { table: "amazon_settlements", dateCol: "posted_date", skuFilter: true, note: "Settlement flat / payment detail" },
    { table: "amazon_transactions", dateCol: "posted_date", skuFilter: true, note: "Simple transactions summary" },
    { table: "amazon_reimbursements", dateCol: "approval_date", skuFilter: true, note: "FBA Reimbursements" },
    { table: "amazon_all_orders", dateCol: "purchase_date", skuFilter: true, note: "All orders / fulfilled shipments" },
    { table: "amazon_fee_preview", dateCol: "created_at", skuFilter: false, note: "Fee preview spine" },
    { table: "product_cost_snapshots", dateCol: "effective_at", skuFilter: false, note: "Approved COGS spine" },
  ];

  const tables: OrgSourceInventory[] = [];
  for (const spec of tableSpecs) {
    const countFilters: Array<{ col: string; op: "eq" | "in" | "not" | "neq"; val: string | string[] }> = [
      { col: "organization_id", op: "eq", val: organizationId },
    ];
    if (spec.table !== "amazon_reports_repository" && spec.table !== "product_cost_snapshots") {
      countFilters.push({ col: "store_id", op: "eq", val: storeId });
    }
    const row_count = await safeCount(client, spec.table, countFilters);

    let sku_populated_count: number | null = null;
    if (spec.skuFilter) {
      const probeFilters = [...countFilters, { col: "sku", op: "not" as const, val: "" }];
      const probe = await safeQuery(client, spec.table, "id, sku", probeFilters, 1);
      sku_populated_count = probe.length > 0 && str(probe[0]?.sku) ? 1 : 0;
    }

    tables.push({
      table: spec.table,
      row_count,
      latest_row_at: null,
      sku_populated_count,
      note: spec.note,
    });
  }

  const uploadRows = await safeQuery(
    client,
    "raw_report_uploads",
    "id, report_type, status, created_at",
    [{ col: "organization_id", op: "eq", val: organizationId }],
    500,
    { col: "created_at", ascending: false },
  );

  const byType = new Map<string, UploadInventoryRow>();
  for (const row of uploadRows) {
    const rt = str(row.report_type) || "UNKNOWN";
    const existing = byType.get(rt);
    const created = str(row.created_at);
    if (!existing) {
      byType.set(rt, {
        report_type: rt,
        upload_count: 1,
        latest_upload_at: created || null,
        latest_status: str(row.status) || null,
      });
    } else {
      existing.upload_count += 1;
    }
  }

  return { tables, uploads: [...byType.values()] };
}

export const SP_API_MONEY_LANE_REPORT_TYPES = [
  {
    report_type: "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    domain_table: "amazon_settlements",
    sync_kind: "SETTLEMENT",
    purpose: "net_settlement_amount + fee columns",
  },
  {
    report_type: "GET_FBA_REIMBURSEMENTS_DATA",
    domain_table: "amazon_reimbursements",
    sync_kind: "REIMBURSEMENTS",
    purpose: "observed_reimbursement",
  },
  {
    report_type: null,
    domain_table: "amazon_reports_repository",
    sync_kind: "REPORTS_REPOSITORY",
    purpose: "latest_sold_price + fee_deductions (Transaction View file)",
  },
  {
    report_type: null,
    domain_table: "amazon_transactions",
    sync_kind: "TRANSACTIONS",
    purpose: "transaction-level principal/fees (file import; SKU often sparse)",
  },
  {
    report_type: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
    domain_table: "amazon_all_orders",
    sync_kind: "ALL_ORDERS",
    purpose: "latest_sold_price informational (item_price)",
  },
] as const;

export async function discoverMoneyLaneSourcesV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<{
  pilot_submission_count: number;
  per_submission: PerSubmissionSourceDiscovery[];
  previews: ReimbursementTrackingPreviewRow[];
  org_inventory: Awaited<ReturnType<typeof loadOrgSourceInventory>>;
  coverage: {
    latest_sold_price: number;
    fee_deductions: number;
    settlement: number;
    reimbursement: number;
    cogs: number;
    safe_recovery_value: number;
  };
  missing_source_files: string[];
  missing_api_report_types: string[];
  source_truth_recommendation: string;
}> {
  const pilotCaseRunId = str(options.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(options.intake_run_id) || PILOT_INTAKE_RUN_ID;

  const composed = await composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
  });

  const review = await buildClaimCaseReviewReadmodel(client, organizationId, storeId, {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    status: "open",
    limit: 100,
  });
  const caseById = new Map(review.rows.map((r) => [r.id, r]));
  const submissionById = new Map(composed.pilot_submissions.map((s) => [s.id, s]));

  // Prefer an org-scoped workspace_settings row; fall back to the canonical singleton
  // row used by the rest of the app (organization_id may be NULL on it).
  const byOrgSettings = await client
    .from("workspace_settings")
    .select("module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  let settingsModuleConfigs = metaRecord(byOrgSettings.data?.module_configs);
  if (!byOrgSettings.data) {
    const singletonSettings = await client
      .from("workspace_settings")
      .select("module_configs")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    settingsModuleConfigs = metaRecord(singletonSettings.data?.module_configs);
  }
  const claimIntake = metaRecord(settingsModuleConfigs.claim_intake);
  const cogsOverrides = metaRecord(claimIntake.cogs_overrides);

  const org_inventory = await loadOrgSourceInventory(client, organizationId, storeId);

  const pilotOrderIds = new Set<string>();
  for (const preview of composed.previews) {
    const submission = submissionById.get(preview.claim_submission_id)!;
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    for (const id of extractJoinKeys({ submission, caseRow }).order_ids) {
      if (id) pilotOrderIds.add(id);
    }
  }
  const orderIdList = [...pilotOrderIds].slice(0, 40);

  const reimbursementRows =
    orderIdList.length > 0
      ? await safeQuery(
          client,
          "amazon_reimbursements",
          "id, organization_id, store_id, order_id, reimbursement_id, case_id, sku, fnsku, asin, amount_total, currency_unit, approval_date, reason",
          [
            { col: "organization_id", op: "eq", val: organizationId },
            { col: "store_id", op: "eq", val: storeId },
            { col: "order_id", op: "in", val: orderIdList },
          ],
          200,
        )
      : [];

  const per_submission: PerSubmissionSourceDiscovery[] = [];

  for (const preview of composed.previews) {
    const submission = submissionById.get(preview.claim_submission_id)!;
    const caseRow = caseById.get(preview.claim_case_id) ?? null;
    const refs = extractRemovalRefs(submission, caseRow);
    const joinKeys = extractJoinKeys({ submission, caseRow });

    const candidateIds = caseRow?.candidate_ids ?? [];
    const candidateRows =
      candidateIds.length > 0
        ? await safeQuery(
            client,
            "claim_candidates",
            "id, cogs_unit, recovery_value",
            [{ col: "id", op: "in", val: candidateIds.slice(0, 20) }],
            10,
          )
        : [];
    const candidateCogs =
      candidateRows.map((r) => num(r.cogs_unit)).find((v) => v != null) ?? null;

    const sold = await resolveLatestSoldPrice({
      client,
      organizationId,
      storeId,
      sku: preview.sku,
      asin: preview.asin,
    });

    let fee_breakdown: FeeBreakdown | null = null;
    if (sold.row) {
      const table =
        sold.source?.startsWith("amazon_settlements") ? "amazon_settlements" : "amazon_reports_repository";
      fee_breakdown = feeBreakdownFromWideRow(sold.row, table);
    }

    const linkedReimb = matchReimbursementRows({ rows: reimbursementRows, joinKeys });
    const linkedSettlement = preview.linked_settlement_rows;
    const settlementAmount =
      linkedSettlement.length > 0
        ? linkedSettlement.reduce((s, r) => s + (r.amount ?? 0), 0)
        : sold.row
          ? num(sold.row.amount_total) ?? num(sold.row.total_amount)
          : null;

    const cogs = await resolveCogs({
      client,
      organizationId,
      productId: preview.product_identity.resolved_product_id,
      sku: preview.sku,
      fnsku: preview.fnsku,
      asin: preview.asin,
      candidateCogs,
      cogsOverrides,
    });

    const qty = preview.clean_quantity;
    const recovery_preview =
      cogs.found && cogs.value != null && qty != null ? cogs.value * qty : null;

    const blockers: string[] = [];
    if (!sold.found) blockers.push("LATEST_SOLD_PRICE_NOT_FOUND_FOR_SKU");
    if (!hasFeeSignal(fee_breakdown)) blockers.push("FEE_DEDUCTIONS_NOT_FOUND");
    if (settlementAmount == null) blockers.push("NET_SETTLEMENT_NOT_TIED_TO_REFERENCE");
    if (linkedReimb.length === 0) blockers.push("OBSERVED_REIMBURSEMENT_NO_SAFE_MATCH_NOT_FILED");
    if (!cogs.found) blockers.push("COGS_MISSING");
    if (recovery_preview == null) blockers.push("ESTIMATED_RECOVERY_BLOCKED_NO_COGS");
    // latest_sold_price is informational only — never used as recovery estimate.

    per_submission.push({
      claim_submission_id: preview.claim_submission_id,
      claim_case_id: preview.claim_case_id,
      family: preview.family_key_v3,
      product_identifiers: preview.product_identity,
      quantity: qty,
      source_event_key: preview.source_event_key,
      tracking: refs.tracking,
      removal_order: refs.removal_order,
      removal_shipment: refs.removal_shipment,
      latest_sold_price_found: sold.found,
      latest_sold_price_value: sold.value,
      latest_sold_price_source: sold.source,
      fee_deductions_found: hasFeeSignal(fee_breakdown),
      fee_breakdown,
      settlement_amount_found: settlementAmount != null,
      settlement_amount: settlementAmount,
      settlement_source:
        linkedSettlement.length > 0
          ? "amazon_settlements.reference_safe_order_match"
          : sold.source?.includes("settlements")
            ? sold.source
            : null,
      reimbursement_found: linkedReimb.length > 0,
      reimbursement_amount:
        linkedReimb.length > 0 ? linkedReimb.reduce((s, r) => s + (r.amount ?? 0), 0) : null,
      reimbursement_source:
        linkedReimb.length > 0 ? "amazon_reimbursements.reference_safe_match" : null,
      cogs_found: cogs.found,
      cogs_value: cogs.value,
      cogs_source: cogs.source,
      estimated_recovery_possible: recovery_preview != null,
      recovery_value_preview: recovery_preview,
      blockers,
    });
  }

  const n = per_submission.length;
  const coverage = {
    latest_sold_price: per_submission.filter((p) => p.latest_sold_price_found).length,
    fee_deductions: per_submission.filter((p) => p.fee_deductions_found).length,
    settlement: per_submission.filter((p) => p.settlement_amount_found).length,
    reimbursement: per_submission.filter((p) => p.reimbursement_found).length,
    cogs: per_submission.filter((p) => p.cogs_found).length,
    safe_recovery_value: per_submission.filter((p) => p.estimated_recovery_possible).length,
  };

  const missing_source_files: string[] = [];
  const repo = org_inventory.tables.find((t) => t.table === "amazon_reports_repository");
  const settlements = org_inventory.tables.find((t) => t.table === "amazon_settlements");
  const transactions = org_inventory.tables.find((t) => t.table === "amazon_transactions");
  const feePreview = org_inventory.tables.find((t) => t.table === "amazon_fee_preview");
  const costSnap = org_inventory.tables.find((t) => t.table === "product_cost_snapshots");

  if ((repo?.row_count ?? 0) === 0) {
    missing_source_files.push("REPORTS_REPOSITORY_TRANSACTION_VIEW — not imported");
  } else if ((repo?.sku_populated_count ?? 0) === 0) {
    missing_source_files.push("REPORTS_REPOSITORY — rows exist but SKU column empty");
  }
  if ((settlements?.row_count ?? 0) === 0) {
    missing_source_files.push("SETTLEMENT_FLAT_FILE_V2 — not imported");
  } else {
    const settlementUpload = org_inventory.uploads.find((u) => u.report_type === "SETTLEMENT");
    if (settlementUpload?.latest_upload_at && settlementUpload.latest_upload_at < "2026-05-01") {
      missing_source_files.push(`SETTLEMENT — stale upload (latest ${settlementUpload.latest_upload_at})`);
    }
  }
  if ((transactions?.row_count ?? 0) === 0) {
    missing_source_files.push("TRANSACTIONS_SUMMARY — not imported");
  } else if ((transactions?.sku_populated_count ?? 0) === 0) {
    missing_source_files.push("TRANSACTIONS — SKU column empty on all rows");
  }
  if ((feePreview?.row_count ?? 0) === 0) {
    missing_source_files.push("FEE_PREVIEW — not imported");
  }
  if ((costSnap?.row_count ?? 0) === 0) {
    missing_source_files.push("PRODUCT_COST_SNAPSHOTS / SellerSnap COGS — not imported");
  }

  const missing_api_report_types: string[] = [];
  const hasUpload = (rt: string) => org_inventory.uploads.some((u) => u.report_type === rt);
  if (!hasUpload("SETTLEMENT") && (settlements?.row_count ?? 0) === 0) {
    missing_api_report_types.push("GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2");
  }
  if (!hasUpload("REIMBURSEMENTS") && (org_inventory.tables.find((t) => t.table === "amazon_reimbursements")?.row_count ?? 0) === 0) {
    missing_api_report_types.push("GET_FBA_REIMBURSEMENTS_DATA");
  }
  if (!hasUpload("REPORTS_REPOSITORY") && (repo?.row_count ?? 0) === 0) {
    missing_api_report_types.push("REPORTS_REPOSITORY_FILE (Seller Central Transaction View)");
  }
  if (!hasUpload("ALL_ORDERS")) {
    const orders = org_inventory.tables.find((t) => t.table === "amazon_all_orders");
    if ((orders?.row_count ?? 0) === 0) missing_api_report_types.push("GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL");
  }

  const source_truth_recommendation =
    coverage.cogs === 0
      ? "Wire product_cost_snapshots or governed cogs_overrides for recovery_value; use amazon_reports_repository/settlements for informational latest_sold_price + fees; reimbursements only after filing via reference-safe match."
      : "COGS available for subset — recovery_value = qty × cogs_unit; sale price remains display-only from reports_repository/settlements/all_orders.";

  return {
    pilot_submission_count: n,
    per_submission,
    previews: composed.previews,
    org_inventory,
    coverage,
    missing_source_files,
    missing_api_report_types,
    source_truth_recommendation,
  };
}

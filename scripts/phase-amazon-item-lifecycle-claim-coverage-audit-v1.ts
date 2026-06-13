/**
 * PHASE-AMAZON-ITEM-LIFECYCLE-CLAIM-COVERAGE-AUDIT-V1 — read-only architecture/data audit.
 *   npx tsx scripts/phase-amazon-item-lifecycle-claim-coverage-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { CLAIM_SOURCE_KINDS } from "../lib/claims/intake/claim-intake-types";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-item-lifecycle-claim-coverage-audit-v1";

const SAMPLES = {
  removal_shipment: { fnsku: "X004LKS4VD", tracking: "387003587", label: "removal_shipment_sample" },
  real_spine: { fnsku: "B0000B11UX", product_id: "8beddd08-4133-48fb-abc1-279e61af8caf", label: "real_spine_sample" },
};

type Row = Record<string, unknown>;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return r.rows.length > 0;
}

async function countByFnsku(
  c: pg.Client,
  table: string,
  fnsku: string,
  extraWhere = "",
): Promise<number> {
  if (!(await tableExists(c, table))) return -1;
  const r = await c.query(
    `SELECT count(*)::int AS n FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
       ${extraWhere}`,
    [ORG, STORE, fnsku],
  );
  return Number((r.rows[0] as Row).n ?? 0);
}

async function countForTable(c: pg.Client, table: string, ids: { fnsku: string; asin: string | null; sku: string | null }): Promise<number> {
  if (!(await tableExists(c, table))) return -1;
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  if (colSet.has("fnsku")) return countByFnsku(c, table, ids.fnsku);
  if (colSet.has("asin") && ids.asin) return countByAsin(c, table, ids.asin);
  if (colSet.has("sku") && ids.sku) {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM public.${table}
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(btrim(coalesce(sku,''))) = upper(btrim($3))`,
      [ORG, STORE, ids.sku],
    );
    return Number((r.rows[0] as Row).n ?? 0);
  }
  return 0;
}

async function countByAsin(c: pg.Client, table: string, asin: string): Promise<number> {
  if (!(await tableExists(c, table))) return -1;
  const r = await c.query(
    `SELECT count(*)::int AS n FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(btrim(coalesce(asin,''))) = upper(btrim($3))`,
    [ORG, STORE, asin],
  );
  return Number((r.rows[0] as Row).n ?? 0);
}

async function traceProduct(
  c: pg.Client,
  ids: { fnsku?: string | null; asin?: string | null; sku?: string | null },
  ccActiveFilter = "",
): Promise<Row> {
  const fnsku = ids.fnsku ?? ids.asin ?? ids.sku ?? "";
  const asin = ids.asin ?? ids.fnsku ?? null;
  const probes: Row = { fnsku, asin, sku: ids.sku ?? null };
  const idBundle = { fnsku, asin, sku: ids.sku ?? null };
  const tables = [
    "expected_packages",
    "amazon_removal_shipments",
    "amazon_removals",
    "amazon_returns",
    "amazon_inventory_ledger",
    "amazon_reimbursements",
    "amazon_fba_inventory",
    "amazon_manage_fba_inventory",
    "return_items",
    "claim_candidates",
  ];
  for (const table of tables) {
    probes[`${table}_count`] = await countForTable(c, table, idBundle);
  }
  if (await tableExists(c, "amazon_removal_shipments")) {
    const ship = await c.query(
      `SELECT id::text, tracking_number, shipped_quantity, shipment_date::text, order_id
       FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
       ORDER BY shipment_date DESC NULLS LAST LIMIT 3`,
      [ORG, STORE, fnsku],
    );
    probes.removal_shipment_rows = ship.rows;
  }
  if (await tableExists(c, "amazon_reimbursements")) {
    const reimb = await c.query(
      `SELECT id::text, reimbursement_id, amount_total, quantity_reimbursed_total, approval_date::text, reason
       FROM public.amazon_reimbursements
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
       ORDER BY approval_date DESC NULLS LAST LIMIT 3`,
      [ORG, STORE, fnsku],
    );
    probes.reimbursement_rows = reimb.rows;
  }
  if (await tableExists(c, "amazon_returns")) {
    const ret = await c.query(
      `SELECT id::text, order_id, sku, asin, return_date::text, disposition, status
       FROM public.amazon_returns
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND (
           upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
           OR upper(btrim(coalesce(asin,''))) = upper(btrim($4))
           OR upper(btrim(coalesce(sku,''))) = upper(btrim($5))
         )
       ORDER BY return_date DESC NULLS LAST LIMIT 3`,
      [ORG, STORE, fnsku, asin ?? fnsku, ids.sku ?? ""],
    ).catch(() => ({ rows: [] }));
    probes.customer_return_rows = ret.rows;
  }
  if (await tableExists(c, "claim_candidates")) {
    try {
      const cc = await c.query(
        `SELECT id::text, claim_family, claim_reason, recovery_value, cogs_unit, created_at::text
         FROM public.claim_candidates
         WHERE organization_id = $1::uuid AND store_id = $2::uuid
           AND upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
           ${ccActiveFilter}
         ORDER BY created_at DESC LIMIT 5`,
        [ORG, STORE, fnsku],
      );
      probes.claim_candidate_rows = cc.rows;
    } catch {
      probes.claim_candidate_rows = [];
    }
  }
  return probes;
}

async function pickSampleIdentifier(
  c: pg.Client,
  table: string,
  minRows = 1,
): Promise<{ fnsku: string | null; asin: string | null; sku: string | null; n: number } | null> {
  if (!(await tableExists(c, table))) return null;
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  const idCol = colSet.has("fnsku") ? "fnsku" : colSet.has("asin") ? "asin" : colSet.has("sku") ? "sku" : null;
  if (!idCol) return null;
  const r = await c.query(
    `SELECT ${idCol} AS id_val, count(*)::int AS n
     FROM public.${table}
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND btrim(coalesce(${idCol},'')) <> ''
     GROUP BY ${idCol}
     HAVING count(*) >= $3
     ORDER BY count(*) DESC
     LIMIT 1`,
    [ORG, STORE, minRows],
  );
  const row = (r.rows[0] as Row) ?? null;
  if (!row) return null;
  const val = String(row.id_val ?? "");
  return {
    fnsku: idCol === "fnsku" ? val : null,
    asin: idCol === "asin" ? val : null,
    sku: idCol === "sku" ? val : null,
    n: Number(row.n ?? 0),
  };
}

const LIFECYCLE_STATES = [
  "inbound_sent_to_amazon",
  "received_by_amazon",
  "available_fba_inventory",
  "warehouse/internal_stock",
  "sold",
  "canceled/refunded",
  "customer_returned",
  "removal_created",
  "removal_shipped",
  "disposed",
  "damaged",
  "lost",
  "expired",
  "stranded",
  "reimbursed",
  "unreimbursed_gap",
  "fee_overcharged",
  "storage_fee_issue",
  "dimension_weight_issue",
] as const;

/** Static architecture matrix — code + schema contract (read-only audit). */
function lifecycleCoverageMatrix(): Row[] {
  return [
    {
      lifecycle_state: "inbound_sent_to_amazon",
      source_table: "amazon_inbound_performance",
      source_file_api: "Inbound performance / SP-API shipment reports",
      identifiers: ["sku", "fnsku", "asin", "fba_shipment_id"],
      event_date: "shipment_creation_date / issue_reported_date",
      quantity_field: "expected_quantity",
      amount_field: "fee_total",
      reference_id_type: "fba_shipment_id",
      trid_edge: "source_evidence → amazon_inbound_performance",
      claim_family: "inbound_shipment_shortage",
      generator: "inbound_shipment",
      orbit_category: null,
      supported_now: "partial",
      blocker: "No unified per-product inbound sent qty rollup; generator emits problem rows only",
      next_phase: "PHASE-LIFECYCLE-INBOUND-SENT-READMODEL-V1",
    },
    {
      lifecycle_state: "received_by_amazon",
      source_table: "amazon_inbound_performance",
      source_file_api: "Inbound performance",
      identifiers: ["fnsku", "asin", "sku"],
      event_date: "issue_reported_date",
      quantity_field: "received_quantity",
      amount_field: "fee_total",
      reference_id_type: "fba_shipment_id",
      trid_edge: "source_evidence",
      claim_family: "inbound_shipment_shortage",
      generator: "inbound_shipment",
      supported_now: "partial",
      blocker: "Received qty not exposed as lifecycle counter in Claim Center",
      next_phase: "PHASE-LIFECYCLE-INBOUND-RECEIVED-READMODEL-V1",
    },
    {
      lifecycle_state: "available_fba_inventory",
      source_table: "amazon_fba_inventory / amazon_manage_fba_inventory",
      source_file_api: "FBA inventory reports / RESTOCK_INVENTORY",
      identifiers: ["fnsku", "asin", "sku"],
      event_date: "snapshot_date / report_date",
      quantity_field: "available / fulfillable_quantity",
      amount_field: null,
      reference_id_type: "fnsku",
      trid_edge: "product_link only (no claim anchor)",
      claim_family: null,
      generator: null,
      supported_now: "data_only",
      blocker: "Inventory-on-hand is imported but not wired to lifecycle read-model or claim families",
      next_phase: "PHASE-LIFECYCLE-FBA-AVAILABLE-READMODEL-V1",
    },
    {
      lifecycle_state: "warehouse/internal_stock",
      source_table: "return_items + packages + pallets",
      source_file_api: "scanner operator mobile",
      identifiers: ["fnsku", "sku", "asin", "package_id"],
      event_date: "created_at",
      quantity_field: "scanned_quantity",
      amount_field: null,
      reference_id_type: "package_id",
      trid_edge: "source_evidence → return_items; shipment_scope → packages",
      claim_family: "physical_return_issue / physical_return_off_manifest",
      generator: "scanner_physical_review",
      supported_now: "yes",
      blocker: null,
      next_phase: "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1",
    },
    {
      lifecycle_state: "sold",
      source_table: "amazon_transactions / amazon_settlements / amazon_all_orders",
      source_file_api: "Transactions / Settlements / All Orders",
      identifiers: ["order_id", "sku", "asin"],
      event_date: "posted_date / purchase_date",
      quantity_field: "quantity",
      amount_field: "amount_total",
      reference_id_type: "order_id",
      trid_edge: "financial_reference → FRR",
      claim_family: "transaction_negative_adjustment (adjacent)",
      generator: "transaction / settlement",
      supported_now: "partial",
      blocker: "No per-product sold counter; generators target anomalies not lifecycle qty",
      next_phase: "PHASE-LIFECYCLE-SOLD-READMODEL-V1",
    },
    {
      lifecycle_state: "canceled/refunded",
      source_table: "amazon_settlements / amazon_transactions",
      source_file_api: "SETTLEMENT / TRANSACTIONS",
      identifiers: ["order_id", "sku"],
      event_date: "posted_date",
      quantity_field: "quantity",
      amount_field: "amount_total",
      reference_id_type: "order_id",
      trid_edge: "financial_reference",
      claim_family: "settlement_refund_review",
      generator: "settlement / orbit_fra",
      supported_now: "partial",
      blocker: "Refund lines detected as claim opportunities, not lifecycle canceled qty dashboard",
      next_phase: "PHASE-LIFECYCLE-REFUND-READMODEL-V1",
    },
    {
      lifecycle_state: "customer_returned",
      source_table: "amazon_returns",
      source_file_api: "FBA_RETURNS",
      identifiers: ["order_id", "sku", "asin", "lpn"],
      event_date: "return_date",
      quantity_field: "quantity",
      amount_field: null,
      reference_id_type: "order_id",
      trid_edge: "source_evidence → amazon_returns (not materialized today)",
      claim_family: null,
      generator: null,
      supported_now: "import_only",
      blocker: "FBA Customer Returns imported but NO trusted generator; distinct from scanner physical returns",
      next_phase: "PHASE-CLAIM-FBA-CUSTOMER-RETURNS-GENERATOR-V1",
    },
    {
      lifecycle_state: "removal_created",
      source_table: "amazon_removals",
      source_file_api: "REMOVAL_ORDER / Removal API",
      identifiers: ["order_id", "fnsku", "sku"],
      event_date: "order_date",
      quantity_field: "requested_quantity",
      amount_field: null,
      reference_id_type: "removal_order_id",
      trid_edge: "source_evidence → amazon_removals",
      claim_family: "removal_missing_units / removal_units_unaccounted",
      generator: "amazon_removal_api / orbit_fra",
      supported_now: "yes",
      blocker: null,
      next_phase: "PHASE-LIFECYCLE-REMOVAL-CREATED-READMODEL-V1",
    },
    {
      lifecycle_state: "removal_shipped",
      source_table: "amazon_removal_shipments / expected_packages",
      source_file_api: "REMOVAL_SHIPMENT / expected rebuild",
      identifiers: ["tracking_number", "fnsku", "order_id"],
      event_date: "shipment_date",
      quantity_field: "shipped_quantity / expected_scan_quantity",
      amount_field: "removal_fee",
      reference_id_type: "tracking_number",
      trid_edge: "shipment_scope; financial_reference",
      claim_family: "shipment_quantity_mismatch / removal_shipment_lost_in_transit",
      generator: "shipment_discrepancy / orbit_fra",
      supported_now: "yes",
      blocker: "EP overflow splits (387003587) are data truth; UI grouping gap only",
      next_phase: "PHASE-SCANNER-SHIPMENT-LINE-UI-GROUP-DISPLAY-387003587",
    },
    {
      lifecycle_state: "disposed",
      source_table: "amazon_removals / amazon_inventory_ledger",
      source_file_api: "REMOVAL_ORDER + INVENTORY_LEDGER",
      identifiers: ["fnsku", "order_id"],
      event_date: "order_date / event_date",
      quantity_field: "disposed_quantity / quantity",
      amount_field: null,
      reference_id_type: "removal_order_id / ledger_reference_id",
      trid_edge: "source_evidence",
      claim_family: "destroyed_without_permission (orbit)",
      generator: "orbit_fra / inventory_ledger",
      supported_now: "partial",
      blocker: "Disposed qty on removal row; ledger disposals need reason_code mapping",
      next_phase: "PHASE-LIFECYCLE-DISPOSED-READMODEL-V1",
    },
    {
      lifecycle_state: "damaged",
      source_table: "return_items / amazon_inventory_ledger",
      source_file_api: "scanner + INVENTORY_LEDGER",
      identifiers: ["fnsku", "conditions", "reason_code"],
      event_date: "created_at / event_date",
      quantity_field: "scanned_quantity / unreconciled_quantity",
      amount_field: null,
      reference_id_type: "return_item_id / ledger_reference_id",
      trid_edge: "source_evidence",
      claim_family: "physical_return_damaged / warehouse_damaged",
      generator: "scanner_physical_review / orbit_fra",
      supported_now: "yes",
      blocker: null,
      next_phase: "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1",
    },
    {
      lifecycle_state: "lost",
      source_table: "amazon_inventory_ledger",
      source_file_api: "INVENTORY_LEDGER",
      identifiers: ["fnsku", "reference_id", "reason_code M*"],
      event_date: "event_date",
      quantity_field: "unreconciled_quantity",
      amount_field: null,
      reference_id_type: "ledger_reference_id",
      trid_edge: "financial_reference + source_evidence",
      claim_family: "inventory_unreconciled_loss / warehouse_lost",
      generator: "inventory_ledger / orbit_fra",
      supported_now: "yes",
      blocker: "resolved_product_id sparse on ledger rows",
      next_phase: "PHASE-LIFECYCLE-LEDGER-LOST-LINKAGE-V1",
    },
    {
      lifecycle_state: "expired",
      source_table: "return_items",
      source_file_api: "scanner conditions",
      identifiers: ["fnsku", "conditions expired tag"],
      event_date: "created_at",
      quantity_field: "scanned_quantity",
      amount_field: null,
      reference_id_type: "package_id",
      trid_edge: "source_evidence",
      claim_family: "physical_return_issue (operator_flagged_expired)",
      generator: "scanner_physical_review",
      supported_now: "partial",
      blocker: "Expiry at FBA snapshot not wired — scanner-only today",
      next_phase: "PHASE-LIFECYCLE-EXPIRED-FBA-SNAPSHOT-V1",
    },
    {
      lifecycle_state: "stranded",
      source_table: "amazon_fba_inventory / amazon_reports_repository",
      source_file_api: "Stranded inventory report (if uploaded)",
      identifiers: ["fnsku", "asin"],
      event_date: "report snapshot",
      quantity_field: "stranded_units (report-dependent)",
      amount_field: null,
      reference_id_type: "fnsku",
      trid_edge: "product_link",
      claim_family: null,
      generator: null,
      supported_now: "no",
      blocker: "Stranded inventory not normalized into lifecycle table or generator",
      next_phase: "PHASE-LIFECYCLE-STRANDED-IMPORT-V1",
    },
    {
      lifecycle_state: "reimbursed",
      source_table: "amazon_reimbursements",
      source_file_api: "REIMBURSEMENTS",
      identifiers: ["reimbursement_id", "order_id", "fnsku"],
      event_date: "approval_date",
      quantity_field: "quantity_reimbursed_total",
      amount_field: "amount_total",
      reference_id_type: "reimbursement_id",
      trid_edge: "financial_reference → FRR",
      claim_family: "reimbursement_reversal (clawback) / observed reimbursement",
      generator: "reimbursement / orbit_fra",
      supported_now: "yes",
      blocker: "Positive reimbursements are observed state, not new claim opportunities",
      next_phase: "PHASE-LIFECYCLE-REIMBURSED-OBSERVED-READMODEL-V1",
    },
    {
      lifecycle_state: "unreimbursed_gap",
      source_table: "amazon_inventory_ledger / amazon_safet_claims",
      source_file_api: "INVENTORY_LEDGER + SAFE-T",
      identifiers: ["reference_id", "safet_claim_id"],
      event_date: "event_date / claim_date",
      quantity_field: "unreconciled_quantity",
      amount_field: "claim_amount",
      reference_id_type: "ledger_reference_id / safet_claim_id",
      trid_edge: "financial_reference",
      claim_family: "inventory_unreconciled_loss / safet_followup",
      generator: "inventory_ledger / safet",
      supported_now: "yes",
      blocker: "COGS unknown on many rows — money display Cost unknown",
      next_phase: "PHASE-PRODUCT-FINANCIAL-SPINE-COGS-WIRING-V1",
    },
    {
      lifecycle_state: "fee_overcharged",
      source_table: "amazon_fee_preview / amazon_finances_events",
      source_file_api: "Fee preview / Finances API (archive)",
      identifiers: ["fnsku", "asin", "order_id"],
      event_date: "posted_at",
      quantity_field: null,
      amount_field: "fee_amount",
      reference_id_type: "order_id",
      trid_edge: "financial_reference (planned)",
      claim_family: null,
      generator: null,
      supported_now: "no",
      blocker: "Fee overcharge families deferred; PC04 dims + FRR expansion not live",
      next_phase: "PHASE-CLAIM-FEE-OVERCHARGE-GENERATOR-V1",
    },
    {
      lifecycle_state: "storage_fee_issue",
      source_table: "amazon_monthly_storage_fees",
      source_file_api: "MONTHLY_STORAGE_FEES",
      identifiers: ["fnsku", "asin"],
      event_date: "month_of_charge",
      quantity_field: "volume / qty",
      amount_field: "estimated_monthly_storage_fee",
      reference_id_type: "fnsku",
      trid_edge: "financial_reference (planned)",
      claim_family: null,
      generator: null,
      supported_now: "no",
      blocker: "Storage fee generator not registered; table may be sparse",
      next_phase: "PHASE-CLAIM-STORAGE-FEE-GENERATOR-V1",
    },
    {
      lifecycle_state: "dimension_weight_issue",
      source_table: "dimensions_current / product_packaging_evidence",
      source_file_api: "PC04 / Catalog packaging evidence",
      identifiers: ["product_id"],
      event_date: "version observed_at",
      quantity_field: null,
      amount_field: "fee delta (computed)",
      reference_id_type: "product_id",
      trid_edge: "product_link + corroborates packaging evidence",
      claim_family: null,
      generator: null,
      supported_now: "partial",
      blocker: "PC04 stack exists; fee-claim eligibility policy rows not wired",
      next_phase: "PHASE-PC04-FEE-CLAIM-ELIGIBILITY-V1",
    },
  ];
}

function claimFamilyMatrix(): Row[] {
  return [
    { family: "physical_return_issue", sources: ["return_items"], generator: "scanner_physical_review", trid: "product_link + source_evidence", money: "COGS unknown unless cogs_unit", evidence: "scanner photos / notes", status: "MVP live" },
    { family: "physical_return_off_manifest", sources: ["return_items"], generator: "scanner_physical_review / orbit_fra", trid: "product_link + source_evidence", money: "Cost unknown", evidence: "off-slip notes", status: "MVP live" },
    { family: "removal_missing_units", sources: ["amazon_removals"], generator: "amazon_removal_api", trid: "source_evidence", money: "units × COGS if known", evidence: "removal order row", status: "generator live" },
    { family: "inventory_unreconciled_loss", sources: ["amazon_inventory_ledger"], generator: "inventory_ledger", trid: "ledger_reference + product_link", money: "unreconciled qty × COGS", evidence: "ledger row", status: "generator live" },
    { family: "inbound_shipment_shortage", sources: ["amazon_inbound_performance"], generator: "inbound_shipment", trid: "fba_shipment_id edge", money: "fee_total context", evidence: "inbound problem row", status: "generator live" },
    { family: "shipment_quantity_mismatch", sources: ["expected_packages"], generator: "shipment_discrepancy", trid: "shipment_scope", money: "removal_fee / COGS", evidence: "EP + scan variance", status: "generator live" },
    { family: "reimbursement_reversal", sources: ["amazon_reimbursements"], generator: "reimbursement", trid: "financial_reference", money: "amount_total", evidence: "reimbursement row", status: "generator live" },
    { family: "safet_followup", sources: ["amazon_safet_claims"], generator: "safet", trid: "safet_claim_id", money: "claim_amount", evidence: "SAFE-T row", status: "generator live" },
    { family: "settlement_refund_review", sources: ["amazon_settlements"], generator: "settlement / orbit_fra", trid: "order_id", money: "amount_total", evidence: "settlement line", status: "generator live" },
    { family: "fba_customer_return", sources: ["amazon_returns"], generator: null, trid: "planned source_evidence", money: "TBD", evidence: "FBA_RETURNS file", status: "GAP — import only" },
    { family: "fee_overcharge", sources: ["amazon_fee_preview"], generator: null, trid: "planned", money: "fee delta", evidence: "PC04 dims", status: "deferred" },
    { family: "storage_overcharge", sources: ["amazon_monthly_storage_fees"], generator: null, trid: "planned", money: "storage fee", evidence: "monthly storage row", status: "deferred" },
  ];
}

async function main(): Promise<void> {
  const runId = stamp();
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  await client.query("SET default_transaction_read_only = on");

  const ccQuarantine = (await tableExists(client, "claim_candidates"))
    ? await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='claim_candidates' AND column_name='quarantined_at'`,
      )
    : { rows: [] };
  const ccActiveFilter = ccQuarantine.rows.length ? "AND quarantined_at IS NULL" : "";

  const orgCounts = await client.query(
    `SELECT
      (SELECT count(*)::int FROM claim_candidates WHERE organization_id = $1::uuid ${ccActiveFilter}) AS claim_candidates,
      (SELECT count(*)::int FROM claim_reference_edges WHERE organization_id = $1::uuid) AS claim_reference_edges,
      (SELECT count(*)::int FROM financial_reference_resolver WHERE organization_id = $1::uuid) AS frr_rows`,
    [ORG],
  );

  const reimbSample = await pickSampleIdentifier(client, "amazon_reimbursements", 3);
  const returnSample = await pickSampleIdentifier(client, "amazon_returns", 3);
  const removalSample = await pickSampleIdentifier(client, "amazon_removals", 3);

  const product_sample_traces: Row = {
    removal_shipment_387003587: await traceProduct(client, { fnsku: SAMPLES.removal_shipment.fnsku }, ccActiveFilter),
    real_spine_B0000B11UX: await traceProduct(client, { fnsku: SAMPLES.real_spine.fnsku, asin: SAMPLES.real_spine.fnsku }, ccActiveFilter),
    reimbursement_sample: reimbSample
      ? { sample_pick: reimbSample, ...(await traceProduct(client, reimbSample, ccActiveFilter)) }
      : { note: "no grouped reimbursement rows found" },
    customer_return_sample: returnSample
      ? { sample_pick: returnSample, ...(await traceProduct(client, returnSample, ccActiveFilter)) }
      : { note: "no grouped amazon_returns rows found" },
    removal_order_sample: removalSample
      ? { sample_pick: removalSample, ...(await traceProduct(client, removalSample, ccActiveFilter)) }
      : { note: "no grouped amazon_removals rows found" },
  };

  await client.end();

  const lifecycle_coverage_matrix = lifecycleCoverageMatrix();
  const supportedNow = lifecycle_coverage_matrix.filter((r) => r.supported_now === "yes").map((r) => r.lifecycle_state);
  const missingBlockers = lifecycle_coverage_matrix
    .filter((r) => r.supported_now !== "yes")
    .map((r) => ({ state: r.lifecycle_state, blocker: r.blocker, next_phase: r.next_phase }));

  const manifest = {
    prompt: "PHASE-AMAZON-ITEM-LIFECYCLE-CLAIM-COVERAGE-AUDIT-V1",
    run_id: runId,
    mode: "read_only",
    target_ref: PRODUCTION_REF,
    organization_id: ORG,
    store_id: STORE,
    registered_generators: CLAIM_SOURCE_KINDS,
    org_pool_counts: orgCounts.rows[0],
    lifecycle_coverage_matrix,
    source_to_state_matrix: lifecycle_coverage_matrix.map((r) => ({
      source_table: r.source_table,
      lifecycle_states: [r.lifecycle_state],
      generator: r.generator,
      claim_family: r.claim_family,
    })),
    product_sample_traces,
    claim_family_matrix: claimFamilyMatrix(),
    trid_edge_requirements: [
      "product_link → products (resolved_product_id)",
      "source_evidence → source-of-truth row (return_items, amazon_*, expected_packages)",
      "shipment_scope → packages / tracking_number",
      "financial_reference → financial_reference_resolver",
      "resolves → single FRR when deterministic",
      "corroborates / supersedes → legacy_seed handling",
    ],
    money_requirements: {
      cogs_source: "product_cost_snapshots (planned) / return_items fallback in orbit",
      sale_price_context: "product_prices latest observation — never COGS",
      unknown_cost_display: "Cost unknown",
      reimbursement_observed: "amount_total on amazon_reimbursements",
      recovery_formula: "units × cogs_unit else report amount",
    },
    evidence_requirements: {
      scanner: "return_items.photo_evidence, notes, conditions",
      file_import: "raw_report_uploads lineage + source row",
      orbit: "evidence_summary template per category",
      packet_composer: "claim_evidence_packet_composer (no PDF in audit phase)",
    },
    supported_now: supportedNow,
    missing_blockers: missingBlockers,
    closest_next_claim_families_after_physical_return: [
      "removal_missing_units / removal_units_unaccounted",
      "inventory_unreconciled_loss / warehouse_lost",
      "inbound_shipment_shortage",
      "shipment_quantity_mismatch",
      "fba_customer_return (new generator needed)",
    ],
    API_file_import_gaps: [
      "amazon_returns: imported, no trusted generator",
      "amazon_fba_inventory: imported, no lifecycle read-model",
      "stranded inventory: no normalized table",
      "amazon_finances_events: archive exists, not claim-generator wired",
      "fee_preview / monthly_storage: deferred families",
      "ORBIT XLSX import: blocked_not_built per connector readmodel",
    ],
    SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL: "yes",
    SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL_note:
      "Read-only per-product quantity ledger from existing tables is safe; full claim automation for all states is not",
    NEXT_EXACT_PROMPT:
      "PHASE-AMAZON-ITEM-LIFECYCLE-READMODEL-IMPLEMENT-V1 — per-product lifecycle counters (sent/sold/returned/removal/FBA-on-hand/warehouse) from existing amazon_* + return_items; no new tables; wire Claim Center product drill-down; defer fee/stranded generators",
  };

  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# Amazon item lifecycle claim coverage audit V1",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Lifecycle states audited | **${LIFECYCLE_STATES.length}** |`,
      `| Supported now (full/partial claim path) | **${supportedNow.length}** |`,
      `| Registered generators | **${CLAIM_SOURCE_KINDS.length}** |`,
      `| FBA customer returns generator | **GAP** |`,
      `| SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL | **${manifest.SAFE_TO_IMPLEMENT_LIFECYCLE_READMODEL}** |`,
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

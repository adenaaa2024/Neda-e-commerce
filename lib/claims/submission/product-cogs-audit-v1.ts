/**
 * PHASE-PRODUCT-COGS-AUDIT-V1 — read-only COGS / cost source audit for pilot submissions.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { extractCogsOverrideUnitCost } from "./cogs-override-value-v1";
import {
  discoverMoneyLaneSourcesV1,
  type PerSubmissionSourceDiscovery,
} from "./claim-money-lane-source-discovery-v1";

export const PRODUCT_COGS_AUDIT_V1_VERSION = "product-cogs-audit-v1" as const;

export type CogsConfidence = "approved" | "interim" | "fallback" | "rejected";

export type CogsCandidate = {
  rank: number;
  source_key: string;
  source_table: string | null;
  cogs_unit: number | null;
  currency: string | null;
  effective_date: string | null;
  confidence: CogsConfidence;
  approved_for_recovery: boolean;
  note: string;
};

export type PerSubmissionCogsAudit = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  resolved_product_id: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  quantity: number | null;
  latest_sold_price: number | null;
  fee_deductions_found: boolean;
  net_settlement_amount: number | null;
  money_lane_cogs_found: boolean;
  money_lane_cogs_value: number | null;
  money_lane_cogs_source: string | null;
  cogs_unit: number | null;
  cogs_source: string | null;
  cogs_effective_date: string | null;
  currency: string | null;
  confidence: CogsConfidence | null;
  approved_for_recovery: boolean;
  recovery_value_can_be_calculated: boolean;
  recovery_value_blocked: boolean;
  blocker_reasons: string[];
  candidates: CogsCandidate[];
  rejected_candidates: CogsCandidate[];
};

export type CogsSourceTableCheck = {
  table: string;
  exists: boolean;
  row_count_org: number | null;
  note: string;
};

export type CogsFileSourceCheck = {
  report_type: string;
  upload_count: number;
  latest_upload_at: string | null;
  likely_cost_source: boolean;
  note: string;
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

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1 LIMIT 1`,
    [table],
  );
  return r.rows.length > 0;
}

async function columnExists(c: pg.Client, table: string, column: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`,
    [table, column],
  );
  return r.rows.length > 0;
}

async function orgRowCount(c: pg.Client, table: string, orgId: string): Promise<number | null> {
  if (!(await tableExists(c, table))) return null;
  const hasOrg = await columnExists(c, table, "organization_id");
  if (!hasOrg) return null;
  const r = await c.query(
    `SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1::uuid`,
    [orgId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

const COST_TABLE_SPECS: Array<{ table: string; note: string }> = [
  { table: "product_cost_snapshots", note: "Approved COGS spine (planned/applied)" },
  { table: "supplier_product_costs", note: "Purchase module unit cost (future)" },
  { table: "product_cost_layers", note: "Purchase module landed cost (future)" },
  { table: "purchase_orders", note: "PO header — vendor cost linkage (future)" },
  { table: "purchase_order_lines", note: "PO line unit cost (future)" },
  { table: "inventory_items", note: "Inventory item cost fields if present" },
  { table: "products", note: "Product scalar / metadata cost fields" },
  { table: "return_items", note: "Operational estimated_value fallback only" },
  { table: "claim_candidates", note: "Emitted cogs_unit on candidates" },
  { table: "workspace_settings", note: "module_configs.claim_intake.cogs_overrides JSON map" },
  { table: "product_prices", note: "Sale price — NEVER COGS (checked for rejection)" },
];

const COST_FILE_KEYWORDS = [
  "COGS",
  "COST",
  "SELLERSNAP",
  "ORBIT",
  "UNIT_COST",
  "LANDED",
  "VENDOR",
  "PURCHASE",
];

export async function auditCogsSourceTables(
  pgClient: pg.Client,
  organizationId: string,
): Promise<CogsSourceTableCheck[]> {
  const out: CogsSourceTableCheck[] = [];
  for (const spec of COST_TABLE_SPECS) {
    const exists = await tableExists(pgClient, spec.table);
    const row_count_org = exists ? await orgRowCount(pgClient, spec.table, organizationId) : null;
    out.push({ table: spec.table, exists, row_count_org, note: spec.note });
  }
  return out;
}

export async function auditCogsFileSources(
  client: SupabaseClient,
  organizationId: string,
): Promise<CogsFileSourceCheck[]> {
  const { data, error } = await client
    .from("raw_report_uploads")
    .select("report_type, status, created_at, file_name, metadata")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return [];

  const byType = new Map<string, CogsFileSourceCheck>();
  for (const row of data ?? []) {
    const rt = str(row.report_type) || "UNKNOWN";
    const fileName = str((row as { file_name?: unknown }).file_name).toUpperCase();
    const meta = JSON.stringify(metaRecord((row as { metadata?: unknown }).metadata)).toUpperCase();
    const likely =
      COST_FILE_KEYWORDS.some((k) => rt.toUpperCase().includes(k) || fileName.includes(k) || meta.includes(k));
    const existing = byType.get(rt);
    const created = str((row as { created_at?: unknown }).created_at);
    if (!existing) {
      byType.set(rt, {
        report_type: rt,
        upload_count: 1,
        latest_upload_at: created || null,
        likely_cost_source: likely,
        note: likely ? "Filename/metadata suggests cost/COGS content" : "Financial/report upload",
      });
    } else {
      existing.upload_count += 1;
      if (likely) existing.likely_cost_source = true;
    }
  }
  return [...byType.values()].sort((a, b) => (a.likely_cost_source === b.likely_cost_source ? 0 : a.likely_cost_source ? -1 : 1));
}

export async function loadCogsOverridesForOrg(
  client: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  // Prefer an org-scoped workspace_settings row; fall back to the canonical singleton
  // row used by the rest of the app (organization_id may be NULL on it).
  const byOrg = await client
    .from("workspace_settings")
    .select("module_configs")
    .eq("organization_id", organizationId)
    .maybeSingle();
  let moduleConfigs = metaRecord(byOrg.data?.module_configs);
  if (!byOrg.data) {
    const singleton = await client
      .from("workspace_settings")
      .select("module_configs")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    moduleConfigs = metaRecord(singleton.data?.module_configs);
  }
  const claimIntake = metaRecord(moduleConfigs.claim_intake);
  return metaRecord(claimIntake.cogs_overrides);
}

async function probeProductCostSnapshots(
  client: SupabaseClient,
  organizationId: string,
  productId: string | null,
): Promise<CogsCandidate[]> {
  if (!productId) return [];
  const { data, error } = await client
    .from("product_cost_snapshots")
    .select("id, unit_cost, currency, source_code, effective_at, updated_at")
    .eq("organization_id", organizationId)
    .eq("product_id", productId)
    .order("effective_at", { ascending: false })
    .limit(5);
  if (error) return [];

  return (data ?? []).map((row, i) => {
    const sourceCode = str((row as { source_code?: unknown }).source_code) || "unknown";
    return {
      rank: 10 + i,
      source_key: `product_cost_snapshots.${sourceCode}`,
      source_table: "product_cost_snapshots",
      cogs_unit: num((row as { unit_cost?: unknown }).unit_cost),
      currency: str((row as { currency?: unknown }).currency) || "USD",
      effective_date: str((row as { effective_at?: unknown }).effective_at) || null,
      confidence: "approved" as const,
      approved_for_recovery: num((row as { unit_cost?: unknown }).unit_cost) != null,
      note: "Approved COGS spine row",
    };
  });
}

async function probeCogsOverrides(
  cogsOverrides: Record<string, unknown>,
  sku: string | null,
  fnsku: string | null,
  asin: string | null,
): Promise<CogsCandidate[]> {
  const out: CogsCandidate[] = [];
  let rank = 1;
  for (const [id, label] of [
    [sku, "sku"],
    [fnsku, "fnsku"],
    [asin, "asin"],
  ] as const) {
    if (!id) continue;
    const v = extractCogsOverrideUnitCost(cogsOverrides[id]);
    if (v == null) continue;
    out.push({
      rank: rank++,
      source_key: `workspace_settings.claim_intake.cogs_overrides[${label}:${id}]`,
      source_table: "workspace_settings",
      cogs_unit: v,
      currency: "USD",
      effective_date: null,
      confidence: "interim",
      approved_for_recovery: true,
      note: "Manual/interim override map — approved for pilot recovery until cost spine migrates",
    });
  }
  return out;
}

async function probeClaimCandidateCogs(
  client: SupabaseClient,
  caseId: string,
): Promise<CogsCandidate[]> {
  const { data: caseRow } = await client
    .from("claim_cases")
    .select("candidate_ids, metadata")
    .eq("id", caseId)
    .maybeSingle();
  const candidateIds = Array.isArray(caseRow?.candidate_ids)
    ? (caseRow.candidate_ids as string[]).filter(Boolean)
    : [];
  if (candidateIds.length === 0) return [];

  const { data: rows } = await client
    .from("claim_candidates")
    .select("id, cogs_unit, cogs_source_code, currency, updated_at")
    .in("id", candidateIds.slice(0, 20));
  const out: CogsCandidate[] = [];
  for (const row of rows ?? []) {
    const unit = num((row as { cogs_unit?: unknown }).cogs_unit);
    if (unit == null) continue;
    const srcCode = str((row as { cogs_source_code?: unknown }).cogs_source_code);
    const approved =
      !srcCode ||
      /manual|override|sellersnap|upload|purchase|approved/i.test(srcCode) ||
      srcCode === "cogs_overrides";
    out.push({
      rank: 5,
      source_key: srcCode
        ? `claim_candidates.cogs_unit (${srcCode})`
        : "claim_candidates.cogs_unit",
      source_table: "claim_candidates",
      cogs_unit: unit,
      currency: str((row as { currency?: unknown }).currency) || "USD",
      effective_date: str((row as { updated_at?: unknown }).updated_at) || null,
      confidence: approved ? "approved" : "interim",
      approved_for_recovery: approved,
      note: approved ? "Candidate COGS from governed source code" : "Candidate COGS without trusted source code",
    });
  }
  return out;
}

async function probeReturnItemsEstimate(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string | null,
  fnsku: string | null,
): Promise<CogsCandidate[]> {
  let q = client
    .from("return_items")
    .select("id, estimated_value, currency, created_at, resolved_product_id, fnsku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .not("estimated_value", "is", null)
    .order("created_at", { ascending: false })
    .limit(3);
  if (productId) q = q.eq("resolved_product_id", productId);
  else if (fnsku) q = q.eq("fnsku", fnsku);
  else return [];

  const { data } = await q;
  const row = data?.[0];
  if (!row) return [];
  const v = num((row as { estimated_value?: unknown }).estimated_value);
  if (v == null) return [];
  return [
    {
      rank: 90,
      source_key: "return_items.estimated_value",
      source_table: "return_items",
      cogs_unit: v,
      currency: str((row as { currency?: unknown }).currency) || "USD",
      effective_date: str((row as { created_at?: unknown }).created_at) || null,
      confidence: "fallback",
      approved_for_recovery: false,
      note: "Operational warehouse estimate — not approved COGS for claim recovery",
    },
  ];
}

async function probeProductMetadataCost(
  pgClient: pg.Client,
  productId: string | null,
): Promise<CogsCandidate[]> {
  if (!productId || !(await tableExists(pgClient, "products"))) return [];
  const costCols = ["cost_price", "cost", "unit_cost", "cogs", "purchase_price", "landed_cost"];
  const present: string[] = [];
  for (const col of costCols) {
    if (await columnExists(pgClient, "products", col)) present.push(col);
  }
  if (present.length === 0) {
    const hasMeta = await columnExists(pgClient, "products", "metadata");
    if (!hasMeta) return [];
    const r = await pgClient.query(
      `SELECT metadata FROM products WHERE id=$1::uuid LIMIT 1`,
      [productId],
    );
    const meta = metaRecord(r.rows[0]?.metadata);
    const keys = ["unit_cost", "cogs", "cost", "purchase_price", "landed_cost"];
    for (const k of keys) {
      const v = num(meta[k]);
      if (v == null) continue;
      return [
        {
          rank: 40,
          source_key: `products.metadata.${k}`,
          source_table: "products",
          cogs_unit: v,
          currency: str(meta.currency) || "USD",
          effective_date: str(meta.cost_effective_date) || null,
          confidence: "interim",
          approved_for_recovery: false,
          note: "Metadata JSON cost — not governed approved spine",
        },
      ];
    }
    return [];
  }

  const select = present.join(", ");
  const r = await pgClient.query(`SELECT ${select} FROM products WHERE id=$1::uuid LIMIT 1`, [productId]);
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return [];
  const out: CogsCandidate[] = [];
  for (const col of present) {
    const v = num(row[col]);
    if (v == null) continue;
    out.push({
      rank: 35,
      source_key: `products.${col}`,
      source_table: "products",
      cogs_unit: v,
      currency: "USD",
      effective_date: null,
      confidence: "interim",
      approved_for_recovery: false,
      note: "Product scalar cost column — not in approved precedence chain unless migrated",
    });
  }
  return out;
}

async function probeRejectedSalePrice(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productId: string | null,
  latestSoldPrice: number | null,
): Promise<CogsCandidate[]> {
  const rejected: CogsCandidate[] = [];
  if (latestSoldPrice != null) {
    rejected.push({
      rank: 200,
      source_key: "latest_sold_price (money lane)",
      source_table: "amazon_reports_repository|amazon_settlements|amazon_all_orders",
      cogs_unit: latestSoldPrice,
      currency: "USD",
      effective_date: null,
      confidence: "rejected",
      approved_for_recovery: false,
      note: "Sale price is informational only — MUST NOT be used as COGS",
    });
  }
  if (!productId) return rejected;
  const { data: prices } = await client
    .from("product_prices")
    .select("amount, currency, observed_at")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .order("observed_at", { ascending: false })
    .limit(1);
  const p = prices?.[0];
  const amt = num((p as { amount?: unknown })?.amount);
  if (amt != null) {
    rejected.push({
      rank: 201,
      source_key: "product_prices.amount",
      source_table: "product_prices",
      cogs_unit: amt,
      currency: str((p as { currency?: unknown })?.currency) || "USD",
      effective_date: str((p as { observed_at?: unknown })?.observed_at) || null,
      confidence: "rejected",
      approved_for_recovery: false,
      note: "Catalog sale/list price — NEVER COGS",
    });
  }
  return rejected;
}

function pickApprovedWinner(candidates: CogsCandidate[]): CogsCandidate | null {
  const approved = candidates.filter((c) => c.approved_for_recovery && c.cogs_unit != null);
  if (approved.length === 0) return null;
  approved.sort((a, b) => a.rank - b.rank || String(b.effective_date ?? "").localeCompare(String(a.effective_date ?? "")));
  return approved[0] ?? null;
}

async function auditOneSubmission(args: {
  client: SupabaseClient;
  pgClient: pg.Client;
  organizationId: string;
  storeId: string;
  money: PerSubmissionSourceDiscovery;
  cogsOverrides: Record<string, unknown>;
}): Promise<PerSubmissionCogsAudit> {
  const { client, pgClient, organizationId, storeId, money, cogsOverrides } = args;
  const { product_identifiers: ids } = money;

  const [
    overrideCands,
    snapCands,
    candidateCands,
    returnCands,
    productMetaCands,
    rejectedCands,
  ] = await Promise.all([
    probeCogsOverrides(cogsOverrides, ids.sku, ids.fnsku, ids.asin),
    probeProductCostSnapshots(client, organizationId, ids.resolved_product_id),
    probeClaimCandidateCogs(client, money.claim_case_id),
    probeReturnItemsEstimate(client, organizationId, storeId, ids.resolved_product_id, ids.fnsku),
    probeProductMetadataCost(pgClient, ids.resolved_product_id),
    probeRejectedSalePrice(
      client,
      organizationId,
      storeId,
      ids.resolved_product_id,
      money.latest_sold_price_value,
    ),
  ]);

  const candidates = [...overrideCands, ...candidateCands, ...snapCands, ...productMetaCands, ...returnCands].sort(
    (a, b) => a.rank - b.rank,
  );
  const winner = pickApprovedWinner(candidates);

  const blocker_reasons: string[] = [];
  if (!winner) blocker_reasons.push("COGS_MISSING");
  if (!ids.resolved_product_id) blocker_reasons.push("WEAK_PRODUCT_MAPPING");
  if (overrideCands.length === 0 && snapCands.length === 0 && candidateCands.filter((c) => c.approved_for_recovery).length === 0) {
    blocker_reasons.push("NO_APPROVED_COST_SOURCE");
  }
  if (returnCands.length > 0 && !winner) blocker_reasons.push("ONLY_FALLBACK_ESTIMATE_AVAILABLE");

  const recovery_value_can_be_calculated =
    winner != null && winner.cogs_unit != null && money.quantity != null && money.quantity > 0;
  if (!recovery_value_can_be_calculated && winner == null) {
    blocker_reasons.push("RECOVERY_VALUE_BLOCKED_NO_COGS");
  }

  return {
    claim_submission_id: money.claim_submission_id,
    claim_case_id: money.claim_case_id,
    family: money.family,
    resolved_product_id: ids.resolved_product_id,
    asin: ids.asin,
    fnsku: ids.fnsku,
    sku: ids.sku,
    quantity: money.quantity,
    latest_sold_price: money.latest_sold_price_value,
    fee_deductions_found: money.fee_deductions_found,
    net_settlement_amount: money.settlement_amount,
    money_lane_cogs_found: money.cogs_found,
    money_lane_cogs_value: money.cogs_value,
    money_lane_cogs_source: money.cogs_source,
    cogs_unit: winner?.cogs_unit ?? null,
    cogs_source: winner?.source_key ?? null,
    cogs_effective_date: winner?.effective_date ?? null,
    currency: winner?.currency ?? null,
    confidence: winner?.confidence ?? null,
    approved_for_recovery: Boolean(winner?.approved_for_recovery),
    recovery_value_can_be_calculated,
    recovery_value_blocked: !recovery_value_can_be_calculated,
    blocker_reasons: [...new Set(blocker_reasons)],
    candidates,
    rejected_candidates: rejectedCands,
  };
}

export async function runProductCogsAuditV1(
  client: SupabaseClient,
  pgClient: pg.Client,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<{
  pilot_submission_count: number;
  unique_product_count: number;
  sku_fnsku_asin_matrix: Array<{
    claim_submission_id: string;
    asin: string | null;
    fnsku: string | null;
    sku: string | null;
    resolved_product_id: string | null;
  }>;
  cogs_source_tables_checked: CogsSourceTableCheck[];
  cogs_file_sources_checked: CogsFileSourceCheck[];
  cogs_coverage_count: number;
  cogs_missing_count: number;
  per_submission_cogs_matrix: PerSubmissionCogsAudit[];
  cogs_confidence_summary: Record<CogsConfidence, number>;
  approved_cost_source_found: boolean;
  recovery_value_can_be_calculated_count: number;
  recovery_value_blocked_count: number;
  blocker_reasons: string[];
  recommended_cogs_source_of_truth: string;
  migration_needed: boolean;
  import_needed: boolean;
  manual_cost_entry_needed: boolean;
}> {
  const pilotCaseRunId = str(options.pilot_case_run_id) || PILOT_CASE_RUN_ID;
  const intakeRunId = str(options.intake_run_id) || PILOT_INTAKE_RUN_ID;

  const [moneyLane, cogsOverrides, cogsTables, cogsFiles] = await Promise.all([
    discoverMoneyLaneSourcesV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    loadCogsOverridesForOrg(client, organizationId),
    auditCogsSourceTables(pgClient, organizationId),
    auditCogsFileSources(client, organizationId),
  ]);

  const per_submission_cogs_matrix: PerSubmissionCogsAudit[] = [];
  for (const money of moneyLane.per_submission) {
    per_submission_cogs_matrix.push(
      await auditOneSubmission({
        client,
        pgClient,
        organizationId,
        storeId,
        money,
        cogsOverrides,
      }),
    );
  }

  const productIds = new Set(
    per_submission_cogs_matrix.map((p) => p.resolved_product_id).filter(Boolean) as string[],
  );
  const cogs_coverage_count = per_submission_cogs_matrix.filter((p) => p.approved_for_recovery && p.cogs_unit != null).length;
  const cogs_missing_count = per_submission_cogs_matrix.length - cogs_coverage_count;

  const cogs_confidence_summary: Record<CogsConfidence, number> = {
    approved: 0,
    interim: 0,
    fallback: 0,
    rejected: 0,
  };
  for (const row of per_submission_cogs_matrix) {
    if (row.confidence) cogs_confidence_summary[row.confidence] += 1;
  }

  const allBlockers = new Set<string>();
  for (const row of per_submission_cogs_matrix) {
    for (const b of row.blocker_reasons) allBlockers.add(b);
  }

  const costSnapTable = cogsTables.find((t) => t.table === "product_cost_snapshots");
  const costSnapExists = costSnapTable?.exists ?? false;
  const costSnapRows = costSnapTable?.row_count_org ?? 0;
  const overrideKeys = Object.keys(cogsOverrides).length;
  const likelyCostFiles = cogsFiles.filter((f) => f.likely_cost_source);

  const migration_needed = !costSnapExists;
  const import_needed = costSnapRows === 0 && overrideKeys === 0;
  const manual_cost_entry_needed = cogs_coverage_count === 0;

  let recommended_cogs_source_of_truth =
    "product_cost_snapshots (approved spine) with source_code sellersnap_cogs | manual_override | upload_batch_fallback";
  if (!costSnapExists) {
    recommended_cogs_source_of_truth =
      "Interim: workspace_settings.module_configs.claim_intake.cogs_overrides keyed by fnsku/sku/asin; migrate to product_cost_snapshots after Maysam spine approval";
  } else if (costSnapRows === 0 && overrideKeys === 0) {
    recommended_cogs_source_of_truth =
      "Import SellerSnap COGS CSV or enter manual cogs_overrides per pilot FNSKU; then backfill product_cost_snapshots";
  }

  return {
    pilot_submission_count: per_submission_cogs_matrix.length,
    unique_product_count: productIds.size,
    sku_fnsku_asin_matrix: per_submission_cogs_matrix.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      asin: p.asin,
      fnsku: p.fnsku,
      sku: p.sku,
      resolved_product_id: p.resolved_product_id,
    })),
    cogs_source_tables_checked: cogsTables,
    cogs_file_sources_checked: cogsFiles,
    cogs_coverage_count,
    cogs_missing_count,
    per_submission_cogs_matrix,
    cogs_confidence_summary,
    approved_cost_source_found: cogs_coverage_count > 0,
    recovery_value_can_be_calculated_count: per_submission_cogs_matrix.filter((p) => p.recovery_value_can_be_calculated)
      .length,
    recovery_value_blocked_count: per_submission_cogs_matrix.filter((p) => p.recovery_value_blocked).length,
    blocker_reasons: [...allBlockers],
    recommended_cogs_source_of_truth,
    migration_needed,
    import_needed,
    manual_cost_entry_needed,
  };
}

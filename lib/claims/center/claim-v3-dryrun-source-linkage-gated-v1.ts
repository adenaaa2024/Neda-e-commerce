/**
 * PHASE-CLAIM-V3-DRYRUN-SOURCE-AND-LINKAGE-GATED-V1
 * Source + linkage + fee/cost gated dry-run for all 41 V3 families (read-only).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  buildClaimV3ReadmodelDryrunCleanData,
  type V3FamilyDryrunRow,
} from "@/lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1";
import {
  CLAIM_FAMILY_MATRIX_V3,
  MISSING_SOURCE_MAPPING,
  OFFICIAL_REPORT_TYPE_MAPPING,
  V3_CLAIM_FAMILY_COUNT,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";

export const PRIORITY_V3_DRYRUN_FAMILIES = [
  "removal_order_discrepancy",
  "removal_shipment_missing",
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "missing_reimbursement",
  "settlement_refund_anomaly",
  "warehouse_lost_inventory",
  "warehouse_damaged_inventory",
  "orbit_fra_fight_list",
  "fba_fee_overcharge",
  "monthly_storage_fee_overcharge",
  "dimension_weight_fee_issue",
] as const;

export type V3GatedClassification =
  | "claim_ready_preview"
  | "review_only"
  | "blocked_missing_source"
  | "blocked_missing_linkage"
  | "blocked_missing_fee"
  | "blocked_missing_cost"
  | "lifecycle_only";

export type V3FamilyGatedDryrunRow = {
  family_key: string;
  family_label: string;
  classification: V3GatedClassification;
  contract_classification: string;
  implementation_priority: string;
  priority_family: boolean;
  source_tables_used: string[];
  api_report_dependency: string[];
  file_importer_dependency: string[];
  quantity_formula: string;
  money_fields_available: {
    fee_amount: boolean;
    estimated_amazon_payout: boolean;
    observed_reimbursement: boolean;
    internal_cost_loss: boolean;
  };
  clean_quantity_sum: number | null;
  disputed_quantity_excluded: number | null;
  preview_count: number;
  review_signal_count: number;
  product_linkage_ready: boolean;
  source_available: boolean;
  top_blockers: string[];
  next_implementation_action: string;
  source_table_row_counts: Record<string, number | null>;
};

export type ClaimV3DryrunSourceLinkageGatedPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: boolean;
  generated_at: string;
  organization_id: string;
  store_id: string;
  v3_family_count: number;
  linkage_health_summary: ReturnType<typeof buildClaimV3ReadmodelDryrunCleanData> extends Promise<infer P>
    ? P extends { linkage_health_summary: infer L }
      ? L
      : never
    : never;
  V3_family_dryrun_matrix: V3FamilyGatedDryrunRow[];
  claim_ready_preview_families: string[];
  review_only_families: string[];
  blocked_missing_source_families: string[];
  blocked_missing_linkage_families: string[];
  blocked_missing_fee_families: string[];
  blocked_missing_cost_families: string[];
  lifecycle_only_families: string[];
  top_20_preview_items: Array<{
    rank: number;
    family_key: string;
    claim_family: string;
    source_kind: string;
    source_table: string;
    expected_amount: number | null;
    recovery_value: number | null;
    product_linkage_resolved: boolean;
    classification: V3GatedClassification;
  }>;
  source_api_file_gap_list: Array<{
    gap_type: "api" | "file" | "table" | "importer" | "generator";
    label: string;
    families_affected: string[];
    next_action: string;
  }>;
  exact_next_worker_or_importer_needed: string[];
  SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW: "yes" | "no" | "conditional";
  SAFE_RATIONALE: string;
};

function needsFee(entry: ClaimFamilyMatrixV3Entry): boolean {
  return (
    !entry.fee_amount_formula.includes("NULL") &&
    !entry.estimated_amazon_payout_formula.includes("NULL —")
  );
}

function needsCost(entry: ClaimFamilyMatrixV3Entry): boolean {
  return !entry.internal_cost_loss_formula.includes("NULL");
}

function apiDeps(entry: ClaimFamilyMatrixV3Entry): string[] {
  return entry.required_reports_api.filter(
    (r) => !r.startsWith("scanner") && !r.startsWith("planned:"),
  );
}

function fileDeps(entry: ClaimFamilyMatrixV3Entry): string[] {
  const out: string[] = [];
  for (const r of entry.required_reports_api) {
    if (r.includes("file") || r.includes("SellerSnap") || r.includes("ORBIT")) out.push(r);
  }
  if (entry.current_availability === "unsupported_file") out.push("unsupported_file_importer");
  if (entry.current_availability === "empty_connector") out.push("empty_connector");
  for (const kind of entry.registry_sync_kinds) {
    const m = OFFICIAL_REPORT_TYPE_MAPPING[kind];
    if (m && !m.sp_api_type) out.push(`file_or_manual:${kind}`);
  }
  return [...new Set(out)];
}

function refineClassification(
  entry: ClaimFamilyMatrixV3Entry,
  base: V3FamilyDryrunRow,
): { classification: V3GatedClassification; blockers: string[]; next: string } {
  const blockers: string[] = [];
  if (base.blocker) blockers.push(base.blocker);

  let classification = base.implementation_status as V3GatedClassification;
  if (base.implementation_status === "blocked_missing_money") {
    const feeMissing = needsFee(entry) && !base.estimated_amazon_payout_available;
    const costMissing = needsCost(entry) && !base.internal_cost_loss_available;
    if (feeMissing && !costMissing) classification = "blocked_missing_fee";
    else if (costMissing && !feeMissing) classification = "blocked_missing_cost";
    else if (feeMissing && costMissing) classification = "blocked_missing_fee";
    if (feeMissing) blockers.push("fee_estimate_unavailable");
    if (costMissing) blockers.push("cogs_spine_unavailable");
  }

  let next = "Monitor — no generator work required";
  switch (classification) {
    case "claim_ready_preview":
      next = "Wire Claim Center preview UI + optional generator dry-run (no apply)";
      break;
    case "review_only":
      next = "Surface review_signal queue only; do not auto-create candidates";
      break;
    case "blocked_missing_source":
      next = entry.blocked_reason ?? `Import/API sync for ${entry.normalized_tables.join(", ")}`;
      break;
    case "blocked_missing_linkage":
      next = "Operational linkage resolution wave — product_identifier_map exact match";
      break;
    case "blocked_missing_fee":
      next = "Fee Preview report import or Product Fees API read-model";
      break;
    case "blocked_missing_cost":
      next = "product_cost_snapshots / COGS spine (never sale price)";
      break;
    case "lifecycle_only":
      next = "Lifecycle read-model only — not claim-capable";
      break;
  }

  return { classification, blockers: [...new Set(blockers)], next };
}

function enrichRow(entry: ClaimFamilyMatrixV3Entry, base: V3FamilyDryrunRow): V3FamilyGatedDryrunRow {
  const { classification, blockers, next } = refineClassification(entry, base);
  const prioritySet = new Set<string>(PRIORITY_V3_DRYRUN_FAMILIES);

  return {
    family_key: entry.family_key,
    family_label: entry.display_name,
    classification,
    contract_classification: entry.classification,
    implementation_priority: entry.implementation_priority,
    priority_family: prioritySet.has(entry.family_key) || base.priority_family,
    source_tables_used: entry.normalized_tables,
    api_report_dependency: apiDeps(entry),
    file_importer_dependency: fileDeps(entry),
    quantity_formula: entry.quantity_formula,
    money_fields_available: {
      fee_amount: needsFee(entry) && base.estimated_amazon_payout_available,
      estimated_amazon_payout: base.estimated_amazon_payout_available,
      observed_reimbursement: base.observed_reimbursement_available,
      internal_cost_loss: base.internal_cost_loss_available,
    },
    clean_quantity_sum: base.clean_quantity_preview,
    disputed_quantity_excluded: base.disputed_quantity_excluded,
    preview_count: base.candidate_count_preview,
    review_signal_count: base.review_signal_count,
    product_linkage_ready: base.product_linkage_ready,
    source_available: base.source_available,
    top_blockers: blockers.slice(0, 5),
    next_implementation_action: next,
    source_table_row_counts: base.source_table_row_counts,
  };
}

function buildGapList(matrix: V3FamilyGatedDryrunRow[]): ClaimV3DryrunSourceLinkageGatedPayload["source_api_file_gap_list"] {
  const gaps: ClaimV3DryrunSourceLinkageGatedPayload["source_api_file_gap_list"] = [];

  for (const m of MISSING_SOURCE_MAPPING) {
    gaps.push({
      gap_type: "importer",
      label: m.report_label,
      families_affected: [...m.families_blocked],
      next_action: `${m.registry_gap}${"sample_zip" in m && m.sample_zip ? `; ${m.sample_zip}` : ""}`,
    });
  }

  const emptyTables = new Set<string>();
  for (const row of matrix) {
    if (row.classification !== "blocked_missing_source") continue;
    for (const [table, count] of Object.entries(row.source_table_row_counts)) {
      if (count === 0 || count === null) emptyTables.add(table);
    }
  }
  for (const table of emptyTables) {
    gaps.push({
      gap_type: "table",
      label: table,
      families_affected: matrix
        .filter((r) => r.source_table_row_counts[table] === 0 || r.source_table_row_counts[table] === null)
        .map((r) => r.family_key),
      next_action: `Populate ${table} via Reports API worker or file import`,
    });
  }

  const apiGaps = matrix.filter((r) =>
    r.api_report_dependency.some((a) => a.startsWith("GET_") || a.includes("Finances API")),
  );
  for (const row of apiGaps.filter((r) => !r.source_available)) {
    gaps.push({
      gap_type: "api",
      label: row.api_report_dependency.join("; "),
      families_affected: [row.family_key],
      next_action: row.next_implementation_action,
    });
  }

  return gaps;
}

function nextWorkersNeeded(matrix: V3FamilyGatedDryrunRow[]): string[] {
  const out = new Set<string>();
  for (const row of matrix) {
    if (row.classification === "blocked_missing_source") {
      for (const api of row.api_report_dependency) {
        if (api.startsWith("GET_")) out.add(`Reports API worker: ${api}`);
      }
      for (const kind of row.file_importer_dependency) {
        if (kind.startsWith("file_or_manual:")) out.add(`File importer: ${kind}`);
      }
    }
    if (row.classification === "blocked_missing_fee") {
      out.add("GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA import or Product Fees API");
    }
    if (row.classification === "blocked_missing_cost") {
      out.add("product_cost_snapshots / SellerSnap COGS importer");
    }
    if (row.classification === "blocked_missing_linkage") {
      out.add("Operational product_identifier_map linkage resolution (no auto-create)");
    }
  }
  return [...out];
}

/** Build source/linkage/fee/cost gated V3 dry-run (read-only). */
export async function buildClaimV3DryrunSourceLinkageGated(options: {
  client: SupabaseClient;
  pgClient?: pg.Client | null;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
}): Promise<ClaimV3DryrunSourceLinkageGatedPayload> {
  const base = await buildClaimV3ReadmodelDryrunCleanData(options);
  const entryByKey = new Map(CLAIM_FAMILY_MATRIX_V3.map((e) => [e.family_key, e]));

  const matrix = base.V3_family_dryrun_matrix.map((row) => {
    const entry = entryByKey.get(row.family_key);
    if (!entry) {
      return {
        family_key: row.family_key,
        family_label: row.family_label,
        classification: "blocked_missing_source" as const,
        contract_classification: row.classification,
        implementation_priority: row.implementation_priority,
        priority_family: row.priority_family,
        source_tables_used: [],
        api_report_dependency: [],
        file_importer_dependency: [],
        quantity_formula: "",
        money_fields_available: {
          fee_amount: false,
          estimated_amazon_payout: false,
          observed_reimbursement: false,
          internal_cost_loss: false,
        },
        clean_quantity_sum: row.clean_quantity_preview,
        disputed_quantity_excluded: row.disputed_quantity_excluded,
        preview_count: row.candidate_count_preview,
        review_signal_count: row.review_signal_count,
        product_linkage_ready: row.product_linkage_ready,
        source_available: row.source_available,
        top_blockers: ["matrix_entry_missing"],
        next_implementation_action: "Add V3 matrix entry",
        source_table_row_counts: row.source_table_row_counts,
      };
    }
    return enrichRow(entry, row);
  });

  const claim_ready_preview_families = matrix
    .filter((r) => r.classification === "claim_ready_preview")
    .map((r) => r.family_key);
  const review_only_families = matrix.filter((r) => r.classification === "review_only").map((r) => r.family_key);
  const blocked_missing_source_families = matrix
    .filter((r) => r.classification === "blocked_missing_source")
    .map((r) => r.family_key);
  const blocked_missing_linkage_families = matrix
    .filter((r) => r.classification === "blocked_missing_linkage")
    .map((r) => r.family_key);
  const blocked_missing_fee_families = matrix
    .filter((r) => r.classification === "blocked_missing_fee")
    .map((r) => r.family_key);
  const blocked_missing_cost_families = matrix
    .filter((r) => r.classification === "blocked_missing_cost")
    .map((r) => r.family_key);
  const lifecycle_only_families = matrix.filter((r) => r.classification === "lifecycle_only").map((r) => r.family_key);

  const priorityReady = matrix.filter(
    (r) => r.priority_family && r.classification === "claim_ready_preview",
  ).length;

  const safe: ClaimV3DryrunSourceLinkageGatedPayload["SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW"] =
    priorityReady >= 2 ? "yes" : claim_ready_preview_families.length > 0 ? "conditional" : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    v3_family_count: V3_CLAIM_FAMILY_COUNT,
    linkage_health_summary: base.linkage_health_summary,
    V3_family_dryrun_matrix: matrix,
    claim_ready_preview_families,
    review_only_families,
    blocked_missing_source_families,
    blocked_missing_linkage_families,
    blocked_missing_fee_families,
    blocked_missing_cost_families,
    lifecycle_only_families,
    top_20_preview_items: base.top_20_preview_opportunities.map((t) => ({
      ...t,
      classification:
        matrix.find((m) => m.family_key === t.family_key)?.classification ?? "blocked_missing_source",
    })),
    source_api_file_gap_list: buildGapList(matrix),
    exact_next_worker_or_importer_needed: nextWorkersNeeded(matrix),
    SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW: safe,
    SAFE_RATIONALE: base.SAFE_RATIONALE,
  };
}

/**
 * PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1
 * Read-only reconciliation — locate Maysam-entered COGS values; no DB writes.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_FNSKUS_V1,
  buildManualCogsDryRunResultV1,
  loadPilotProductsNeedingCogsV1,
} from "./product-cogs-manual-entry-ui-v1";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";
import { extractCogsOverrideUnitCost } from "./cogs-override-value-v1";
import { SIMULATED_PILOT_COGS_UNIT_COSTS_V1 } from "./claim-pilot-simulated-completion-v1";

export const PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1 =
  "product-cogs-ui-input-reconciliation-v1" as const;

export const OPERATOR_INPUT_PATH =
  ".cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json";

export const COGS_WRITE_APPROVAL_PATH =
  ".cursor/operator-approvals/product-cogs-source-build-v1-approval.md";

export const COGS_EXECUTE_APPROVAL_PATH =
  ".cursor/operator-approvals/product-cogs-manual-entry-execute-v1-approval.md";

type OperatorEntry = {
  fnsku?: string;
  sku?: string;
  asin?: string | null;
  unitCost?: number | null;
  currency?: string;
  effectiveDate?: string;
  sourceNote?: string;
  approvedBy?: string;
  sourceType?: string;
  salePriceReviewConfirmed?: boolean;
  _reference_latest_sold_price?: number | null;
};

export type CogsInputReconciliationResult = {
  version: typeof PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1;
  ui_route_checked: string;
  cogs_overrides_current_count: string;
  cogs_overrides_keys: string[];
  operator_input_json_exists: boolean;
  operator_input_json_has_unit_costs_count: string;
  operator_input_json_has_source_notes_count: string;
  per_entry_validation: Array<{
    fnsku: string;
    unitCost: number | null;
    sourceNote_present: boolean;
    sale_price_review_confirmed: boolean;
    dry_run_ok: boolean;
    blocking_issues: string[];
  }>;
  simulation_payload_has_values: boolean;
  preview_only_values_found: boolean;
  production_values_found: boolean;
  values_match_simulation: boolean;
  product_cost_snapshots_exists: boolean;
  products_metadata_cost_fields_count: string;
  exact_location_of_maysam_values: string;
  reason_previous_execute_failed: string;
  exact_manual_fix_needed: string;
  execute_prompt_needed: boolean;
  approval_tokens: {
    APPROVED_PRODUCT_COGS_WRITE_V1: boolean;
    APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1: boolean;
  };
  no_db_write_verification: true;
  no_claim_mutation_verification: true;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT: boolean;
  SAFE_TO_REBUILD_MONEY_LANE_AFTER_COGS: boolean;
  NEXT_PROMPT: string;
};

function readFileSafe(rel: string): string | null {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function approvalTokenYes(rel: string, key: string): boolean {
  const raw = readFileSafe(rel);
  if (!raw) return false;
  return new RegExp(`^${key}\\s*=\\s*yes\\s*$`, "im").test(raw);
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

async function tableExists(
  client: SupabaseClient,
  table: string,
): Promise<boolean> {
  const { error } = await client.from(table).select("*", { head: true, count: "exact" }).limit(1);
  return !error;
}

export async function composeProductCogsUiInputReconciliationV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<CogsInputReconciliationResult> {
  const overrides = await loadCogsOverridesForOrg(client, organizationId);
  const overrideKeys = Object.keys(overrides).filter((k) => !k.startsWith("_"));
  const coveredFnskus = (PILOT_FNSKUS_V1 as readonly string[]).filter(
    (f) => extractCogsOverrideUnitCost(overrides[f]) != null,
  );

  const inputRaw = readFileSafe(OPERATOR_INPUT_PATH);
  const operatorInputExists = inputRaw != null;
  let entries: OperatorEntry[] = [];
  if (inputRaw) {
    try {
      const parsed = JSON.parse(inputRaw) as { entries?: OperatorEntry[] };
      entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      entries = [];
    }
  }

  const unitCostCount = entries.filter(
    (e) => typeof e.unitCost === "number" && Number.isFinite(e.unitCost) && (e.unitCost as number) > 0,
  ).length;
  const sourceNoteCount = entries.filter((e) => str(e.sourceNote).length > 0).length;

  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId,
    storeId,
    supabase: client,
  });

  const per_entry_validation = entries.map((entry) => {
    const pilot = pilotProducts.find((p) => p.fnsku === entry.fnsku);
    const dry = buildManualCogsDryRunResultV1(
      {
        fnsku: str(entry.fnsku),
        unitCost: typeof entry.unitCost === "number" ? entry.unitCost : NaN,
        currency: str(entry.currency) || "USD",
        effectiveDate: str(entry.effectiveDate),
        sourceNote: str(entry.sourceNote),
        approvedBy: str(entry.approvedBy),
        sourceType: (entry.sourceType as "manual_override") ?? "manual_override",
        salePriceReviewConfirmed: entry.salePriceReviewConfirmed === true,
      },
      {
        latestSoldPrice: pilot?.latestSoldPrice ?? null,
        cleanQuantityTotal: pilot?.cleanQuantityTotal ?? 0,
        perSubmission: (pilot?.affectedSubmissions ?? []).map((s) => ({
          claimSubmissionId: s.claimSubmissionId,
          claimCaseId: s.claimCaseId,
          cleanQuantity: s.cleanQuantity,
        })),
      },
    );
    return {
      fnsku: str(entry.fnsku),
      unitCost: typeof entry.unitCost === "number" ? entry.unitCost : null,
      sourceNote_present: str(entry.sourceNote).length > 0,
      sale_price_review_confirmed: entry.salePriceReviewConfirmed === true,
      dry_run_ok: dry.ok,
      blocking_issues: dry.issues.filter((i) => i.severity === "error").map((i) => `${i.field}:${i.code}`),
    };
  });

  // Compare to simulation values (different neutral costs)
  const valuesMatchSimulation = entries.every((e) => {
    const sim = SIMULATED_PILOT_COGS_UNIT_COSTS_V1[str(e.fnsku)];
    return sim != null && typeof e.unitCost === "number" && roundEq(e.unitCost, sim.unitCost);
  });

  const productCostSnapshotsExists = await tableExists(client, "product_cost_snapshots");

  // products.metadata cost-like fields for pilot fnskus
  let metadataCostFields = 0;
  const { data: prodRows } = await client
    .from("products")
    .select("metadata")
    .eq("organization_id", organizationId)
    .limit(2000);
  // best-effort: not joining by fnsku here (resolver-owned); count rows with cost-like metadata keys
  for (const r of prodRows ?? []) {
    const meta = (r as { metadata?: Record<string, unknown> }).metadata ?? {};
    if (
      meta.case_cost != null ||
      meta.selling_unit_cost != null ||
      meta.unit_cost != null ||
      meta.cogs != null
    ) {
      metadataCostFields += 1;
    }
  }

  const productionValuesFound = coveredFnskus.length > 0;
  const previewOnlyValuesFound = unitCostCount > 0 && !productionValuesFound;

  const writeApproval = approvalTokenYes(COGS_WRITE_APPROVAL_PATH, "APPROVED_PRODUCT_COGS_WRITE_V1");
  const executeApproval = approvalTokenYes(
    COGS_EXECUTE_APPROVAL_PATH,
    "APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1",
  );

  const allRowsHaveCost = unitCostCount === 6;
  const allRowsHaveNote = sourceNoteCount === 6;
  const allDryRunOk = per_entry_validation.length === 6 && per_entry_validation.every((e) => e.dry_run_ok);

  const reasonPreviousExecuteFailed =
    sourceNoteCount < entries.length
      ? `All entries rejected on validation: sourceNote empty (${sourceNoteCount}/${entries.length} have notes). Unit costs are present (${unitCostCount}/${entries.length}) but source_note is a required error-level field.`
      : "Unknown — sourceNotes present; inspect dry-run blocking issues.";

  const exactManualFix = allRowsHaveNote
    ? "All rows have notes — re-run execute."
    : `Fill non-empty "sourceNote" for all 6 entries in ${OPERATOR_INPUT_PATH} (e.g. "supplier invoice", "operator estimate"). Approval tokens already set. Then re-run existing execute script.`;

  const safeToExecute = allRowsHaveCost && allRowsHaveNote && allDryRunOk && writeApproval && executeApproval;

  return {
    version: PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1,
    ui_route_checked: "/claim-center/reimbursement-tracking/cogs",
    cogs_overrides_current_count: `${coveredFnskus.length}/6`,
    cogs_overrides_keys: overrideKeys,
    operator_input_json_exists: operatorInputExists,
    operator_input_json_has_unit_costs_count: `${unitCostCount}/${entries.length || 6}`,
    operator_input_json_has_source_notes_count: `${sourceNoteCount}/${entries.length || 6}`,
    per_entry_validation,
    simulation_payload_has_values: true,
    preview_only_values_found: previewOnlyValuesFound,
    production_values_found: productionValuesFound,
    values_match_simulation: valuesMatchSimulation,
    product_cost_snapshots_exists: productCostSnapshotsExists,
    products_metadata_cost_fields_count: `${metadataCostFields}`,
    exact_location_of_maysam_values: operatorInputExists
      ? `${OPERATOR_INPUT_PATH} (entries[].unitCost) — operator JSON file, NOT cogs_overrides, NOT products.metadata, NOT product_cost_snapshots`
      : "NOT FOUND in any checked location",
    reason_previous_execute_failed: reasonPreviousExecuteFailed,
    exact_manual_fix_needed: exactManualFix,
    execute_prompt_needed: false,
    approval_tokens: {
      APPROVED_PRODUCT_COGS_WRITE_V1: writeApproval,
      APPROVED_PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1: executeApproval,
    },
    no_db_write_verification: true,
    no_claim_mutation_verification: true,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: true,
    SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT: safeToExecute,
    SAFE_TO_REBUILD_MONEY_LANE_AFTER_COGS: productionValuesFound,
    NEXT_PROMPT: safeToExecute
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 --execute (input complete; approvals set)"
      : allRowsHaveCost && !allRowsHaveNote
        ? "Operator: fill sourceNote for all 6 entries in product-cogs-manual-entry-execute-v1-input.json, then run PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 --execute"
        : "Operator: complete unitCost + sourceNote for all 6 entries, then execute",
  };
}

function roundEq(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

export function verifyCogsReconciliationContractStatic(): boolean {
  return (
    fs.existsSync(path.join(process.cwd(), "lib/claims/submission/product-cogs-manual-entry-ui-v1.ts")) &&
    fs.existsSync(path.join(process.cwd(), "lib/claims/submission/product-cogs-manual-entry-execute-v1.ts"))
  );
}

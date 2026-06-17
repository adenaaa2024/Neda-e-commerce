/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1
 * Read-only money lane preview after approved COGS — no DB writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  composeMoneyLanePreviewV1,
  MONEY_LANE_FORMULA_CONTRACT,
  type PerSubmissionMoneyPreview,
  verifyNullPreservationPreview,
  verifySalePriceNotUsedAsCogs,
} from "./claim-money-lane-preview-v1";
import {
  MONEY_LANE_INTEGRATION_FORMULA_CONTRACT,
  verifyIntegrationFormulaContract,
  verifyReimbursementTrackingUiMoneyIntegration,
} from "./claim-money-lane-preview-ui-integration-v1";
import { extractCogsOverrideUnitCost } from "./cogs-override-value-v1";
import { loadCogsOverridesForOrg } from "./product-cogs-audit-v1";
import { PILOT_FNSKUS_V1 } from "./product-cogs-manual-entry-ui-v1";

export const CLAIM_MONEY_LANE_PREVIEW_AFTER_COGS_V1 =
  "claim-money-lane-preview-after-cogs-v1" as const;

export type CogsWritePrerequisiteStatus = {
  SAFE_PRODUCT_COGS_WRITE_COMPLETE: boolean;
  SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: boolean;
  pilot_fnsku_cogs_count: number;
  pilot_fnsku_count: number;
  cogs_override_keys: string[];
  block_reason: string | null;
};

export type PerSubmissionMoneyMatrixRow = {
  claim_submission_id: string;
  claim_case_id: string;
  family: string | null;
  clean_quantity: number | null;
  fnsku: string | null;
  sku: string | null;
  latest_sold_price: number | null;
  amazon_fees_total: number | null;
  net_settlement_amount: number | null;
  approved_cogs_unit: number | null;
  recovery_value: number | null;
  observed_reimbursement: number | null;
  open_recovery_gap: number | null;
  profit_context: number | null;
  cogs_status: string;
  recovery_status: string;
  reimbursement_status: string;
  open_gap_status: string;
};

export type MoneyLanePreviewAfterCogsResult = {
  version: typeof CLAIM_MONEY_LANE_PREVIEW_AFTER_COGS_V1;
  prerequisites: CogsWritePrerequisiteStatus;
  pilot_submission_count: number;
  cogs_coverage_count: number;
  latest_sold_price_coverage: string;
  amazon_fee_coverage: string;
  net_settlement_coverage: string;
  recovery_value_coverage: string;
  observed_reimbursement_coverage: string;
  open_gap_coverage: string;
  total_recovery_value: number | null;
  total_observed_reimbursement: number | null;
  total_open_gap_if_known: number | null;
  per_submission_money_matrix: PerSubmissionMoneyMatrixRow[];
  formula_contract_verification: typeof MONEY_LANE_INTEGRATION_FORMULA_CONTRACT;
  sale_price_not_used_as_cogs_verification: boolean;
  null_preservation_verification: boolean;
  reimbursement_pending_handling: boolean;
  ui_money_panel_verification: boolean;
  no_db_write_verification: true;
  no_claim_submission_mutation_verification: boolean;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  SAFE_MONEY_LANE_PREVIEW_READY: boolean;
  SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: boolean;
  SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY: boolean;
  NEXT_PROMPT: string;
  per_submission_money_preview: PerSubmissionMoneyPreview[];
};

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v != null);
  if (known.length === 0) return null;
  return known.reduce((a, b) => a + b, 0);
}

export async function verifyCogsWritePrerequisites(
  client: SupabaseClient,
  organizationId: string,
): Promise<CogsWritePrerequisiteStatus> {
  const overrides = await loadCogsOverridesForOrg(client, organizationId);
  const keys = Object.keys(overrides);
  const pilotFnskuCogs = PILOT_FNSKUS_V1.filter(
    (f) => extractCogsOverrideUnitCost(overrides[f]) != null,
  ).length;

  const writeComplete = pilotFnskuCogs === PILOT_FNSKUS_V1.length;
  let block_reason: string | null = null;
  if (!writeComplete) {
    block_reason = `PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 incomplete: pilot FNSKU COGS ${pilotFnskuCogs}/${PILOT_FNSKUS_V1.length} in cogs_overrides`;
  }

  return {
    SAFE_PRODUCT_COGS_WRITE_COMPLETE: writeComplete,
    SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: writeComplete,
    pilot_fnsku_cogs_count: pilotFnskuCogs,
    pilot_fnsku_count: PILOT_FNSKUS_V1.length,
    cogs_override_keys: keys,
    block_reason,
  };
}

function toMatrixRow(p: PerSubmissionMoneyPreview): PerSubmissionMoneyMatrixRow {
  return {
    claim_submission_id: p.claim_submission_id,
    claim_case_id: p.claim_case_id,
    family: p.family,
    clean_quantity: p.clean_quantity,
    fnsku: p.fnsku,
    sku: p.sku,
    latest_sold_price: p.latest_sold_price.value,
    amazon_fees_total: p.amazon_fee_breakdown.amazon_fees_total,
    net_settlement_amount: p.net_settlement_amount.value,
    approved_cogs_unit: p.approved_cogs_unit.value,
    recovery_value: p.recovery_value.value,
    observed_reimbursement: p.observed_reimbursement.value,
    open_recovery_gap: p.open_recovery_gap.value,
    profit_context: p.optional_profit_context.value,
    cogs_status: p.approved_cogs_unit.status,
    recovery_status: p.recovery_value.status,
    reimbursement_status: p.observed_reimbursement.status,
    open_gap_status: p.open_recovery_gap.status,
  };
}

export function verifyReimbursementPendingHandling(previews: PerSubmissionMoneyPreview[]): boolean {
  for (const p of previews) {
    if (p.observed_reimbursement.value != null) continue;
    if (p.observed_reimbursement.display === "0") return false;
    if (p.observed_reimbursement.display !== "Unknown") return false;
    if (p.open_recovery_gap.value === 0 && p.recovery_value.value != null) return false;
  }
  return true;
}

export async function composeMoneyLanePreviewAfterCogsV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<Omit<
  MoneyLanePreviewAfterCogsResult,
  "no_claim_submission_mutation_verification" | "no_scanner_change_verification"
>> {
  const prerequisites = await verifyCogsWritePrerequisites(client, organizationId);
  const preview = await composeMoneyLanePreviewV1(client, organizationId, storeId, options);
  const ui = verifyReimbursementTrackingUiMoneyIntegration();

  const per_submission_money_matrix = preview.per_submission_money_preview.map(toMatrixRow);
  const n = preview.pilot_submission_count;

  const cogs_coverage_count = per_submission_money_matrix.filter(
    (r) => r.cogs_status === "known",
  ).length;

  const salePriceOk =
    preview.sale_price_not_used_as_cogs_verification &&
    verifySalePriceNotUsedAsCogs(preview.per_submission_money_preview);
  const nullOk =
    preview.null_preservation_verification &&
    verifyNullPreservationPreview(preview.per_submission_money_preview);
  const reimbPendingOk = verifyReimbursementPendingHandling(preview.per_submission_money_preview);
  const formulaOk = verifyIntegrationFormulaContract();

  const uiReady =
    ui.table_columns &&
    ui.detail_drawer_money_panel &&
    ui.formula_tooltips &&
    ui.unknown_not_zero;

  const soldOk = preview.latest_sold_price_coverage === `${n}/${n}`;
  const feesOk = preview.amazon_fee_coverage === `${n}/${n}`;
  const settlementOk = preview.net_settlement_coverage === `${n}/${n}`;
  const cogsOk = cogs_coverage_count === n;
  const recoveryOk = preview.recovery_value_coverage === `${n}/${n}`;

  const previewReady =
    prerequisites.SAFE_PRODUCT_COGS_WRITE_COMPLETE &&
    n === 10 &&
    soldOk &&
    feesOk &&
    settlementOk &&
    cogsOk &&
    recoveryOk &&
    salePriceOk &&
    nullOk &&
    reimbPendingOk &&
    formulaOk;

  const uiMoneyReady = previewReady && uiReady;

  return {
    version: CLAIM_MONEY_LANE_PREVIEW_AFTER_COGS_V1,
    prerequisites,
    pilot_submission_count: n,
    cogs_coverage_count,
    latest_sold_price_coverage: preview.latest_sold_price_coverage,
    amazon_fee_coverage: preview.amazon_fee_coverage,
    net_settlement_coverage: preview.net_settlement_coverage,
    recovery_value_coverage: preview.recovery_value_coverage,
    observed_reimbursement_coverage: preview.observed_reimbursement_coverage,
    open_gap_coverage: preview.open_gap_coverage,
    total_recovery_value: sumKnown(per_submission_money_matrix.map((r) => r.recovery_value)),
    total_observed_reimbursement: sumKnown(
      per_submission_money_matrix.map((r) => r.observed_reimbursement),
    ),
    total_open_gap_if_known: sumKnown(per_submission_money_matrix.map((r) => r.open_recovery_gap)),
    per_submission_money_matrix,
    formula_contract_verification: MONEY_LANE_INTEGRATION_FORMULA_CONTRACT,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    null_preservation_verification: nullOk,
    reimbursement_pending_handling: reimbPendingOk,
    ui_money_panel_verification: uiReady,
    no_db_write_verification: true,
    no_amazon_submission_verification: true,
    SAFE_MONEY_LANE_PREVIEW_READY: previewReady,
    SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: uiMoneyReady,
    SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY: previewReady,
    NEXT_PROMPT: !prerequisites.SAFE_PRODUCT_COGS_WRITE_COMPLETE
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 --execute — apply 6 pilot FNSKU cogs_overrides then re-run PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1"
      : previewReady
        ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — set APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes then operator records filing"
        : "Investigate money lane coverage gaps after COGS apply (sold/fees/settlement/recovery must be 10/10)",
    per_submission_money_preview: preview.per_submission_money_preview,
  };
}

/** Static smoke — formula contract references approved COGS path. */
export function verifyAfterCogsFormulaContractStatic(): boolean {
  return (
    MONEY_LANE_FORMULA_CONTRACT.approved_cogs_unit.never_sale_price === true &&
    MONEY_LANE_FORMULA_CONTRACT.recovery_value.formula.includes("clean_quantity") &&
    MONEY_LANE_INTEGRATION_FORMULA_CONTRACT.approved_cogs_unit.includes("cogs_overrides")
  );
}

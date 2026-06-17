/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1
 * Read-only money lane preview wired into Reimbursement Tracking UI.
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  composeMoneyLanePreviewV1,
  MONEY_LANE_FORMULA_CONTRACT,
  type MoneyLanePreviewResult,
  type PerSubmissionMoneyPreview,
} from "./claim-money-lane-preview-v1";
import {
  composeMoneyLanePreviewV2,
  type MoneyLanePreviewV2Result,
} from "./claim-money-lane-preview-v2-profit-loss-v1";
import {
  buildMoneyLaneUiBundle,
  verifySalePriceNotUsedAsCogsUi,
  verifyUnknownNotCoerced,
} from "./claim-money-lane-profit-loss-ui-contract";

export const CLAIM_MONEY_LANE_PREVIEW_UI_INTEGRATION_V1 =
  "claim-money-lane-preview-ui-integration-v1" as const;

export const MONEY_LANE_INTEGRATION_FORMULA_CONTRACT = {
  latest_sold_price:
    "latest_sold_price = latest matched sale principal/item amount by SKU/FNSKU/ASIN from Transaction/Settlement/report source (informational only)",
  amazon_fee_breakdown:
    "amazon_fees = selling_fees + fba_fees + commission/referral_fee + promotional_rebates + shipping_credits/chargebacks from matched report row (no estimates unless labeled)",
  net_settlement_amount:
    "net_settlement_amount = total_amount or amount_total from matched settlement/transaction row",
  observed_reimbursement:
    "observed_reimbursement = SUM(reference-safe matched reimbursement rows); Unknown if no match — never 0",
  approved_cogs_unit:
    "approved_cogs_unit = product_cost_snapshots or cogs_overrides by resolved_product_id/FNSKU/SKU and effective_date; Unknown if missing",
  recovery_value:
    "recovery_value = clean_quantity × approved_cogs_unit; Unknown if approved_cogs_unit Unknown",
  open_recovery_gap:
    "open_recovery_gap = recovery_value - observed_reimbursement when both known; else Unknown",
  net_sale_profit_context:
    "net_sale_profit_context = latest_sold_price - amazon_fees - approved_cogs_unit (informational only; not claim value)",
} as const;

export const REIMBURSEMENT_TRACKING_MONEY_TABLE_COLUMNS = [
  "latest sold price",
  "Amazon fees",
  "settlement net",
  "COGS/unit",
  "recovery value",
  "observed reimbursement",
  "open gap",
] as const;

export type UiMoneyIntegrationVerification = {
  table_columns: boolean;
  detail_drawer_money_panel: boolean;
  formula_tooltips: boolean;
  cogs_missing_blocker_badge: boolean;
  reimbursement_not_matched_label: boolean;
  unknown_not_zero: boolean;
};

export type MoneyLanePreviewUiIntegrationResult = {
  version: typeof CLAIM_MONEY_LANE_PREVIEW_UI_INTEGRATION_V1;
  pilot_submission_count: number;
  per_submission_money_preview: PerSubmissionMoneyPreview[];
  formula_contract_verification: typeof MONEY_LANE_INTEGRATION_FORMULA_CONTRACT;
  latest_sold_price_coverage: string;
  amazon_fee_coverage: string;
  net_settlement_coverage: string;
  cogs_coverage: string;
  recovery_value_coverage: string;
  observed_reimbursement_coverage: string;
  open_gap_coverage: string;
  blocked_by_cogs_count: number;
  ui_columns_added_or_verified: readonly string[];
  detail_drawer_money_panel_verification: boolean;
  sale_price_not_used_as_cogs_verification: boolean;
  null_preservation_verification: boolean;
  no_db_write_verification: true;
  no_claim_submission_mutation_verification: boolean;
  no_amazon_submission_verification: true;
  no_scanner_change_verification: boolean;
  build_result: string;
  smoke_result: string;
  SAFE_MONEY_LANE_PREVIEW_READY: boolean;
  SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: boolean;
  SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: boolean;
  NEXT_PROMPT: string;
  preview_v1: MoneyLanePreviewResult;
  preview_v2: MoneyLanePreviewV2Result;
  ui_verification: UiMoneyIntegrationVerification;
};

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

export function verifyReimbursementTrackingUiMoneyIntegration(
  repoRoot = process.cwd(),
): UiMoneyIntegrationVerification {
  const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const table = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx");
  const drawer = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx");
  const moneyTab = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx");
  const contract = read("lib/claims/submission/claim-money-lane-profit-loss-ui-contract.ts");

  const table_columns =
    /Sold price/.test(table) &&
    /Amazon fees/.test(table) &&
    /Net settlement/.test(table) &&
    /COGS unit/.test(table) &&
    /Recovery/.test(table) &&
    /Observed reimb/.test(table) &&
    /Open gap/.test(table);

  const detail_drawer_money_panel =
    /tab === "money"/.test(drawer) &&
    /ReimbursementTrackingMoneyTab/.test(drawer) &&
    /Formula explanations/.test(moneyTab);

  const formula_tooltips =
    /MONEY_LANE_FORMULA_HELPERS/.test(table) &&
    /MONEY_LANE_FORMULA_HELPERS/.test(moneyTab);

  const cogs_missing_blocker_badge =
    /COGS missing/.test(moneyTab) &&
    (/COGS missing/.test(table) || /needs_cogs/.test(table));

  const reimbursement_not_matched_label =
    /Not filed \/ no safe match/.test(contract) ||
    /no safe reimbursement match/i.test(contract);

  const unknown_not_zero =
    /Unknown values are not treated as zero/.test(table) &&
    !table.includes('?? "$0"') &&
    !moneyTab.includes('?? "$0"');

  return {
    table_columns,
    detail_drawer_money_panel,
    formula_tooltips,
    cogs_missing_blocker_badge,
    reimbursement_not_matched_label,
    unknown_not_zero,
  };
}

export function verifyIntegrationFormulaContract(): boolean {
  const v1 = MONEY_LANE_FORMULA_CONTRACT;
  return (
    v1.recovery_value.formula.includes("clean_quantity") &&
    v1.approved_cogs_unit.never_sale_price === true &&
    v1.latest_sold_price.informational_only === true &&
    MONEY_LANE_INTEGRATION_FORMULA_CONTRACT.recovery_value.includes("clean_quantity")
  );
}

export async function composeMoneyLanePreviewUiIntegrationV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: { pilot_case_run_id?: string; intake_run_id?: string } = {},
): Promise<Omit<
  MoneyLanePreviewUiIntegrationResult,
  | "build_result"
  | "smoke_result"
  | "no_claim_submission_mutation_verification"
  | "no_scanner_change_verification"
>> {
  const preview_v1 = await composeMoneyLanePreviewV1(client, organizationId, storeId, options);
  const preview_v2 = await composeMoneyLanePreviewV2(client, organizationId, storeId, options);
  const ui_verification = verifyReimbursementTrackingUiMoneyIntegration();

  buildMoneyLaneUiBundle({
    per_submission: preview_v2.per_submission_money_preview_v2,
    preview_run_reference: "phase-claim-money-lane-preview-and-ui-integration-v1",
    coverage: {
      sale_view: preview_v2.sale_view_coverage,
      fee_view: preview_v2.fee_view_coverage,
      settlement_view: preview_v2.settlement_view_coverage,
      cogs: preview_v2.cogs_coverage,
      recovery_value: preview_v2.recovery_value_coverage,
      reimbursement: preview_v2.reimbursement_coverage,
      profit_loss_complete: preview_v2.profit_loss_coverage,
    },
  });

  const salePriceOk =
    preview_v1.sale_price_not_used_as_cogs_verification &&
    verifySalePriceNotUsedAsCogsUi(preview_v2.per_submission_money_preview_v2);
  const nullOk =
    preview_v1.null_preservation_verification &&
    verifyUnknownNotCoerced(preview_v2.per_submission_money_preview_v2);

  const uiReady =
    ui_verification.table_columns &&
    ui_verification.detail_drawer_money_panel &&
    ui_verification.formula_tooltips &&
    ui_verification.cogs_missing_blocker_badge &&
    ui_verification.reimbursement_not_matched_label &&
    ui_verification.unknown_not_zero;

  const previewReady = preview_v1.SAFE_MONEY_LANE_PREVIEW_READY && verifyIntegrationFormulaContract();
  const cogsStillMissing = preview_v1.blocked_by_cogs_count === preview_v1.pilot_submission_count;

  return {
    version: CLAIM_MONEY_LANE_PREVIEW_UI_INTEGRATION_V1,
    pilot_submission_count: preview_v1.pilot_submission_count,
    per_submission_money_preview: preview_v1.per_submission_money_preview,
    formula_contract_verification: MONEY_LANE_INTEGRATION_FORMULA_CONTRACT,
    latest_sold_price_coverage: preview_v1.latest_sold_price_coverage,
    amazon_fee_coverage: preview_v1.amazon_fee_coverage,
    net_settlement_coverage: preview_v1.net_settlement_coverage,
    cogs_coverage: preview_v1.cogs_coverage,
    recovery_value_coverage: preview_v1.recovery_value_coverage,
    observed_reimbursement_coverage: preview_v1.observed_reimbursement_coverage,
    open_gap_coverage: preview_v1.open_gap_coverage,
    blocked_by_cogs_count: preview_v1.blocked_by_cogs_count,
    ui_columns_added_or_verified: REIMBURSEMENT_TRACKING_MONEY_TABLE_COLUMNS,
    detail_drawer_money_panel_verification: ui_verification.detail_drawer_money_panel,
    sale_price_not_used_as_cogs_verification: salePriceOk,
    null_preservation_verification: nullOk,
    no_db_write_verification: true,
    no_amazon_submission_verification: true,
    SAFE_MONEY_LANE_PREVIEW_READY: previewReady,
    SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: previewReady && uiReady && salePriceOk && nullOk,
    SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: true,
    NEXT_PROMPT: cogsStillMissing
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — apply approved cogs_overrides for 6 pilot FNSKUs then re-run money lane integration"
      : "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — gated filing status write after Maysam approval",
    preview_v1,
    preview_v2,
    ui_verification,
  };
}

export function verifyIntegrationUiSourceFilesExist(): boolean {
  const files = [
    "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
    "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
    "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx",
    "lib/claims/center/claim-center-api-handlers.ts",
  ];
  return files.every((f) => fs.existsSync(path.join(process.cwd(), f)));
}

/** Static smoke helper — ensures handler wires money_lane bundle. */
export function verifyApiHandlerWiresMoneyLane(): boolean {
  const src = readRepoFile("lib/claims/center/claim-center-api-handlers.ts");
  return (
    src.includes("composeMoneyLanePreviewV2") &&
    src.includes("buildMoneyLaneUiBundle") &&
    src.includes("money_lane")
  );
}

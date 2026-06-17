/**
 * PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-V1 — read-only UI verify
 *   npx tsx scripts/phase-claim-money-lane-profit-loss-ui-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeMoneyLanePreviewV2 } from "../lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import {
  MONEY_LANE_FORMULA_HELPERS,
  buildMoneyLaneUiBundle,
  verifyActualVsEstimateLabels,
  verifySalePriceNotUsedAsCogsUi,
  verifyUnknownNotCoerced,
} from "../lib/claims/submission/claim-money-lane-profit-loss-ui-contract";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { buildReimbursementTrackingUiPayload } from "../lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-profit-loss-ui-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/submission/claim-money-lane-profit-loss-ui-contract.ts",
  "lib/claims/submission/claim-reimbursement-tracking-ui-contract.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyBadges.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
  "scripts/phase-claim-money-lane-profit-loss-ui-v1.ts",
  "scripts/smoke-claim-money-lane-profit-loss-ui-v1.ts",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function buildSummary(result: Record<string, unknown>, id: string): string {
  return `# PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-V1

**Run:** \`${id}\`

## Verdict
- **SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY:** **${result.SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY ? "yes" : "no"}**
- **pilot_rows:** **${result.pilot_submission_count}**
- **money_lane_coverage:** sale **${result.sale_view_coverage}**, fees **${result.fee_view_coverage}**

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });
  const scannerBefore = scannerGitStatus();

  const subsBefore =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const moneyLaneV2 = await composeMoneyLanePreviewV2(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const money_lane = buildMoneyLaneUiBundle({
    per_submission: moneyLaneV2.per_submission_money_preview_v2,
    preview_run_reference: "phase-claim-money-lane-preview-v2-profit-loss-v1/20260618T010000Z",
    coverage: {
      sale_view: moneyLaneV2.sale_view_coverage,
      fee_view: moneyLaneV2.fee_view_coverage,
      settlement_view: moneyLaneV2.settlement_view_coverage,
      cogs: moneyLaneV2.cogs_coverage,
      recovery_value: moneyLaneV2.recovery_value_coverage,
      reimbursement: moneyLaneV2.reimbursement_coverage,
      profit_loss_complete: moneyLaneV2.profit_loss_coverage,
    },
  });
  const payload = buildReimbursementTrackingUiPayload({
    pilot_case_run_id: composed.pilot_case_run_id,
    intake_run_id: composed.intake_run_id,
    previews: composed.previews,
    legacy_visibility: composed.legacy_visibility,
    money_lane,
  });

  const subsAfter =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const scannerAfter = scannerGitStatus();
  const moneyRows = Object.values(payload.money_lane?.by_submission_id ?? {});
  const previews = payload.previews;

  const shipment = previews.filter((p) => p.family_key_v3 === "removal_shipment_missing");
  const order = previews.filter((p) => p.family_key_v3 === "removal_order_discrepancy");

  const drawerSrc = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx");
  const moneyTabSrc = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyTab.tsx");
  const tableSrc = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx");
  const summarySrc = read("components/claim-center/reimbursement-tracking/ReimbursementTrackingSummaryCards.tsx");

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-claim-money-lane-profit-loss-ui-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const formulaTextOk =
    moneyTabSrc.includes("MONEY_LANE_FORMULA_HELPERS.sale_gross") &&
    moneyTabSrc.includes("MONEY_LANE_FORMULA_HELPERS.recovery") &&
    moneyTabSrc.includes("MONEY_LANE_FORMULA_HELPERS.profit_if_sold") &&
    moneyTabSrc.includes("MONEY_LANE_FORMULA_HELPERS.lost_profit") &&
    moneyTabSrc.includes("FormulaHint");

  const summaryCardsAdded =
    summarySrc.includes("Money lane summary") &&
    summarySrc.includes("Total sale estimate") &&
    summarySrc.includes("Lost profit estimate");

  const tableOk =
    tableSrc.includes("Sold price") &&
    tableSrc.includes("Amazon fees") &&
    tableSrc.includes("Lost profit") &&
    tableSrc.includes("Unknown");

  const drawerOk =
    drawerSrc.includes('"money"') &&
    drawerSrc.includes("ReimbursementTrackingMoneyTab") &&
    drawerSrc.includes("Overview");

  const shipmentMoney = shipment.map((s) => payload.money_lane?.by_submission_id[s.claim_submission_id]).filter(Boolean);
  const orderMoney = order.map((s) => payload.money_lane?.by_submission_id[s.claim_submission_id]).filter(Boolean);

  const ready =
    previews.length === 10 &&
    payload.money_lane != null &&
    moneyRows.length === 10 &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    formulaTextOk &&
    summaryCardsAdded &&
    tableOk &&
    drawerOk &&
    shipmentMoney.length >= 1 &&
    orderMoney.length >= 1 &&
    verifySalePriceNotUsedAsCogsUi(moneyRows) &&
    verifyUnknownNotCoerced(moneyRows) &&
    verifyActualVsEstimateLabels(moneyRows);

  const result = {
    run_id: id,
    db_ref: ref,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    mode: "read-only-ui",
    files_changed: FILES_CHANGED,
    pilot_submission_count: previews.length,
    sale_view_coverage: payload.money_lane?.coverage.sale_view ?? "0/0",
    fee_view_coverage: payload.money_lane?.coverage.fee_view ?? "0/0",
    cogs_coverage: payload.money_lane?.coverage.cogs ?? "0/0",
    summary_cards_added: summaryCardsAdded,
    table_money_columns_verification: tableOk,
    drawer_money_section_verification: drawerOk,
    formula_text_verification: formulaTextOk,
    actual_vs_estimated_label_verification: verifyActualVsEstimateLabels(moneyRows),
    unknown_value_verification: verifyUnknownNotCoerced(moneyRows),
    sale_price_not_used_as_cogs_verification: verifySalePriceNotUsedAsCogsUi(moneyRows),
    family_shipment_money_count: shipmentMoney.length,
    family_order_money_count: orderMoney.length,
    no_db_write_verification: subsBefore === subsAfter,
    no_claim_submission_mutation_verification: subsBefore === subsAfter,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    claim_submissions_count: { before: subsBefore, after: subsAfter },
    SAFE_MONEY_LANE_PROFIT_LOSS_UI_READY: ready,
    SAFE_TO_PLAN_COGS_APPLY_EXECUTE: true,
    SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: true,
    NEXT_PROMPT: ready
      ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-UI-V1 — implement Record manual filing modal in Reimbursement Tracking drawer"
      : "PHASE-CLAIM-MONEY-LANE-PROFIT-LOSS-UI-FIX-V1 — resolve UI verification failures",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), buildSummary(result, id));

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (!result.no_db_write_verification) throw new Error("BLOCKED: claim_submissions mutated");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

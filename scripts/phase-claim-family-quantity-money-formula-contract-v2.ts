/**
 * PHASE-CLAIM-FAMILY-QUANTITY-AND-MONEY-FORMULA-CONTRACT-V2 — smoke (no DB)
 *   npx tsx scripts/phase-claim-family-quantity-money-formula-contract-v2.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_CALCULATION_HARD_RULES,
  CLAIM_FAMILY_FORMULA_MATRIX,
  CLAIM_READY_RULES_BY_FAMILY,
  CONFIDENCE_RULES_V2,
  EXCLUSION_RULES_BY_FAMILY,
  FIRST_5_FAMILIES_TO_IMPLEMENT,
  GLOBAL_FORMULA_PRIMITIVES,
  MONEY_FORMULA_BY_FAMILY_V2,
  NEXT_EXACT_PROMPT_V2,
  QUANTITY_FORMULA_BY_FAMILY_V2,
  REQUIRED_API_REPORTS_BY_FAMILY,
  REQUIRED_MANUAL_COST_INPUTS,
  REVIEW_SIGNAL_RULES_BY_FAMILY,
  SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL,
  SOURCE_JOIN_KEYS_BY_FAMILY,
  TRID_EDGE_REQUIREMENTS_V2,
  type ClaimFamilyFormulaKey,
} from "../lib/claims/contracts/claim-family-quantity-money-formula-contract-v2";

const EXPECTED: ClaimFamilyFormulaKey[] = [
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "refund_without_return",
  "wrong_item_returned",
  "empty_box_return",
  "customer_damaged_return",
  "removal_order_discrepancy",
  "removal_shipment_missing",
  "removal_damaged_during_removal",
  "disposed_without_reimbursement",
  "warehouse_lost_inventory",
  "warehouse_damaged_inventory",
  "inventory_adjustment_error",
  "inbound_shipment_shortage",
  "inbound_receiving_miscount",
  "missing_reimbursement",
  "partial_incorrect_reimbursement",
  "settlement_refund_anomaly",
  "safet_followup",
  "fba_fee_overcharge",
  "monthly_storage_fee_overcharge",
  "dimension_weight_fee_issue",
  "low_inventory_fee_issue",
  "returns_processing_fee_issue",
  "inbound_placement_fee_issue",
  "stranded_expired_review_signal",
  "orbit_fra_fight_list",
];

const OUT = ".cursor/audit-reports/phase-claim-family-quantity-money-formula-contract-v2";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const keys = CLAIM_FAMILY_FORMULA_MATRIX.map((e) => e.family_key);
  const missing = EXPECTED.filter((k) => !keys.includes(k));

  const hasAllMoneyFields = CLAIM_FAMILY_FORMULA_MATRIX.every(
    (e) =>
      e.money.actual_cost_basis &&
      e.money.estimated_amazon_reimbursement &&
      e.money.observed_reimbursement &&
      e.money.reimbursement_gap &&
      e.money.actual_loss,
  );

  const noSaleAsCogs = CLAIM_FAMILY_FORMULA_MATRIX.every(
    (e) =>
      !/\bsale_price\b.*\bactual_cost_basis\b/i.test(e.money.actual_cost_basis) &&
      e.money.sale_price_usage_rule.includes("NEVER"),
  );

  const strandedNullQty = CLAIM_FAMILY_FORMULA_MATRIX.find(
    (e) => e.family_key === "stranded_expired_review_signal",
  )?.quantity.claim_quantity.includes("NULL");

  const live = CLAIM_FAMILY_FORMULA_MATRIX.filter((e) => e.current_status === "live").length;
  const gap = CLAIM_FAMILY_FORMULA_MATRIX.filter((e) => e.current_status === "gap").length;

  const results = {
    prompt: "PHASE-CLAIM-FAMILY-QUANTITY-AND-MONEY-FORMULA-CONTRACT-V2",
    run_id: id,
    family_count: keys.length,
    missing_families: missing,
    claim_family_formula_matrix: CLAIM_FAMILY_FORMULA_MATRIX,
    quantity_formula_by_family: QUANTITY_FORMULA_BY_FAMILY_V2,
    money_formula_by_family: MONEY_FORMULA_BY_FAMILY_V2,
    source_join_keys_by_family: SOURCE_JOIN_KEYS_BY_FAMILY,
    claim_ready_rules: CLAIM_READY_RULES_BY_FAMILY,
    review_signal_rules: REVIEW_SIGNAL_RULES_BY_FAMILY,
    exclusion_rules: EXCLUSION_RULES_BY_FAMILY,
    confidence_rules: CONFIDENCE_RULES_V2,
    TRID_edge_requirements: TRID_EDGE_REQUIREMENTS_V2,
    required_API_reports: REQUIRED_API_REPORTS_BY_FAMILY,
    required_manual_cost_inputs: REQUIRED_MANUAL_COST_INPUTS,
    global_formula_primitives: GLOBAL_FORMULA_PRIMITIVES,
    hard_rules: CLAIM_CALCULATION_HARD_RULES,
    support_summary: { live, partial: keys.length - live - gap, gap, total: keys.length },
    first_5_families_to_implement: FIRST_5_FAMILIES_TO_IMPLEMENT,
    SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL,
    NEXT_EXACT_PROMPT: NEXT_EXACT_PROMPT_V2,
    contract_checks: {
      all_27_families: missing.length === 0 && keys.length === 27,
      all_money_lanes_present: hasAllMoneyFields,
      sale_price_never_cogs: noSaleAsCogs,
      stranded_signal_null_qty: strandedNullQty === true,
      no_db_writes: true,
    },
    PASS:
      missing.length === 0 &&
      keys.length === 27 &&
      hasAllMoneyFields &&
      noSaleAsCogs &&
      strandedNullQty === true,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# PHASE-CLAIM-FAMILY-QUANTITY-AND-MONEY-FORMULA-CONTRACT-V2`,
      ``,
      `**Run:** ${id}`,
      `**Families:** ${keys.length}/27`,
      `**Live:** ${live} · **Gap:** ${gap}`,
      ``,
      `**First 5:** ${FIRST_5_FAMILIES_TO_IMPLEMENT.join(", ")}`,
      ``,
      `**SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL:** ${SAFE_TO_IMPLEMENT_CLAIM_CALCULATION_READMODEL}`,
      ``,
      `Read-only — no DB writes.`,
      ``,
      `**PASS:** ${results.PASS ? "yes" : "no"}`,
    ].join("\n"),
  );

  console.log(JSON.stringify({ PASS: results.PASS, family_count: keys.length, run_id: id }, null, 2));
  if (!results.PASS) process.exit(1);
}

main();

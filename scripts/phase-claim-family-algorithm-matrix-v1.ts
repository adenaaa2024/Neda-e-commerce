/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V1 — contract smoke (no DB)
 *   npx tsx scripts/phase-claim-family-algorithm-matrix-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CLAIM_ALGORITHM_HARD_RULES,
  CLAIM_FAMILY_ALGORITHM_MATRIX,
  CONFIDENCE_RULES,
  CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES,
  CURRENT_SUPPORT_STATUS,
  DISPUTED_DATA_RULES,
  EVIDENCE_REQUIREMENT_BY_FAMILY,
  FIRST_3_FAMILIES_TO_IMPLEMENT,
  IMPLEMENTATION_PRIORITY_ORDER,
  MONEY_FORMULA_BY_FAMILY,
  NEXT_EXACT_PROMPT,
  PRODUCT_LINKAGE_REQUIREMENT_BY_FAMILY,
  QUANTITY_FORMULA_BY_FAMILY,
  REQUIRED_SOURCES_BY_FAMILY,
  SAFE_TO_IMPLEMENT_CLAIM_ALGORITHM_READMODEL,
  TRID_EDGE_REQUIREMENT_BY_FAMILY,
  type ClaimFamilyAlgorithmKey,
} from "../lib/claims/contracts/claim-family-algorithm-matrix-v1";

const EXPECTED_FAMILIES: ClaimFamilyAlgorithmKey[] = [
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "refund_without_return",
  "wrong_item_returned",
  "empty_box_return",
  "customer_damaged_return",
  "removal_order_discrepancy",
  "removal_shipment_missing_damaged",
  "disposed_without_reimbursement",
  "warehouse_lost_inventory",
  "warehouse_damaged_inventory",
  "inventory_adjustment_error",
  "inbound_shipment_shortage",
  "inbound_receiving_miscount",
  "reimbursement_missing",
  "reimbursement_partial_incorrect",
  "settlement_refund_anomaly",
  "safet_followup",
  "fba_fee_overcharge",
  "monthly_storage_fee_overcharge",
  "dimension_weight_fee_issue",
  "stranded_expired_review_signal",
  "orbit_fra_fight_list",
];

const OUT_BASE = ".cursor/audit-reports/phase-claim-family-algorithm-matrix-v1";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const keys = CLAIM_FAMILY_ALGORITHM_MATRIX.map((e) => e.family_key);
  const missing = EXPECTED_FAMILIES.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !EXPECTED_FAMILIES.includes(k));

  const liveCount = CLAIM_FAMILY_ALGORITHM_MATRIX.filter((e) => e.current_implementation_status === "live").length;
  const gapCount = CLAIM_FAMILY_ALGORITHM_MATRIX.filter((e) => e.current_implementation_status === "gap").length;

  const salePriceNeverCogs = CLAIM_FAMILY_ALGORITHM_MATRIX.every((e) => e.sale_price_display_only === true);
  const forbiddenCogsPatterns = [/sale_price\s*×/i, /sale_price\s+as\s+cogs/i, /×\s*sale_price/i];
  const noSalePriceAsCogs = CLAIM_FAMILY_ALGORITHM_MATRIX.every(
    (e) => !forbiddenCogsPatterns.some((re) => re.test(e.actual_loss_formula)),
  );

  const results = {
    prompt: "PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V1",
    run_id: runId,
    family_count: keys.length,
    missing_families: missing,
    extra_families: extra,
    claim_family_algorithm_matrix: CLAIM_FAMILY_ALGORITHM_MATRIX,
    quantity_formula_by_family: QUANTITY_FORMULA_BY_FAMILY,
    money_formula_by_family: MONEY_FORMULA_BY_FAMILY,
    required_sources_by_family: REQUIRED_SOURCES_BY_FAMILY,
    product_linkage_requirement_by_family: PRODUCT_LINKAGE_REQUIREMENT_BY_FAMILY,
    TRID_edge_requirement_by_family: TRID_EDGE_REQUIREMENT_BY_FAMILY,
    evidence_requirement_by_family: EVIDENCE_REQUIREMENT_BY_FAMILY,
    disputed_data_rules: DISPUTED_DATA_RULES,
    confidence_rules: CONFIDENCE_RULES,
    create_candidate_vs_review_signal_rules: CREATE_CANDIDATE_VS_REVIEW_SIGNAL_RULES,
    hard_rules: CLAIM_ALGORITHM_HARD_RULES,
    current_support_status: CURRENT_SUPPORT_STATUS,
    implementation_priority: IMPLEMENTATION_PRIORITY_ORDER,
    support_summary: { live: liveCount, gap: gapCount, total: keys.length },
    first_3_families_to_implement: FIRST_3_FAMILIES_TO_IMPLEMENT,
    SAFE_TO_IMPLEMENT_CLAIM_ALGORITHM_READMODEL,
    NEXT_EXACT_PROMPT,
    contract_checks: {
      all_23_families_present: missing.length === 0 && keys.length === 23,
      sale_price_display_only_all: salePriceNeverCogs,
      actual_loss_never_uses_sale_price_as_cogs: noSalePriceAsCogs,
      no_db_writes: true,
    },
    PASS: missing.length === 0 && keys.length === 23 && salePriceNeverCogs && noSalePriceAsCogs,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V1`,
      ``,
      `**Run:** ${runId}`,
      `**Families:** ${keys.length}/23`,
      `**Live:** ${liveCount} · **Gap:** ${gapCount}`,
      ``,
      `**First 3 to implement:** ${FIRST_3_FAMILIES_TO_IMPLEMENT.join(", ")}`,
      ``,
      `**SAFE_TO_IMPLEMENT_CLAIM_ALGORITHM_READMODEL:** ${SAFE_TO_IMPLEMENT_CLAIM_ALGORITHM_READMODEL}`,
      ``,
      `Read-only contract — no DB writes.`,
      ``,
      `**PASS:** ${results.PASS ? "yes" : "no"}`,
    ].join("\n"),
  );

  console.log(JSON.stringify({ PASS: results.PASS, family_count: keys.length, run_id: runId }, null, 2));
  if (!results.PASS) process.exit(1);
}

main();

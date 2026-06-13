/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V3-OFFICIAL-AMAZON-COVERAGE — smoke (no DB)
 *   npx tsx scripts/phase-claim-family-algorithm-matrix-v3-official-amazon-coverage.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { AMAZON_REPORT_REGISTRY } from "../lib/pipeline/amazon-report-registry";
import {
  ADDED_FAMILIES_V3,
  CLAIM_FAMILY_MATRIX_V3,
  CLAIM_VS_REVIEW_SIGNAL_DECISIONS_V3,
  FEE_ADJUSTED_PAYOUT_RULE_BY_FAMILY_V3,
  FIRST_SAFE_5_FAMILIES_V3,
  IMPLEMENTATION_PRIORITY_V3,
  MISSING_SOURCE_MAPPING,
  MONEY_FORMULA_BY_FAMILY_V3,
  NEXT_EXACT_PROMPT_V3,
  OFFICIAL_REPORT_TYPE_MAPPING,
  QUANTITY_FORMULA_BY_FAMILY_V3,
  REGISTRY_COVERAGE_AUDIT,
  REMOVED_OR_MERGED_FAMILIES,
  SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL,
  V3_ADDED_COUNT,
  V3_CLAIM_FAMILY_COUNT,
} from "../lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";

const V1_REVIEWED_KEYS = [
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "refund_without_return",
  "wrong_item_returned",
  "empty_box_return",
  "customer_damaged_return",
  "removal_order_discrepancy",
  "disposed_without_reimbursement",
  "warehouse_lost_inventory",
  "warehouse_damaged_inventory",
  "inventory_adjustment_error",
  "inbound_shipment_shortage",
  "inbound_receiving_miscount",
  "settlement_refund_anomaly",
  "safet_followup",
  "fba_fee_overcharge",
  "monthly_storage_fee_overcharge",
  "dimension_weight_fee_issue",
  "stranded_expired_review_signal",
  "orbit_fra_fight_list",
] as const;

const OUT = ".cursor/audit-reports/phase-claim-family-algorithm-matrix-v3-official-amazon-coverage";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const keys = CLAIM_FAMILY_MATRIX_V3.map((e) => e.family_key);
  const unique = new Set(keys);

  const v1ReviewedPresent = V1_REVIEWED_KEYS.filter((k) => keys.includes(k));
  const v1ReviewedMissing = V1_REVIEWED_KEYS.filter((k) => !keys.includes(k));

  const claimFamilies = CLAIM_FAMILY_MATRIX_V3.filter(
    (e) => e.classification === "claim_family" || e.classification === "claim_family_when_source_available",
  ).length;
  const reviewSignals = CLAIM_FAMILY_MATRIX_V3.filter((e) => e.classification === "review_signal_only").length;
  const lifecycle = CLAIM_FAMILY_MATRIX_V3.filter(
    (e) => e.classification === "lifecycle_only" || e.classification === "lifecycle_grouping_only",
  ).length;

  const forbiddenCogs = [/sale_price\s*as\s+cogs/i, /sale_price\s*×/i];
  const noSalePriceCogs = CLAIM_FAMILY_MATRIX_V3.every(
    (e) => !forbiddenCogs.some((re) => re.test(e.internal_cost_loss_formula)),
  );

  const addedV3Present = ADDED_FAMILIES_V3.every((k) => keys.includes(k));

  const failures: string[] = [];
  if (keys.length !== V3_CLAIM_FAMILY_COUNT) failures.push(`count ${keys.length} != ${V3_CLAIM_FAMILY_COUNT}`);
  if (unique.size !== keys.length) failures.push("duplicate family keys");
  if (v1ReviewedMissing.length) failures.push(`v1 reviewed missing: ${v1ReviewedMissing.join(", ")}`);
  if (!addedV3Present) failures.push("V3 added families missing from matrix");
  if (!noSalePriceCogs) failures.push("sale_price as COGS detected");
  if (SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL !== "yes") failures.push("SAFE flag not yes");

  const registryTables = new Set(
    Object.values(AMAZON_REPORT_REGISTRY)
      .map((e) => e.sync_target_table)
      .filter(Boolean),
  );

  const results = {
    prompt: "PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V3-OFFICIAL-AMAZON-COVERAGE",
    run_id: id,
    V3_claim_family_count: V3_CLAIM_FAMILY_COUNT,
    actual_family_count: keys.length,
    V3_added_count: V3_ADDED_COUNT,
    added_families: ADDED_FAMILIES_V3,
    removed_or_merged_families: REMOVED_OR_MERGED_FAMILIES,
    claim_vs_review_signal_decisions: CLAIM_VS_REVIEW_SIGNAL_DECISIONS_V3,
    classification_counts: { claim_families: claimFamilies, review_signals: reviewSignals, lifecycle },
    complete_claim_family_matrix: CLAIM_FAMILY_MATRIX_V3,
    official_report_type_mapping: OFFICIAL_REPORT_TYPE_MAPPING,
    missing_source_mapping: MISSING_SOURCE_MAPPING,
    quantity_formula_by_family: QUANTITY_FORMULA_BY_FAMILY_V3,
    money_formula_by_family: MONEY_FORMULA_BY_FAMILY_V3,
    fee_adjusted_payout_rule_by_family: FEE_ADJUSTED_PAYOUT_RULE_BY_FAMILY_V3,
    implementation_priority: IMPLEMENTATION_PRIORITY_V3,
    first_safe_5_families: FIRST_SAFE_5_FAMILIES_V3,
    SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL: SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL,
    NEXT_EXACT_PROMPT: NEXT_EXACT_PROMPT_V3,
    registry_coverage_audit: REGISTRY_COVERAGE_AUDIT,
    registry_normalized_tables: [...registryTables].sort(),
    v1_reviewed_present: v1ReviewedPresent,
    v1_reviewed_missing: v1ReviewedMissing,
    failures,
    pass: failures.length === 0,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V3-OFFICIAL-AMAZON-COVERAGE

**Run:** ${id}
**Pass:** ${results.pass ? "YES" : "NO"}

## V3 claim family count
**${V3_CLAIM_FAMILY_COUNT}** (${claimFamilies} claim-capable, ${reviewSignals} review signals, ${lifecycle} lifecycle)

## V3 additions (+${V3_ADDED_COUNT})
${ADDED_FAMILIES_V3.map((k) => `- \`${k}\``).join("\n")}

## First safe 5
${FIRST_SAFE_5_FAMILIES_V3.map((k) => `- \`${k}\``).join("\n")}

## SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL
**${SAFE_TO_IMPLEMENT_V3_CLAIM_READMODEL}**

## Missing source gaps
${MISSING_SOURCE_MAPPING.length} registry/report gaps documented

## NEXT_EXACT_PROMPT
${NEXT_EXACT_PROMPT_V3}

${failures.length ? `## Failures\n${failures.map((f) => `- ${f}`).join("\n")}` : ""}
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }
  console.log(`PASS V3 matrix — ${V3_CLAIM_FAMILY_COUNT} families, run ${id}`);
}

main();

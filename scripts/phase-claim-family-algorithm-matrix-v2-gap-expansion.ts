/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V2-GAP-EXPANSION — smoke (no DB)
 *   npx tsx scripts/phase-claim-family-algorithm-matrix-v2-gap-expansion.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { CLAIM_FAMILY_FORMULA_MATRIX } from "../lib/claims/contracts/claim-family-quantity-money-formula-contract-v2";
import {
  ADDED_OR_RECLASSIFIED_FAMILIES,
  CLAIM_FAMILY_FORMULA_MATRIX_V2_FULL,
  CLAIM_VS_REVIEW_SIGNAL_DECISIONS,
  FIRST_SAFE_NEW_FAMILY_TO_IMPLEMENT,
  FORMULA_BY_NEW_FAMILY,
  GAP_FAMILY_EVALUATIONS,
  IMPLEMENTATION_PRIORITY_GAP,
  NEXT_PROMPT_GAP,
  REQUIRED_SOURCES_GAP,
  SAFE_TO_IMPLEMENT_V2_READMODEL,
  SOURCE_AVAILABILITY_GAP,
  V2_BASE_FAMILY_COUNT,
  V2_FAMILY_COUNT,
  V2_GAP_ADDED_COUNT,
} from "../lib/claims/contracts/claim-family-matrix-v2-gap-expansion";

const EXPECTED_EVALUATIONS = [
  "low_inventory_level_fee_issue",
  "returns_processing_fee_overcharge",
  "inbound_placement_fee_issue",
  "fba_grade_and_resell_anomaly",
  "replacement_mismatch_without_reimbursement",
  "reserved_inventory_stuck_signal",
  "available_fba_discrepancy",
  "stranded_inventory_signal",
  "expired_inventory_action_signal",
  "catalog_listing_fee_category_mismatch",
] as const;

const OUT = ".cursor/audit-reports/phase-claim-family-algorithm-matrix-v2-gap-expansion";

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

  const evalKeys = GAP_FAMILY_EVALUATIONS.map((e) => e.evaluation_key);
  const missingEvals = EXPECTED_EVALUATIONS.filter((k) => !evalKeys.includes(k));

  const baseLen = CLAIM_FAMILY_FORMULA_MATRIX.length;
  const fullLen = CLAIM_FAMILY_FORMULA_MATRIX_V2_FULL.length;
  const gapLen = fullLen - baseLen;

  const claimWhenAvailable = Object.entries(CLAIM_VS_REVIEW_SIGNAL_DECISIONS).filter(
    ([, v]) => v === "claim_family_when_source_available",
  ).length;
  const reviewOnly = Object.entries(CLAIM_VS_REVIEW_SIGNAL_DECISIONS).filter(
    ([, v]) => v === "review_signal_only",
  ).length;

  const forbiddenCogs = [/sale_price\s*×/i, /sale_price\s+as\s+cogs/i];
  const noSalePriceCogs = CLAIM_FAMILY_FORMULA_MATRIX_V2_FULL.every(
    (e) =>
      !forbiddenCogs.some((re) => re.test(e.money.actual_loss)) &&
      !forbiddenCogs.some((re) => re.test(e.money.estimated_amazon_reimbursement ?? "")),
  );

  const signalFamiliesNeverAutoClaim = GAP_FAMILY_EVALUATIONS.filter(
    (e) => e.classification === "review_signal_only",
  ).every((e) => e.quantity_formula.includes("NULL") || e.amount_formula.includes("NULL"));

  const failures: string[] = [];
  if (missingEvals.length) failures.push(`missing evaluations: ${missingEvals.join(", ")}`);
  if (baseLen !== V2_BASE_FAMILY_COUNT) failures.push(`base count ${baseLen} != ${V2_BASE_FAMILY_COUNT}`);
  if (gapLen !== V2_GAP_ADDED_COUNT) failures.push(`gap count ${gapLen} != ${V2_GAP_ADDED_COUNT}`);
  if (fullLen !== V2_FAMILY_COUNT) failures.push(`full count ${fullLen} != ${V2_FAMILY_COUNT}`);
  if (!noSalePriceCogs) failures.push("sale_price used as COGS in matrix");
  if (!signalFamiliesNeverAutoClaim) failures.push("review signals must not define claim money");
  if (SAFE_TO_IMPLEMENT_V2_READMODEL !== "yes") failures.push("SAFE_TO_IMPLEMENT_V2_READMODEL not yes");

  const results = {
    prompt: "PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V2-GAP-EXPANSION",
    run_id: id,
    added_or_reclassified_families: ADDED_OR_RECLASSIFIED_FAMILIES,
    V2_family_count: V2_FAMILY_COUNT,
    V2_base_family_count: V2_BASE_FAMILY_COUNT,
    V2_gap_added_count: V2_GAP_ADDED_COUNT,
    claim_vs_review_signal_decisions: CLAIM_VS_REVIEW_SIGNAL_DECISIONS,
    claim_family_when_source_available_count: claimWhenAvailable,
    review_signal_only_count: reviewOnly,
    formula_by_new_family: FORMULA_BY_NEW_FAMILY,
    required_sources: REQUIRED_SOURCES_GAP,
    source_availability: SOURCE_AVAILABILITY_GAP,
    implementation_priority: IMPLEMENTATION_PRIORITY_GAP,
    first_safe_new_family_to_implement: FIRST_SAFE_NEW_FAMILY_TO_IMPLEMENT,
    SAFE_TO_IMPLEMENT_V2_READMODEL: SAFE_TO_IMPLEMENT_V2_READMODEL,
    NEXT_PROMPT: NEXT_PROMPT_GAP,
    gap_family_evaluations: GAP_FAMILY_EVALUATIONS,
    failures,
    pass: failures.length === 0,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-FAMILY-ALGORITHM-MATRIX-V2-GAP-EXPANSION

**Run:** ${id}
**Pass:** ${results.pass ? "YES" : "NO"}

## V2 family count
- Base (formula V2): **${V2_BASE_FAMILY_COUNT}**
- Gap added: **${V2_GAP_ADDED_COUNT}**
- **Full V2: ${V2_FAMILY_COUNT}**

## Claim vs review
- Claim when source available: **${claimWhenAvailable}**
- Review signal only: **${reviewOnly}**

## First safe new family
\`${FIRST_SAFE_NEW_FAMILY_TO_IMPLEMENT}\`

## SAFE_TO_IMPLEMENT_V2_READMODEL
**${SAFE_TO_IMPLEMENT_V2_READMODEL}**

## NEXT_PROMPT
${NEXT_PROMPT_GAP}

${failures.length ? `## Failures\n${failures.map((f) => `- ${f}`).join("\n")}` : ""}
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }
  console.log(`PASS gap expansion smoke — ${V2_FAMILY_COUNT} families, run ${id}`);
}

main();

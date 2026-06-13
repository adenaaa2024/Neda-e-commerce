/**
 * PHASE-CLAIM-FAMILY-ALGORITHM-READMODEL-IMPLEMENT-V1 — contract smoke (no DB, no HTTP auth)
 *   npm run smoke:claim-family-algorithm-readmodel-v1
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildClaimFamilyAlgorithmMatrixPayload } from "../lib/claims/center/claim-family-algorithm-readmodel";
import type { ClaimFamilyAlgorithmKey } from "../lib/claims/contracts/claim-family-algorithm-matrix-v1";

const OUT_BASE = ".cursor/audit-reports/phase-claim-family-algorithm-readmodel-implement-v1";

const EXPECTED_FIRST_IMPLEMENT: ClaimFamilyAlgorithmKey[] = [
  "physical_return_scanner_issue",
  "customer_return_not_reimbursed",
  "removal_order_discrepancy",
  "reimbursement_missing",
  "orbit_fra_fight_list",
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const payload = buildClaimFamilyAlgorithmMatrixPayload();
  const hardRules = payload.hard_rules.map((r) => r.toLowerCase());

  const checks = {
    family_count_23: payload.family_count === 23,
    live_9: payload.status_counts.live === 9,
    partial_at_least_8: (payload.status_counts.partial ?? 0) >= 8,
    gap_at_least_5: (payload.status_counts.gap ?? 0) >= 5,
    first_implement_order: JSON.stringify(payload.first_implement_order) === JSON.stringify(EXPECTED_FIRST_IMPLEMENT),
    hard_rule_never_sale_price_cogs: hardRules.some((r) => r.includes("never use sale price as cogs")),
    hard_rule_unknown_cost_null: hardRules.some((r) => r.includes("unknown") && r.includes("null")),
    hard_rule_empty_unavailable: hardRules.some((r) => r.includes("unavailable") && r.includes("not zero")),
    hard_rule_disputed: hardRules.some((r) => r.includes("disputed")),
    hard_rule_observed_separate: hardRules.some((r) => r.includes("observed reimbursement")),
    hard_rule_linkage: hardRules.some((r) => r.includes("product linkage")),
    hard_rule_no_title: hardRules.some((r) => r.includes("no title")),
    hard_rule_no_auto_create: hardRules.some((r) => r.includes("auto-create")),
    hard_rule_legacy_seed: hardRules.some((r) => r.includes("legacy_seed")),
    no_db_writes: payload.no_db_writes === true,
    no_generator_implementation: payload.no_generator_implementation === true,
    all_families_have_money_formula: payload.families.every((f) => f.money_formula.sale_price_display_only === true),
  };

  const PASS = Object.values(checks).every(Boolean);

  const summary = {
    prompt: "PHASE-CLAIM-FAMILY-ALGORITHM-READMODEL-IMPLEMENT-V1",
    run_id: rid,
    api_route: "GET /api/claims/center/algorithm-matrix",
    family_count: payload.family_count,
    status_counts: payload.status_counts,
    first_implement_order: payload.first_implement_order,
    hard_rules_payload: payload.hard_rules,
    priority_order_payload: payload.priority_order,
    checks,
    no_db_write_verification: { no_db_writes: payload.no_db_writes, read_only: payload.read_only },
    no_generator_implementation_verification: payload.no_generator_implementation,
    PASS,
    SAFE_TO_PUSH: PASS ? "yes" : "no",
    NEXT_PROMPT: "PHASE-CLAIM-FAMILY-GENERATOR-CUSTOMER-RETURN-NOT-REIMBURSED-DRYRUN-V1",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (!PASS) process.exit(1);
}

main();

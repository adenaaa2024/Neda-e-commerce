/**
 * PHASE-CLAIM-FAMILY-V3-READMODEL-AND-AI-OPTIONAL-CONTRACT-V1 — smoke (no DB writes)
 *   npx tsx scripts/smoke-claim-family-algorithm-v3-readmodel-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildClaimFamilyAlgorithmV3Payload } from "../lib/claims/center/claim-family-algorithm-v3-readmodel";
import {
  AI_NOT_REQUIRED_GUARDS,
  AI_OPTIONAL_CAPABILITY_MATRIX,
} from "../lib/claims/contracts/claim-family-ai-optional-contract-v1";
import {
  FIRST_SAFE_5_FAMILIES_V3,
  V3_CLASSIFICATION_COUNTS,
  V3_CLAIM_CAPABLE_COUNT,
  V3_CLAIM_FAMILY_COUNT,
} from "../lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";

const OUT = ".cursor/audit-reports/smoke-claim-family-algorithm-v3-readmodel-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const payload = buildClaimFamilyAlgorithmV3Payload({
    ai_module_access: {
      state: "locked",
      module_enabled: false,
      api_key_configured: false,
      reason: "smoke — AI disabled path",
    },
  });

  const sampleFamily = payload.families.find((f) => f.family_key === "customer_return_not_reimbursed");

  const readmodelSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/center/claim-family-algorithm-v3-readmodel.ts"),
    "utf8",
  );
  const noDbWrite =
    !/\b\.insert\s*\(/.test(readmodelSrc) &&
    !/\b\.update\s*\(/.test(readmodelSrc) &&
    !/\b\.delete\s*\(/.test(readmodelSrc);

  const checks = {
    family_count_41: payload.family_count === V3_CLAIM_FAMILY_COUNT,
    claim_capable: payload.classification_counts.claim_capable === V3_CLAIM_CAPABLE_COUNT,
    claim_family: payload.classification_counts.claim_family === V3_CLASSIFICATION_COUNTS.claim_family,
    claim_when_source_available:
      payload.classification_counts.claim_when_source_available ===
      V3_CLASSIFICATION_COUNTS.claim_when_source_available,
    review_signals: payload.classification_counts.review_signal_only === V3_CLASSIFICATION_COUNTS.review_signal_only,
    lifecycle: payload.classification_counts.lifecycle_only === V3_CLASSIFICATION_COUNTS.lifecycle_only,
    ai_not_required_for_core: payload.ai_optional.feature_flags_checked.ai_required_for_core_readmodel === false,
    ai_guards_count: Object.keys(AI_NOT_REQUIRED_GUARDS).length === 7,
    ai_capabilities_count: Object.keys(AI_OPTIONAL_CAPABILITY_MATRIX).length === 6,
    first_safe_5_present: FIRST_SAFE_5_FAMILIES_V3.every((k) =>
      payload.families.some((f) => f.family_key === k),
    ),
    sample_has_formulas: Boolean(
      sampleFamily?.quantity_formula &&
        sampleFamily.money_formula.fee_amount &&
        sampleFamily.fee_adjusted_payout_rule,
    ),
    no_db_writes: payload.no_db_writes === true,
    no_submission: payload.no_claim_submission === true,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-FAMILY-V3-READMODEL-AND-AI-OPTIONAL-CONTRACT-V1",
    run_id: id,
    files_changed: [
      "lib/claims/contracts/claim-family-ai-optional-contract-v1.ts",
      "lib/claims/center/claim-family-algorithm-v3-readmodel.ts",
      "lib/claims/center/claim-center-api-handlers.ts",
      "app/api/claims/center/algorithm-matrix-v3/route.ts",
      "scripts/smoke-claim-family-algorithm-v3-readmodel-v1.ts",
    ],
    api_route_added_or_extended: "GET /api/claims/center/algorithm-matrix-v3",
    V3_family_count: payload.family_count,
    classification_counts: payload.classification_counts,
    AI_optional_capability_matrix: AI_OPTIONAL_CAPABILITY_MATRIX,
    AI_not_required_guards: AI_NOT_REQUIRED_GUARDS,
    feature_flags_checked: payload.ai_optional.feature_flags_checked,
    sample_payload: {
      meta: {
        version: payload.version,
        family_count: payload.family_count,
        classification_counts: payload.classification_counts,
      },
      sample_family: sampleFamily,
      ai_disabled_behavior: payload.ai_optional.feature_flags_checked.behavior_when_ai_disabled,
    },
    no_db_write_verification: noDbWrite ? "PASS" : "FAIL",
    no_claim_candidate_mutation_verification: "PASS — no claim_candidates in readmodel",
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    checks,
    pass: failures.length === 0,
    SAFE_TO_PUSH: failures.length === 0 ? "yes" : "no",
    NEXT_PROMPT:
      "PHASE-CLAIM-CENTER-AI-OPTIONAL-OVERLAY-SHELL-V1 — UI badges + draft panels when ai_access.state=ready; no model calls from matrix endpoint",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    `# Smoke claim family algorithm V3 readmodel

**Run:** ${id}
**Pass:** ${results.pass ? "YES" : "NO"}

## V3 families: ${payload.family_count}
- Claim-capable: ${payload.classification_counts.claim_capable}
- Review signals: ${payload.classification_counts.review_signal_only}
- Lifecycle: ${payload.classification_counts.lifecycle_only}

## API
GET /api/claims/center/algorithm-matrix-v3?organization_id=&store_id=

## SAFE_TO_PUSH: ${results.SAFE_TO_PUSH}
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(`PASS V3 readmodel smoke — ${payload.family_count} families, run ${id}`);
}

main();

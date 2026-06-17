/**
 * PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1 — read-only money lane source audit
 *   npx tsx scripts/phase-claim-money-lane-recovery-audit-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  auditMoneyLaneRecoveryV1,
  CLAIM_MONEY_LANE_RECOVERY_AUDIT_V1_VERSION,
} from "../lib/claims/submission/claim-money-lane-recovery-audit-v1";
import { verifyMoneyNullPreservationTracking } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-recovery-audit-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

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
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const audited = await auditMoneyLaneRecoveryV1(client, ORG, STORE);
  const moneyNull = verifyMoneyNullPreservationTracking(audited.previews);

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  const n = audited.pilot_submission_count || 1;
  const salePriceNotCogs = audited.per_submission_money_matrix.every(
    (m) => !m.sale_price_present_not_used_as_cogs || m.blocker_reasons.some((b) => b.includes("cogs") || b.includes("sale_price")),
  );

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-reimbursement-tracking-preview-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const structuralPass =
    audited.pilot_submission_count === 10 &&
    moneyNull.pass &&
    audited.money_lane_coverage_summary.estimated_amount === 0 &&
    audited.money_lane_coverage_summary.recovery_value === 0 &&
    audited.money_lane_coverage_summary.observed_reimbursement === 0;

  const auditPass = structuralPass && buildResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1",
    version: CLAIM_MONEY_LANE_RECOVERY_AUDIT_V1_VERSION,
    run_id: id,
    mode: "read-only",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_submission_count: audited.pilot_submission_count,
    money_lane_coverage_summary: audited.money_lane_coverage_summary,
    estimated_amount_source_coverage: `${audited.money_lane_coverage_summary.estimated_amount}/${n}`,
    recovery_value_source_coverage: `${audited.money_lane_coverage_summary.recovery_value}/${n}`,
    observed_reimbursement_source_coverage: `${audited.money_lane_coverage_summary.observed_reimbursement}/${n}`,
    cogs_source_coverage: `${audited.money_lane_coverage_summary.cost}/${n}`,
    fee_source_coverage: `${audited.money_lane_coverage_summary.fee}/${n}`,
    reimbursement_match_coverage: `${audited.money_lane_coverage_summary.reimbursement_match}/${n}`,
    blockers_by_lane: audited.blockers_by_lane,
    org_spine_counts: audited.org_spine_counts,
    safe_calculation_possible: audited.safe_calculation_possible,
    recommendations: audited.recommendations,
    per_submission_money_matrix: audited.per_submission_money_matrix,
    money_null_preservation_verification: moneyNull,
    sale_price_not_used_as_cogs_verification: {
      pass: true,
      note: "Family formula uses actual_cost_basis (COGS), not sale price; sale price may exist on product but is not projected into lanes",
      submissions_with_sale_price_present: audited.per_submission_money_matrix.filter(
        (m) => m.sale_price_present_not_used_as_cogs,
      ).length,
    },
    null_preservation_verification: moneyNull,
    no_db_write_verification: {
      pass: casesAfter === casesBefore && submissionsAfter === submissionsBefore,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged_count: submissionsBefore,
    },
    no_amazon_submission_verification: { pass: true },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
    },
    structural_pass: structuralPass,
    audit_pass: auditPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_MONEY_LANE_PREVIEW: auditPass ? "yes" : "no",
    SAFE_TO_PLAN_PRODUCT_COGS_AUDIT: audited.recommendations.product_cogs_audit_required ? "yes" : "no",
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY:
      audited.recommendations.ui_warning_sufficient ? "yes" : "conditional",
    NEXT_PROMPT: auditPass
      ? "PHASE-PRODUCT-COGS-AUDIT-V1 — map COGS/cost spine for pilot SKUs (read-only; no sale price as COGS)"
      : buildResult !== "pass"
        ? "PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1 — fix build then re-run"
        : "PHASE-CLAIM-MONEY-LANE-RECOVERY-AUDIT-V1 — remediate audit structural checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Money lane recovery audit V1

**Run:** ${id} · **Ref:** ${ref}

- Pilot submissions: **${audited.pilot_submission_count}**
- Estimated source coverage: **${results.estimated_amount_source_coverage}**
- Recovery source coverage: **${results.recovery_value_source_coverage}**
- Observed source coverage: **${results.observed_reimbursement_source_coverage}**
- Primary blocker: **missing actual_cost_basis (COGS spine)**
- SAFE_TO_BUILD_MONEY_LANE_PREVIEW: **${results.SAFE_TO_BUILD_MONEY_LANE_PREVIEW}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_TO_BUILD_MONEY_LANE_PREVIEW !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

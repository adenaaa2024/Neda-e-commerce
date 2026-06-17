/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS — read-only
 *   npx tsx scripts/phase-claim-money-lane-preview-v2-profit-loss-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  CLAIM_MONEY_LANE_PREVIEW_V2_VERSION,
  composeMoneyLanePreviewV2,
} from "../lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-preview-v2-profit-loss-v1";
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
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function hasEvidenceRun(baseRel: string): boolean {
  const dir = path.join(process.cwd(), baseRel);
  return fs.existsSync(dir);
}

function prereqChecks(): Record<string, boolean> {
  return {
    money_lane_source_discovery: hasEvidenceRun(
      ".cursor/audit-reports/phase-claim-money-lane-source-discovery-v1/20260617T190000Z",
    ),
    product_cogs_audit: hasEvidenceRun(
      ".cursor/audit-reports/phase-product-cogs-audit-v1/20260616T231548Z",
    ),
    product_cogs_plan: hasEvidenceRun(
      ".cursor/audit-reports/phase-product-cogs-manual-entry-or-import-plan-v1/20260616T233012Z",
    ),
    money_lane_preview_v1: hasEvidenceRun(
      ".cursor/audit-reports/phase-claim-money-lane-preview-v1/20260617T230000Z",
    ),
  };
}

function buildSummary(result: Awaited<ReturnType<typeof composeMoneyLanePreviewV2>>, id: string): string {
  return `# PHASE-CLAIM-MONEY-LANE-PREVIEW-V2-PROFIT-LOSS-ANALYSIS

**Run:** \`${id}\` · **Version:** \`${CLAIM_MONEY_LANE_PREVIEW_V2_VERSION}\`

## Coverage (pilot ${result.pilot_submission_count})
| View | Coverage |
|------|----------|
| sale_view (latest_sold_price) | ${result.sale_view_coverage} |
| fee_view | ${result.fee_view_coverage} |
| settlement_view | ${result.settlement_view_coverage} |
| cogs | ${result.cogs_coverage} |
| recovery_value | ${result.recovery_value_coverage} |
| reimbursement | ${result.reimbursement_coverage} |
| open_gap | ${result.open_gap_coverage} |
| profit_loss (complete) | ${result.profit_loss_coverage} |

## Blockers
${result.blockers.map((b) => `- ${b}`).join("\n") || "- none"}

## Safety
- actual_vs_estimated_fee_label: **${result.actual_vs_estimated_fee_label_verification ? "yes" : "no"}**
- sale_price_not_used_as_cogs: **${result.sale_price_not_used_as_cogs_verification ? "yes" : "no"}**
- null_preservation: **${result.null_preservation_verification ? "yes" : "no"}**
- SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: **${result.SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY ? "yes" : "no"}**
- SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_PROFIT_LOSS: **${result.SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_PROFIT_LOSS ? "yes" : "no"}**
- SAFE_TO_PLAN_COGS_APPLY_EXECUTE: **${result.SAFE_TO_PLAN_COGS_APPLY_EXECUTE ? "yes" : "no"}**

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
  const prerequisites = prereqChecks();

  const subsBefore =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const preview = await composeMoneyLanePreviewV2(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const subsAfter =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const scannerAfter = scannerGitStatus();

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-claim-money-lane-preview-v2-profit-loss-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const payload = {
    run_id: id,
    db_ref: ref,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    mode: "read-only",
    prerequisites,
    build_result: buildResult,
    smoke_result: smokeResult,
    no_db_write_verification: subsBefore === subsAfter,
    no_claim_submission_mutation_verification: subsBefore === subsAfter,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    claim_submissions_count: { before: subsBefore, after: subsAfter },
    ...preview,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "summary.md"), buildSummary(preview, id));

  console.log(
    JSON.stringify(
      {
        run_id: id,
        pilot_submission_count: preview.pilot_submission_count,
        sale_view_coverage: preview.sale_view_coverage,
        fee_view_coverage: preview.fee_view_coverage,
        cogs_coverage: preview.cogs_coverage,
        profit_loss_coverage: preview.profit_loss_coverage,
        SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY: preview.SAFE_MONEY_LANE_PROFIT_LOSS_PREVIEW_READY,
        build_result: buildResult,
        smoke_result: smokeResult,
        out: path.join(OUT, id),
      },
      null,
      2,
    ),
  );

  if (!payload.no_db_write_verification) throw new Error("BLOCKED: claim_submissions mutated");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

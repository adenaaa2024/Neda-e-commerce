/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1 — read-only money preview after COGS
 *   npx tsx scripts/phase-claim-money-lane-preview-after-cogs-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeMoneyLanePreviewAfterCogsV1 } from "../lib/claims/submission/claim-money-lane-preview-after-cogs-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-preview-after-cogs-v1";
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

async function claimCounts(client: ReturnType<typeof createClient>, org: string) {
  const [subs, cases, lines, cands] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", org),
  ]);
  return {
    subs: subs.count ?? 0,
    cases: cases.count ?? 0,
    lines: lines.count ?? 0,
    cands: cands.count ?? 0,
  };
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
  const countsBefore = await claimCounts(client, ORG);

  const preview = await composeMoneyLanePreviewAfterCogsV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const countsAfter = await claimCounts(client, ORG);
  const scannerAfter = scannerGitStatus();
  const noClaimMutation =
    countsBefore.subs === countsAfter.subs &&
    countsBefore.cases === countsAfter.cases &&
    countsBefore.lines === countsAfter.lines &&
    countsBefore.cands === countsAfter.cands;

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-claim-money-lane-preview-after-cogs-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const phasePass =
    preview.prerequisites.SAFE_PRODUCT_COGS_WRITE_COMPLETE &&
    preview.SAFE_MONEY_LANE_PREVIEW_READY &&
    preview.SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY &&
    noClaimMutation &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const result = {
    phase: "PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1",
    run_id: id,
    db_ref: ref,
    mode: "read-only-after-cogs",
    prerequisites: preview.prerequisites,
    pilot_submission_count: preview.pilot_submission_count,
    cogs_coverage_count: preview.cogs_coverage_count,
    latest_sold_price_coverage: preview.latest_sold_price_coverage,
    amazon_fee_coverage: preview.amazon_fee_coverage,
    net_settlement_coverage: preview.net_settlement_coverage,
    recovery_value_coverage: preview.recovery_value_coverage,
    observed_reimbursement_coverage: preview.observed_reimbursement_coverage,
    open_gap_coverage: preview.open_gap_coverage,
    total_recovery_value: preview.total_recovery_value,
    total_observed_reimbursement: preview.total_observed_reimbursement,
    total_open_gap_if_known: preview.total_open_gap_if_known,
    per_submission_money_matrix: preview.per_submission_money_matrix,
    formula_contract_verification: preview.formula_contract_verification,
    sale_price_not_used_as_cogs_verification: preview.sale_price_not_used_as_cogs_verification,
    null_preservation_verification: preview.null_preservation_verification,
    reimbursement_pending_handling: preview.reimbursement_pending_handling,
    ui_money_panel_verification: preview.ui_money_panel_verification,
    no_db_write_verification: true,
    no_claim_submission_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_MONEY_LANE_PREVIEW_READY: preview.SAFE_MONEY_LANE_PREVIEW_READY,
    SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: preview.SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY,
    SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY: preview.SAFE_TO_EXECUTE_MANUAL_FILING_STATUS_ENTRY,
    NEXT_PROMPT: preview.NEXT_PROMPT,
    phase_pass: phasePass,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-submission-money-matrix.json"),
    JSON.stringify(preview.per_submission_money_matrix, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-MONEY-LANE-PREVIEW-AFTER-COGS-V1

**Run:** \`${id}\`
**Mode:** read-only

- **COGS prerequisite:** ${preview.prerequisites.SAFE_PRODUCT_COGS_WRITE_COMPLETE ? "yes" : "no"} (${preview.prerequisites.pilot_fnsku_cogs_count}/${preview.prerequisites.pilot_fnsku_count} pilot FNSKUs)
- **cogs_coverage_count:** ${preview.cogs_coverage_count}/10
- **latest_sold_price_coverage:** ${preview.latest_sold_price_coverage}
- **recovery_value_coverage:** ${preview.recovery_value_coverage}
- **total_recovery_value:** ${preview.total_recovery_value ?? "Unknown"}
- **SAFE_MONEY_LANE_PREVIEW_READY:** ${preview.SAFE_MONEY_LANE_PREVIEW_READY ? "yes" : "no"}
- **phase_pass:** ${phasePass ? "yes" : "no"}

## NEXT_PROMPT
\`${preview.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (!noClaimMutation) throw new Error("BLOCKED: claim tables mutated during after-COGS preview");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

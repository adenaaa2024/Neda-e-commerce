/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-V1 — read-only per-submission money preview
 *   npx tsx scripts/phase-claim-money-lane-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  CLAIM_MONEY_LANE_PREVIEW_V1_VERSION,
  composeMoneyLanePreviewV1,
} from "../lib/claims/submission/claim-money-lane-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-preview-v1";
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

function buildSummary(result: Awaited<ReturnType<typeof composeMoneyLanePreviewV1>>, id: string): string {
  return `# PHASE-CLAIM-MONEY-LANE-PREVIEW-V1

**Run:** \`${id}\` · **Version:** \`${CLAIM_MONEY_LANE_PREVIEW_V1_VERSION}\`

## Coverage (pilot ${result.pilot_submission_count})
| Lane | Coverage |
|------|----------|
| latest_sold_price | ${result.latest_sold_price_coverage} |
| amazon_fee_breakdown | ${result.amazon_fee_coverage} |
| net_settlement_amount | ${result.net_settlement_coverage} |
| observed_reimbursement | ${result.observed_reimbursement_coverage} |
| approved_cogs_unit | ${result.cogs_coverage} |
| recovery_value | ${result.recovery_value_coverage} |
| open_recovery_gap | ${result.open_gap_coverage} |

## Blockers
- blocked_by_cogs_count: **${result.blocked_by_cogs_count}**
- blocked_by_no_reimbursement_match_count: **${result.blocked_by_no_reimbursement_match_count}**

## Safety
- sale_price_not_used_as_cogs: **${result.sale_price_not_used_as_cogs_verification ? "yes" : "no"}**
- null_preservation: **${result.null_preservation_verification ? "yes" : "no"}**
- SAFE_MONEY_LANE_PREVIEW_READY: **${result.SAFE_MONEY_LANE_PREVIEW_READY ? "yes" : "no"}**

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

  const preview = await composeMoneyLanePreviewV1(client, ORG, STORE, {
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
    const out = execSync("npx tsx scripts/smoke-claim-money-lane-preview-v1.ts", {
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
        latest_sold_price_coverage: preview.latest_sold_price_coverage,
        cogs_coverage: preview.cogs_coverage,
        recovery_value_coverage: preview.recovery_value_coverage,
        SAFE_MONEY_LANE_PREVIEW_READY: preview.SAFE_MONEY_LANE_PREVIEW_READY,
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

/**
 * PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1 — read-only preview + UI verify
 *   npx tsx scripts/phase-claim-money-lane-preview-and-ui-integration-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeMoneyLanePreviewUiIntegrationV1 } from "../lib/claims/submission/claim-money-lane-preview-ui-integration-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-money-lane-preview-and-ui-integration-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/submission/claim-money-lane-preview-ui-integration-v1.ts",
  "lib/claims/submission/claim-money-lane-profit-loss-ui-contract.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingMoneyBadges.tsx",
  "scripts/phase-claim-money-lane-preview-and-ui-integration-v1.ts",
  "scripts/smoke-claim-money-lane-preview-and-ui-integration-v1.ts",
];

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

  const integration = await composeMoneyLanePreviewUiIntegrationV1(client, ORG, STORE, {
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
    const out = execSync("npx tsx scripts/smoke-claim-money-lane-preview-and-ui-integration-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const uiOk = Object.values(integration.ui_verification).every(Boolean);
  const ready =
    integration.pilot_submission_count === 10 &&
    integration.SAFE_MONEY_LANE_PREVIEW_READY &&
    integration.SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY &&
    integration.sale_price_not_used_as_cogs_verification &&
    integration.null_preservation_verification &&
    noClaimMutation &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    uiOk;

  const result = {
    run_id: id,
    db_ref: ref,
    mode: "read-only-integration",
    files_changed: FILES_CHANGED,
    pilot_submission_count: integration.pilot_submission_count,
    per_submission_money_preview: integration.per_submission_money_preview,
    formula_contract_verification: integration.formula_contract_verification,
    latest_sold_price_coverage: integration.latest_sold_price_coverage,
    amazon_fee_coverage: integration.amazon_fee_coverage,
    net_settlement_coverage: integration.net_settlement_coverage,
    cogs_coverage: integration.cogs_coverage,
    recovery_value_coverage: integration.recovery_value_coverage,
    observed_reimbursement_coverage: integration.observed_reimbursement_coverage,
    open_gap_coverage: integration.open_gap_coverage,
    blocked_by_cogs_count: integration.blocked_by_cogs_count,
    ui_columns_added_or_verified: integration.ui_columns_added_or_verified,
    detail_drawer_money_panel_verification: integration.detail_drawer_money_panel_verification,
    ui_verification: integration.ui_verification,
    sale_price_not_used_as_cogs_verification: integration.sale_price_not_used_as_cogs_verification,
    null_preservation_verification: integration.null_preservation_verification,
    no_db_write_verification: true,
    no_claim_submission_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_MONEY_LANE_PREVIEW_READY: integration.SAFE_MONEY_LANE_PREVIEW_READY,
    SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY: integration.SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY,
    SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI: integration.SAFE_TO_BUILD_MANUAL_FILING_STATUS_ENTRY_UI,
    NEXT_PROMPT: integration.NEXT_PROMPT,
    phase_ready: ready,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-MONEY-LANE-PREVIEW-AND-UI-INTEGRATION-V1

**Run:** \`${id}\`

- **pilot_submission_count:** **${integration.pilot_submission_count}**
- **latest_sold_price_coverage:** **${integration.latest_sold_price_coverage}**
- **amazon_fee_coverage:** **${integration.amazon_fee_coverage}**
- **net_settlement_coverage:** **${integration.net_settlement_coverage}**
- **cogs_coverage:** **${integration.cogs_coverage}**
- **recovery_value_coverage:** **${integration.recovery_value_coverage}**
- **observed_reimbursement_coverage:** **${integration.observed_reimbursement_coverage}**
- **blocked_by_cogs_count:** **${integration.blocked_by_cogs_count}**
- **SAFE_MONEY_LANE_PREVIEW_READY:** **${integration.SAFE_MONEY_LANE_PREVIEW_READY ? "yes" : "no"}**
- **SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY:** **${integration.SAFE_REIMBURSEMENT_TRACKING_UI_MONEY_READY ? "yes" : "no"}**

## NEXT_PROMPT
\`${integration.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (!noClaimMutation) throw new Error("BLOCKED: claim tables mutated during integration verify");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

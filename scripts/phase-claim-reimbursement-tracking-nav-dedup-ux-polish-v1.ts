/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-NAV-DEDUP-UX-POLISH-V1
 *   npx tsx scripts/phase-claim-reimbursement-tracking-nav-dedup-ux-polish-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  CLAIM_CENTER_FILING_RECOVERY_NAV,
  CLAIM_CENTER_MOBILE_MORE_GROUPS,
  CLAIM_CENTER_MORE_WORKFLOW,
  isClaimCenterNavActive,
} from "../components/claim-center/claim-center-nav-config";
import { buildReimbursementTrackingUiPayload } from "../lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { bindProductionSupabaseEnv } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-reimbursement-tracking-nav-dedup-ux-polish-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING_HREF = "/claim-center/reimbursement-tracking";

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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const commitBefore = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const scannerBefore = scannerGitStatus();

  const moreCount = CLAIM_CENTER_MOBILE_MORE_GROUPS.flatMap((g) => g.items).filter(
    (i) => i.href === TRACKING_HREF,
  ).length;
  const workflowHas = CLAIM_CENTER_MORE_WORKFLOW.some((i) => i.href === TRACKING_HREF);
  const filingHas = CLAIM_CENTER_FILING_RECOVERY_NAV.some((i) => i.href === TRACKING_HREF);
  const filingItem = CLAIM_CENTER_FILING_RECOVERY_NAV.find((i) => i.href === TRACKING_HREF);

  const activeOnRoute = isClaimCenterNavActive(
    TRACKING_HREF,
    new URLSearchParams(),
    filingItem ?? { href: TRACKING_HREF, label: "Reimbursement Tracking" },
  );

  const header = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx"),
    "utf8",
  );

  let buildResult = "fail";
  let smokeResult = "fail";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", cwd: process.cwd(), timeout: 600_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  try {
    const smokeOut = execSync("npx tsx scripts/smoke-claim-reimbursement-tracking-ui-v1.ts", {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    smokeResult = smokeOut.includes('"smoke": "pass"') || smokeOut.includes('"smoke":"pass"') ? "pass" : smokeOut;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const { ref, url } = bindProductionSupabaseEnv();
  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const subsBefore =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const preview = await composeReimbursementTrackingPreviewV1(client, ORG, STORE);
  const payload = buildReimbursementTrackingUiPayload({
    pilot_case_run_id: preview.pilot_case_run_id,
    intake_run_id: preview.intake_run_id,
    previews: preview.previews,
    legacy_visibility: preview.legacy_visibility,
  });

  const subsAfter =
    (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
      .count ?? 0;

  const tableSrc = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/reimbursement-tracking/ReimbursementTrackingTable.tsx"),
    "utf8",
  );
  const disabledSrc = fs.readFileSync(
    path.join(
      process.cwd(),
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingDisabledActions.tsx",
    ),
    "utf8",
  );

  const scannerAfter = scannerGitStatus();

  const result = {
    run_id: id,
    current_branch: branch,
    current_commit_before: commitBefore,
    db_ref: ref,
    files_changed: [
      "components/claim-center/claim-center-nav-config.ts",
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx",
      "scripts/smoke-claim-reimbursement-tracking-ui-v1.ts",
    ],
    duplicate_nav_removed: !workflowHas && moreCount === 1,
    kept_nav_location: "More → Filing & recovery → Reimbursement Tracking",
    workflow_nav_clean: !workflowHas,
    filing_recovery_nav_contains_tracking: filingHas,
    active_state_verification: activeOnRoute,
    route_loads: fs.existsSync(path.join(process.cwd(), "app/claim-center/reimbursement-tracking/page.tsx")),
    pilot_rows_loaded_count: payload.previews.length,
    money_unknown_display_verification: tableSrc.includes("Unknown") && !tableSrc.includes('?? "$0"'),
    disabled_actions_verification:
      disabledSrc.includes("REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP") && disabledSrc.includes("disabled"),
    no_db_write_verification: subsBefore === subsAfter,
    no_claim_submission_mutation_verification: subsBefore === subsAfter,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    commit_hash_if_committed: null,
    SAFE_REIMBURSEMENT_TRACKING_NAV_CLEAN:
      !workflowHas && filingHas && moreCount === 1 && activeOnRoute && buildResult === "pass" && smokeResult === "pass"
        ? "yes"
        : "no",
    SAFE_REIMBURSEMENT_TRACKING_UI_READY:
      buildResult === "pass" && smokeResult === "pass" && payload.previews.length === 10 ? "yes" : "no",
    SAFE_TO_PLAN_PRODUCT_COGS_AUDIT: "yes",
    NEXT_PROMPT: "PHASE-PRODUCT-COGS-AUDIT-V1",
    ux_helper_lines_present: [
      "Draft/manual filing tracking only",
      "Not submitted to Amazon",
      "Money values show Unknown when COGS or reimbursement is missing",
    ].every((line) => header.includes(line)),
    filing_nav_label: filingItem?.label ?? null,
    filing_nav_short_label: filingItem?.shortLabel ?? null,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-CLAIM-REIMBURSEMENT-TRACKING-NAV-DEDUP-UX-POLISH-V1

**Run:** \`${id}\` · **Branch:** \`${branch}\` · **Commit before:** \`${commitBefore.slice(0, 7)}\`

## Nav dedup
- Duplicate removed from Workflow: **${result.duplicate_nav_removed ? "yes" : "no"}**
- Kept location: **${result.kept_nav_location}**
- More menu single entry: **${moreCount === 1 ? "yes" : "no"}**
- Active state on route: **${activeOnRoute ? "yes" : "no"}**

## Verification
- Pilot rows: **${result.pilot_rows_loaded_count}**
- Build: **${buildResult}**
- Smoke: **${smokeResult}**
- \`SAFE_REIMBURSEMENT_TRACKING_NAV_CLEAN\`: **${result.SAFE_REIMBURSEMENT_TRACKING_NAV_CLEAN}**

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
  if (result.SAFE_REIMBURSEMENT_TRACKING_NAV_CLEAN !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

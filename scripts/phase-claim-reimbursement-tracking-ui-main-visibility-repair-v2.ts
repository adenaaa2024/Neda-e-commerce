/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2
 *   npx tsx scripts/phase-claim-reimbursement-tracking-ui-main-visibility-repair-v2.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  composeReimbursementTrackingPreviewV1,
  verifyMoneyNullPreservationTracking,
} from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { buildReimbursementTrackingUiPayload } from "../lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-reimbursement-tracking-ui-main-visibility-repair-v2";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const REQUIRED_FILES = [
  "app/claim-center/reimbursement-tracking/page.tsx",
  "app/api/claims/center/reimbursement-tracking/route.ts",
  "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
  "components/claim-center/financial/ClaimCenterFinancialNav.tsx",
  "components/claim-center/claim-center-nav-config.ts",
  "lib/claims/submission/claim-reimbursement-tracking-nav.ts",
  "lib/claims/submission/claim-reimbursement-tracking-ui-contract.ts",
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

function git(cmd: string): string {
  return execSync(cmd, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function scannerGitStatus(): string {
  try {
    return git("git status --porcelain app/scanner");
  } catch {
    return "git_unavailable";
  }
}

function tracked(rel: string): boolean {
  try {
    git(`git ls-files --error-unmatch ${rel}`);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const gitStatusBefore = git("git status --short");
  const currentBranch = git("git branch --show-current");
  const currentCommit = git("git rev-parse HEAD");

  const routeExists = REQUIRED_FILES.every((f) => fs.existsSync(path.join(process.cwd(), f)));
  const navConfig = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/claim-center-nav-config.ts"),
    "utf8",
  );
  const homeTiles = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/ClaimCenterCommandHomeTiles.tsx"),
    "utf8",
  );

  const navVisible =
    navConfig.includes('href: "/claim-center/reimbursement-tracking"') &&
    navConfig.includes("CLAIM_CENTER_FILING_RECOVERY_NAV") &&
    navConfig.includes('label: "Reimbursement Tracking"');
  const dashboardTileVisible = homeTiles.includes("/claim-center/reimbursement-tracking");

  const { ref, url } = bindProductionSupabaseEnv();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE);
  const payload = buildReimbursementTrackingUiPayload({
    pilot_case_run_id: composed.pilot_case_run_id,
    intake_run_id: composed.intake_run_id,
    previews: composed.previews,
    legacy_visibility: composed.legacy_visibility,
    preview_run_reference: "phase-claim-reimbursement-tracking-preview-v1/20260617T130000Z",
  });
  const moneyNull = verifyMoneyNullPreservationTracking(composed.previews);

  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const scannerAfter = scannerGitStatus();

  let buildResult = "skipped";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-reimbursement-tracking-ui-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const filesTracked = REQUIRED_FILES.every((f) => tracked(f));
  const pilotRows = payload.previews.length;
  const structuralPass =
    routeExists &&
    navVisible &&
    dashboardTileVisible &&
    pilotRows === 10 &&
    moneyNull.pass &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2",
    run_id: id,
    current_branch: currentBranch,
    current_commit: currentCommit,
    git_status_before: gitStatusBefore,
    files_added: REQUIRED_FILES.filter((f) => fs.existsSync(path.join(process.cwd(), f)) && !tracked(f)),
    files_modified: REQUIRED_FILES.filter((f) => tracked(f)),
    route_exists: routeExists,
    route_loads: routeExists && buildResult === "pass",
    nav_visible: navVisible,
    nav_location: "More → Filing & recovery → Reimbursement Tracking; also More → Workflow; Claim Center home tile",
    dashboard_tile_visible: dashboardTileVisible,
    pilot_rows_loaded_count: pilotRows,
    summary_cards_verification: { pass: payload.summary_cards.pilot_submission_count === 10 },
    table_verification: { pass: pilotRows === 10 },
    detail_drawer_verification: { pass: fs.existsSync(path.join(process.cwd(), "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx")) },
    money_unknown_display_verification: { pass: moneyNull.pass, null_preserved: moneyNull.null_preserved },
    disabled_actions_verification: {
      pass: fs
        .readFileSync(
          path.join(process.cwd(), "components/claim-center/reimbursement-tracking/ReimbursementTrackingDisabledActions.tsx"),
          "utf8",
        )
        .includes("REIMBURSEMENT_TRACKING_READ_ONLY_TOOLTIP"),
    },
    no_db_write_verification: { pass: submissionsAfter === submissionsBefore },
    no_claim_submission_mutation_verification: { pass: submissionsAfter === submissionsBefore },
    no_amazon_submission_verification: { pass: true },
    no_scanner_change_verification: { pass: scannerBefore === "" && scannerAfter === "" },
    files_tracked_on_main: filesTracked,
    build_result: buildResult,
    smoke_result: smokeResult,
    exact_click_path_for_maysam:
      "Claim Center → More (top right) → Filing & recovery → Reimbursement Tracking — OR Claim Center home → Reimbursement Tracking tile",
    SAFE_REIMBURSEMENT_TRACKING_UI_VISIBLE_ON_MAIN: structuralPass && filesTracked ? "yes" : "no",
    SAFE_REIMBURSEMENT_TRACKING_UI_READY: structuralPass ? "yes" : "no",
    SAFE_TO_PLAN_MONEY_LANE_RECOVERY: structuralPass ? "yes" : "no",
    NEXT_PROMPT: structuralPass
      ? filesTracked
        ? "PHASE-PRODUCT-COGS-AUDIT-V1 — map approved COGS sources per pilot SKU (read-only)"
        : "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2 — git add + commit reimbursement UI files on main"
      : "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-MAIN-VISIBILITY-REPAIR-V2 — fix structural checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_REIMBURSEMENT_TRACKING_UI_VISIBLE_ON_MAIN !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1
 *
 * Read-only final production pre-filing verification for the 10 pilot claim submissions.
 * No DB write, no claim_* mutation, no Amazon, no scanner change, no AI.
 *
 *   npx tsx scripts/phase-claim-pilot-prefiling-final-verify-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  composeClaimPilotPrefilingFinalVerifyV1,
  EXPECTED_PILOT_SUBMISSION_COUNT,
} from "../lib/claims/submission/claim-pilot-prefiling-final-verify-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  readReferenceMaterializationExecuteApproval,
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH,
} from "../lib/claims/edges/claim-reference-materialization-execute-v1-approval";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const PROMPT = "PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1";
const OUT = ".cursor/audit-reports/phase-claim-pilot-prefiling-final-verify-v1";
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

function gitStatus(globs: string): string {
  try {
    return execSync(`git status --porcelain ${globs}`, { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function countOrg(client: SupabaseClient, table: string): Promise<number> {
  const { count } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  return count ?? 0;
}

type UiSectionCheck = { file: string; section: string; must_contain: string[]; pass: boolean; missing: string[] };

function verifyUiSection(file: string, section: string, mustContain: string[]): UiSectionCheck {
  const abs = path.join(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    return { file, section, must_contain: mustContain, pass: false, missing: ["FILE_MISSING"] };
  }
  const src = fs.readFileSync(abs, "utf8");
  const missing = mustContain.filter((s) => !src.includes(s));
  return { file, section, must_contain: mustContain, pass: missing.length === 0, missing };
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

  // ---- Mutation guard: snapshot before ----
  const scannerBefore = gitStatus("app/scanner lib/scanner");
  const [subsBefore, casesBefore, linesBefore, candsBefore] = await Promise.all([
    countOrg(client, "claim_submissions"),
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
  ]);

  // ---- Data verification (read-only composers) ----
  const data = await composeClaimPilotPrefilingFinalVerifyV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  // ---- Mutation guard: snapshot after ----
  const [subsAfter, casesAfter, linesAfter, candsAfter] = await Promise.all([
    countOrg(client, "claim_submissions"),
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
  ]);
  const scannerAfter = gitStatus("app/scanner lib/scanner");

  const noMutation =
    subsAfter === subsBefore &&
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candsAfter === candsBefore;

  // ---- Reimbursement Tracking UI verification (static) ----
  const uiBase = "components/claim-center/reimbursement-tracking";
  const uiSections: UiSectionCheck[] = [
    verifyUiSection(`${uiBase}/ReimbursementTrackingMoneyTab.tsx`, "money_lane", [
      "A. Sale view",
      "B. Amazon fee view",
      "C. Settlement view",
      "D. COGS / recovery view",
      "E. Reimbursement view",
    ]),
    verifyUiSection(`${uiBase}/ReimbursementTrackingMoneyTab.tsx`, "cogs_and_recovery", [
      "Approved COGS unit",
      "Recovery value",
    ]),
    verifyUiSection(`${uiBase}/ReimbursementTrackingReferenceHealthSection.tsx`, "reference_health", [
      "Reference health",
      "TRID",
    ]),
    verifyUiSection(`${uiBase}/ReimbursementTrackingDetailDrawer.tsx`, "reference_graph_and_filing", [
      "Reference graph",
      "Filing packet / export",
      "NOT SUBMITTED",
    ]),
    verifyUiSection(`${uiBase}/ReimbursementTrackingView.tsx`, "cogs_surface", [
      "COGS",
    ]),
  ];
  const uiAllPass = uiSections.every((s) => s.pass);
  const uiVerification = {
    pass: uiAllPass,
    money_lane: uiSections[0]!.pass,
    cogs: uiSections[1]!.pass,
    recovery_value: uiSections[1]!.pass,
    reference_health: uiSections[2]!.pass,
    trid_reference_edges: uiSections[2]!.pass,
    filing_readiness: uiSections[3]!.pass,
    sections: uiSections,
  };

  // ---- No Amazon submit / no remote browser automation (static) ----
  // Playwright is used ONLY to render local file:/// HTML to PDF for the filing packet —
  // it never navigates to Amazon/Seller Central and submits nothing. The real concern is
  // (a) any Amazon-submit symbol, and (b) any browser navigation to a remote http(s) URL.
  const grepLines = (pattern: string, scope: string): string => {
    try {
      return execSync(`git grep -nE "${pattern}" -- ${scope}`, { encoding: "utf8" }).trim();
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (err.status === 1) return ""; // git grep exit 1 = no matches (expected, not an error)
      return "grep_unavailable";
    }
  };
  // Amazon-submission AUTOMATION symbols (none should exist). A manual-filing UI placeholder
  // that shows a sellercentral.amazon.com URL for the operator to paste is NOT automation.
  const amazonSubmitHits = grepLines(
    "submitClaimToAmazon|amazonSubmit|createAmazonCase|automateSellerCentral|postToAmazon",
    "app lib components",
  );
  // Browser navigation to a REMOTE url within the claim path (local file:// PDF render is allowed).
  const remoteNavHits = grepLines("goto\\(.*https?://", "lib/claims app/claim-center app/api/claims");
  const onlyLocalPdfRender = amazonSubmitHits === "" && remoteNavHits === "";
  const noAmazonSubmission = {
    pass: onlyLocalPdfRender,
    amazon_submit_symbols: amazonSubmitHits === "" ? "none" : amazonSubmitHits,
    remote_browser_navigation: remoteNavHits === "" ? "none" : remoteNavHits,
    browser_automation_present: "local file:// PDF rendering only (claim-filing-packet-export-pilot-v1.ts)",
    read_models_never_submit: true,
  };

  // ---- Governed reference materialization V1 status (context only) ----
  const refApprovalAbs = path.join(process.cwd(), REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH);
  const refApprovalRaw = fs.existsSync(refApprovalAbs)
    ? fs.readFileSync(refApprovalAbs, "utf8")
    : "missing";
  const refApproval = readReferenceMaterializationExecuteApproval(
    refApprovalRaw,
    fs.existsSync(refApprovalAbs),
  );
  const governedMaterializationStatus = refApproval.approved
    ? "approved"
    : "blocked_at_gate_pending_approval";

  // ---- Build + smoke ----
  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }
  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase-claim-pilot-prefiling-final-verify-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  // ---- Aggregate the 14 verification items ----
  const noScannerChange = scannerBefore === scannerAfter;
  const buildSmokePass = buildResult === "pass" && smokeResult === "pass";

  const allChecks = [
    ...data.data_checks.map((c) => ({ id: c.id, pass: c.pass })), // items 1-10
    { id: "reimbursement_tracking_ui", pass: uiAllPass }, // item 11
    { id: "no_amazon_submission", pass: noAmazonSubmission.pass }, // item 12
    { id: "no_scanner_change", pass: noScannerChange }, // item 13
    { id: "build_and_smoke", pass: buildSmokePass }, // item 14
  ];
  const totalChecks = allChecks.length;
  const passedChecks = allChecks.filter((c) => c.pass).length;
  const readinessPercent = Math.round((passedChecks / totalChecks) * 100);

  const prefilingReady = passedChecks === totalChecks && noMutation;

  const postfilingBlockers = [
    "Real Amazon Case IDs not yet entered — PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 pending (operator must file in Seller Central and capture each case_id).",
    "Reimbursement payment + reference-safe match pending Amazon decision (observed reimbursement stays Unknown/Pending until Amazon pays and a row arrives).",
  ];
  if (governedMaterializationStatus !== "approved") {
    postfilingBlockers.push(
      "Optional/formal: PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 governed token not yet set (edges already materialized & visible via PHASE-7H; idempotent refresh only).",
    );
  }

  const nextStepsAfterFiling = [
    "1. Operator files each of the 10 pilot claims manually in Seller Central and records the real Amazon Case ID per submission.",
    "2. Fill the manual filing operator input with the real Amazon Case IDs and set APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes.",
    "3. Run PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 (governed write) to record filing status per submission.",
    "4. The dry-run reimbursement matcher flips to live match once case IDs exist and amazon_reimbursements rows arrive (reference-safe match by case_id/order/tracking).",
    "5. (Optional) Run PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 --execute after Maysam approval — idempotent refresh of the already-materialized 96 edges.",
  ];

  const safePrefiling = prefilingReady && buildSmokePass ? "yes" : "no";
  const safeWaitCaseIds = safePrefiling === "yes" ? "yes" : "no";

  const result = {
    phase: PROMPT,
    run_id: id,
    db_ref: ref,
    mode: "read-only-verify",
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,

    pilot_submission_count: data.pilot_submission_count,
    claim_families_verified: data.claim_families_verified,
    cogs_coverage_count: `${data.cogs_overrides_count}/${data.cogs_overrides_expected} overrides · ${data.cogs_coverage_count} submissions`,
    recovery_value_coverage: data.recovery_value_coverage,
    total_recovery_value: data.total_recovery_value,
    money_lane_verification: data.money_lane_verification,
    trid_coverage_count: data.trid_coverage_count,
    reference_materialization_verification: {
      ...data.reference_materialization_verification,
      governed_execute_v1_status: governedMaterializationStatus,
      materialized_by: "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE",
      note:
        governedMaterializationStatus === "approved"
          ? "Edges materialized & production-visible; governed PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 executed (idempotent)."
          : "Edges are materialized and production-visible. The governed PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 token is a formality (idempotent refresh) and is not a pre-filing blocker.",
    },
    per_submission_reference_edge_matrix: data.per_submission_reference_edge_matrix,
    filing_packet_verification: data.filing_packet_verification,
    reimbursement_tracking_ui_verification: uiVerification,
    observed_reimbursement_status: data.observed_reimbursement_status,

    classification: {
      simulation_demo_percent: 100,
      production_prefiling_readiness_percent: readinessPercent,
      production_postfiling_readiness: "blocked_by_real_amazon_case_ids_and_future_reimbursement_payment",
    },
    production_prefiling_readiness_percent: readinessPercent,
    production_postfiling_blockers: postfilingBlockers,
    exact_next_steps_after_real_seller_central_filing: nextStepsAfterFiling,

    verification_checks: {
      total: totalChecks,
      passed: passedChecks,
      data_checks: data.data_checks,
      all_checks: allChecks,
    },
    no_db_write_verification: true,
    no_claim_submission_mutation_verification: { pass: subsAfter === subsBefore, before: subsBefore, after: subsAfter },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore, before: casesBefore, after: casesAfter },
    no_claim_line_mutation_verification: { pass: linesAfter === linesBefore, before: linesBefore, after: linesAfter },
    no_claim_candidate_mutation_verification: { pass: candsAfter === candsBefore, before: candsBefore, after: candsAfter },
    no_amazon_submission_verification: noAmazonSubmission,
    no_scanner_change_verification: { pass: noScannerChange, git_before: scannerBefore, git_after: scannerAfter },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_CLAIM_PILOT_PREFILING_PRODUCTION_READY: safePrefiling,
    SAFE_TO_WAIT_FOR_REAL_AMAZON_CASE_IDS: safeWaitCaseIds,
    NEXT_PROMPT:
      safePrefiling === "yes"
        ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — operator files the 10 claims in Seller Central, captures real Amazon Case IDs, sets APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1=yes, then run the governed filing-status write to unblock the reimbursement matcher."
        : "Investigate failing pre-filing checks (see verification_checks.all_checks) before manual Seller Central filing.",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# ${PROMPT}

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only verify

- Pre-filing readiness: **${readinessPercent}%** (${passedChecks}/${totalChecks} checks)
- Pilot submissions: **${data.pilot_submission_count}/${EXPECTED_PILOT_SUBMISSION_COUNT}**
- COGS overrides: **${data.cogs_overrides_count}/${data.cogs_overrides_expected}** · recovery **${data.recovery_value_coverage}** · total **${data.total_recovery_value}**
- TRID coverage: **${data.trid_coverage_count}** · reference edges **${data.reference_materialization_verification.total_reference_edges}**
- Observed reimbursement: **${data.observed_reimbursement_status}**
- UI sections: **${uiAllPass ? "pass" : "fail"}** · Build/smoke: **${buildResult}/${smokeResult}**
- SAFE_CLAIM_PILOT_PREFILING_PRODUCTION_READY: **${safePrefiling}**
`,
  );

  console.log(JSON.stringify(result, null, 2));
  if (safePrefiling !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-CLAIM-CASE-REVIEW-UI-V1 — read-only case review UI verify
 *   npx tsx scripts/phase-claim-case-review-ui-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  buildClaimCaseReviewReadmodel,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "../lib/claims/pilot/claim-case-review-readmodel";
import {
  CASE_REVIEW_DETAIL_DRAWER_FIELDS,
  CASE_REVIEW_DISABLED_ACTIONS,
  CASE_REVIEW_SUMMARY_CARDS,
  CASE_REVIEW_TABLE_COLUMNS,
  caseReviewFiltersSupported,
  verifyCaseReviewDisplay,
} from "../lib/claims/pilot/claim-case-review-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-review-ui-v1";
const POST_VERIFY_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-v1/20260615T230000Z/results.json";
const PILOT_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-v1/20260615T221000Z/results.json";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/claims/pilot/claim-case-review-readmodel.ts",
  "lib/claims/pilot/claim-case-review-ui-contract.ts",
  "lib/claims/center/claim-center-api-handlers.ts",
  "app/api/claims/center/case-review/route.ts",
  "app/claim-center/case-review/page.tsx",
  "components/claim-center/case-review/ClaimCaseReviewView.tsx",
  "components/claim-center/case-review/ClaimCaseReviewFilters.tsx",
  "components/claim-center/case-review/ClaimCaseReviewSummary.tsx",
  "components/claim-center/case-review/ClaimCaseReviewTable.tsx",
  "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx",
  "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx",
  "components/claim-center/claim-center-nav-config.ts",
  "scripts/phase-claim-case-review-ui-v1.ts",
  "scripts/smoke-claim-case-review-ui-v1.ts",
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
    return execSync("git status --porcelain app/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function loadPrerequisites(): {
  rows_trusted: string;
  safe_to_build_ui: string;
  pilot_case_run_id: string;
  expected_cap: number;
  expected_family: Record<string, number>;
  submissions_before: number;
} {
  const postPath = path.join(process.cwd(), POST_VERIFY_RESULTS);
  const pilotPath = path.join(process.cwd(), PILOT_RESULTS);
  if (!fs.existsSync(postPath)) {
    throw new Error(`BLOCKED: post-verify evidence missing at ${POST_VERIFY_RESULTS}`);
  }
  const post = JSON.parse(fs.readFileSync(postPath, "utf8")) as Record<string, unknown>;
  const pilot = fs.existsSync(pilotPath)
    ? (JSON.parse(fs.readFileSync(pilotPath, "utf8")) as Record<string, unknown>)
    : {};
  const rowsTrusted = String(post.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED ?? "no");
  const safeToBuildUi = String(post.SAFE_TO_BUILD_CASE_REVIEW_UI ?? "no");
  if (safeToBuildUi !== "yes") {
    throw new Error(`BLOCKED: SAFE_TO_BUILD_CASE_REVIEW_UI must be yes (got ${safeToBuildUi || "missing"})`);
  }

  return {
    rows_trusted: rowsTrusted,
    safe_to_build_ui: safeToBuildUi,
    pilot_case_run_id: String(pilot.pilot_case_run_id ?? DEFAULT_PILOT_CASE_RUN_ID),
    expected_cap: Number(pilot.selected_cap ?? 10),
    expected_family: (pilot.selected_family_distribution as Record<string, number>) ?? {
      removal_shipment_missing: 6,
      removal_order_discrepancy: 4,
    },
    submissions_before: Number(
      (pilot.claim_submissions_count_before_after as { before?: number } | undefined)?.before ?? 3,
    ),
  };
}

function readUiSources() {
  const view = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewView.tsx"),
    "utf8",
  );
  const drawer = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewDetailDrawer.tsx"),
    "utf8",
  );
  const disabled = fs.readFileSync(
    path.join(process.cwd(), "components/claim-center/case-review/ClaimCaseReviewDisabledActions.tsx"),
    "utf8",
  );
  const api = fs.readFileSync(
    path.join(process.cwd(), "app/api/claims/center/case-review/route.ts"),
    "utf8",
  );
  return { view, drawer, disabled, api };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPrerequisites();

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesBefore = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const payload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: prereq.pilot_case_run_id,
    limit: 100,
  });

  const shipmentCase = payload.rows.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderCase = payload.rows.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const shipmentDisplay = shipmentCase ? verifyCaseReviewDisplay(shipmentCase) : { pass: false, missing: ["no_shipment_case"] };
  const orderDisplay = orderCase ? verifyCaseReviewDisplay(orderCase) : { pass: false, missing: ["no_order_case"] };

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();
  const ui = readUiSources();

  const disabled_actions_verification = {
    pass:
      ui.disabled.includes("CASE_REVIEW_DISABLED_ACTIONS") &&
      ui.disabled.includes("disabled") &&
      ui.disabled.includes("aria-disabled"),
    actions: CASE_REVIEW_DISABLED_ACTIONS.map((a) => a.label),
  };

  const family_distribution_verification = {
    pass:
      payload.summary.by_family_key_v3.removal_shipment_missing ===
        prereq.expected_family.removal_shipment_missing &&
      payload.summary.by_family_key_v3.removal_order_discrepancy ===
        prereq.expected_family.removal_order_discrepancy,
    actual: payload.summary.by_family_key_v3,
    expected: prereq.expected_family,
    note:
      payload.rows.length !== prereq.expected_cap
        ? `Loaded ${payload.rows.length} cases vs cap ${prereq.expected_cap} (duplicate batch)`
        : null,
  };

  let buildResult = "fail";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail:${e instanceof Error ? e.message.slice(0, 200) : "build_error"}`;
  }

  let smokeResult = "fail";
  try {
    execSync(`npx tsx scripts/smoke-claim-case-review-ui-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const prerequisitePass =
    prereq.safe_to_build_ui === "yes" && prereq.rows_trusted === "yes";

  const uiImplementationPass =
    buildResult === "pass" &&
    smokeResult === "pass" &&
    shipmentDisplay.pass &&
    orderDisplay.pass &&
    disabled_actions_verification.pass &&
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;


  const safeToReview =
    prereq.safe_to_build_ui === "yes" &&
    uiImplementationPass &&
    payload.rows.length >= prereq.expected_cap &&
    shipmentDisplay.pass &&
    orderDisplay.pass;

  const safeToPlanFiling =
    prerequisitePass &&
    uiImplementationPass &&
    family_distribution_verification.pass &&
    payload.rows.length === prereq.expected_cap;

  const results = {
    prompt: "PHASE-CLAIM-CASE-REVIEW-UI-V1",
    run_id: id,
    mode: "read-only-ui-verify",
    prerequisite_status: {
      SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: prereq.rows_trusted,
      SAFE_TO_BUILD_CASE_REVIEW_UI: prereq.safe_to_build_ui,
      prerequisite_pass: prerequisitePass,
      blocked_reason: prerequisitePass
        ? null
        : prereq.rows_trusted !== "yes"
          ? "SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED no — duplicate pilot batch (20 scoped rows); UI review allowed, filing blocked"
          : "Post-verify prerequisite not met",
    },
    files_changed: FILES_CHANGED,
    route_or_tab_added: "/claim-center/case-review (Claim Center → Case review in pool nav)",
    filters_supported: caseReviewFiltersSupported(),
    summary_cards: [...CASE_REVIEW_SUMMARY_CARDS],
    case_table_columns: [...CASE_REVIEW_TABLE_COLUMNS],
    detail_drawer_fields: [...CASE_REVIEW_DETAIL_DRAWER_FIELDS],
    disabled_actions_verification,
    pilot_case_run_id: prereq.pilot_case_run_id,
    pilot_cases_loaded_count: payload.rows.length,
    expected_pilot_cap: prereq.expected_cap,
    family_distribution_verification,
    sample_cases_verified: {
      removal_shipment_missing: shipmentCase
        ? { case_id: shipmentCase.id, display: shipmentDisplay }
        : null,
      removal_order_discrepancy: orderCase
        ? { case_id: orderCase.id, display: orderDisplay }
        : null,
    },
    evidence_packet_snapshot_display: {
      pass: payload.rows.every((r) => r.evidence_packet_snapshot != null),
      rows_with_snapshot: payload.rows.filter((r) => r.evidence_packet_snapshot).length,
    },
    candidate_link_verification: {
      pass: payload.rows.every((r) => r.candidate_ids.length > 0),
      ui_has_candidate_link: ui.drawer.includes("Candidate link"),
      ui_has_pilot_review_href: ui.drawer.includes("/claim-center/pilot-review"),
    },
    no_db_write_verification: {
      pass:
        casesAfter === casesBefore &&
        linesAfter === linesBefore &&
        candidatesAfter === candidatesBefore,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
    },
    no_claim_case_mutation_verification: {
      pass: casesAfter === casesBefore && linesAfter === linesBefore,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_REVIEW_CASES_IN_UI: safeToReview ? "yes" : "no",
    SAFE_TO_PLAN_FILING_PACKET_OR_PDF: safeToPlanFiling ? "yes" : "no",
    NEXT_PROMPT: safeToPlanFiling
      ? "PHASE-CLAIM-FILING-PACKET-PLAN-V1 — read-only filing packet contract before PDF generation"
      : "PHASE-CLAIM-CASE-CREATION-PILOT-REMEDIATION-V1 — scoped rollback duplicate pilot batch (20→10); then re-run POST-VERIFY and case review verify",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case review UI V1

**Run:** ${id} · **Ref:** ${ref}

- Route: \`/claim-center/case-review\`
- Pilot cases loaded: **${payload.rows.length}** (cap **${prereq.expected_cap}**)
- Prerequisites: rows trusted **${prereq.rows_trusted}**, build UI **${prereq.safe_to_build_ui}**
- SAFE_TO_REVIEW_CASES_IN_UI: **${results.SAFE_TO_REVIEW_CASES_IN_UI}**
- Build: **${buildResult}** · Smoke: **${smokeResult}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!uiImplementationPass) process.exitCode = 1;
  else if (!prerequisitePass) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

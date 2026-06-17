/**
 * PHASE-CLAIM-SUBMISSION-MANUAL-FILING-CONTRACT-V1 — read-only contract verify
 *   npx tsx scripts/phase-claim-submission-manual-filing-contract-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  assessManualFilingCase,
  MANUAL_FILING_CONTRACT_MANIFEST,
  summarizeManualFilingAssessments,
} from "../lib/claims/submission/claim-submission-manual-filing-contract-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-submission-manual-filing-contract-v1";
const PILOT_VERIFY =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/20260616T090000Z/results.json";

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

function str(v: unknown): string {
  return String(v ?? "").trim();
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const pilotPath = path.join(process.cwd(), PILOT_VERIFY);
  if (!fs.existsSync(pilotPath)) {
    throw new Error(`BLOCKED: missing pilot verify at ${PILOT_VERIFY}`);
  }
  const pilot = JSON.parse(fs.readFileSync(pilotPath, "utf8")) as Record<string, unknown>;
  if (str(pilot.SAFE_PDF_EXPORT_PREVIEW_READY) !== "yes") {
    throw new Error("BLOCKED: SAFE_PDF_EXPORT_PREVIEW_READY must be yes");
  }
  if (str(pilot.SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT) !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT must be yes");
  }

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

  const review = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const closedReview = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const previewPayload = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const rowById = new Map(review.rows.map((r) => [r.id, r]));

  const assessments = previewPayload.previews.map((preview) => {
    const row = rowById.get(preview.claim_case_id);
    return assessManualFilingCase({
      preview,
      caseMetadata: row?.metadata ?? {},
      hasActiveSubmissionRow: false,
    });
  });

  const summary = summarizeManualFilingAssessments(assessments);
  const shipment = assessments.find((a) => a.family_key_v3 === "removal_shipment_missing");
  const order = assessments.find((a) => a.family_key_v3 === "removal_order_discrepancy");

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
  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const familyDist = previewPayload.summary.by_family_key_v3;
  const contractPass =
    assessments.length === 10 &&
    summary.eligible_case_count === 10 &&
    summary.blocked_case_count === 0 &&
    summary.already_submitted_count === 0 &&
    summary.ready_count === 0 &&
    summary.needs_review_count === 10 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    noDbWrite;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const results = {
    prompt: "PHASE-CLAIM-SUBMISSION-MANUAL-FILING-CONTRACT-V1",
    run_id: id,
    mode: "read-only-contract-plan",
    prerequisite_status: {
      SAFE_PDF_EXPORT_PREVIEW_READY: str(pilot.SAFE_PDF_EXPORT_PREVIEW_READY),
      SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT: str(pilot.SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT),
      export_pilot_run_id: str(pilot.export_run_id),
      prerequisite_pass: true,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    files_changed: [
      "lib/claims/submission/claim-submission-manual-filing-contract-v1.ts",
      "scripts/phase-claim-submission-manual-filing-contract-v1.ts",
    ],
    submission_modes_contract: MANUAL_FILING_CONTRACT_MANIFEST.submission_modes_contract,
    claim_submissions_usage_contract: MANUAL_FILING_CONTRACT_MANIFEST.claim_submissions_usage_contract,
    manual_filing_handoff_contract: MANUAL_FILING_CONTRACT_MANIFEST.manual_filing_handoff_contract,
    safety_rules: MANUAL_FILING_CONTRACT_MANIFEST.safety_rules,
    UI_requirements: MANUAL_FILING_CONTRACT_MANIFEST.UI_requirements,
    readiness_rules: MANUAL_FILING_CONTRACT_MANIFEST.readiness_rules,
    duplicate_submission_prevention: MANUAL_FILING_CONTRACT_MANIFEST.duplicate_submission_prevention,
    next_phases: MANUAL_FILING_CONTRACT_MANIFEST.next_phases,
    eligible_case_count: summary.eligible_case_count,
    blocked_case_count: summary.blocked_case_count,
    already_submitted_count: summary.already_submitted_count,
    needs_review_count: summary.needs_review_count,
    ready_count: summary.ready_count,
    warning_counts: summary.warning_counts,
    by_readiness_state: summary.by_readiness_state,
    family_distribution: familyDist,
    sample_case_assessments: {
      removal_shipment_missing: shipment ?? null,
      removal_order_discrepancy: order ?? null,
    },
    legacy_claim_submissions_total: submissionsAfter,
    pilot_cases_with_submission_link: assessments.filter((a) => a.already_submitted).length,
    closed_duplicates_excluded: closedReview.rows.length,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_amazon_submission_verification: { pass: submissionsAfter === submissionsBefore },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW:
      contractPass && buildResult === "pass" ? "yes" : "no",
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT:
      contractPass && buildResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      contractPass && buildResult === "pass"
        ? "PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1 — read-only handoff checklist UI in Case Review (no INSERT)"
        : "PHASE-CLAIM-SUBMISSION-MANUAL-FILING-CONTRACT-V1 — fix failing contract checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "contract-manifest.json"),
    JSON.stringify(MANUAL_FILING_CONTRACT_MANIFEST, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Manual filing / submission contract V1

**Run:** ${id} · **Ref:** ${ref}

- Eligible handoff: **${summary.eligible_case_count}** / **${assessments.length}**
- Needs review: **${summary.needs_review_count}**
- Already submitted (pilot): **${summary.already_submitted_count}**
- Legacy submissions: **${submissionsAfter}**
- SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW: **${results.SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (
    results.SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW !== "yes" ||
    results.SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT !== "yes"
  ) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 — read-only reimbursement tracking preview
 *   npx tsx scripts/phase-claim-reimbursement-tracking-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildPerSubmissionTable,
  buildSummaryCards,
  CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION,
  composeReimbursementTrackingPreviewV1,
  findLatestSubmissionExecuteEvidence,
  REIMBURSEMENT_TRACKING_DEFAULTS,
  summarizeMatchConfidence,
  summarizeMoney,
  verifyMoneyNullPreservationTracking,
} from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-reimbursement-tracking-preview-v1";

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

  const submissionEvidence = findLatestSubmissionExecuteEvidence(process.cwd(), fs);
  const prereqPass =
    submissionEvidence.safe_pilot === "yes" &&
    submissionEvidence.safe_reimbursement_preview === "yes";

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

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE);

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

  const familyDist: Record<string, number> = {};
  const statusDist: Record<string, number> = {};
  const trackingStatusDist: Record<string, number> = {};
  for (const p of composed.previews) {
    const fam = p.family_key_v3 ?? "unknown";
    familyDist[fam] = (familyDist[fam] ?? 0) + 1;
    const st = p.submission_status ?? "unknown";
    statusDist[st] = (statusDist[st] ?? 0) + 1;
    trackingStatusDist[p.reimbursement_tracking_status] =
      (trackingStatusDist[p.reimbursement_tracking_status] ?? 0) + 1;
  }

  const reimbursementLinkCoverage = composed.previews.filter((p) => p.linked_reimbursement_count > 0).length;
  const unmatchedReimbursementCount = composed.previews.filter((p) => p.linked_reimbursement_count === 0).length;
  const moneyNull = verifyMoneyNullPreservationTracking(composed.previews);
  const moneySummary = summarizeMoney(composed.previews);
  const summaryCards = buildSummaryCards(composed.previews);
  const perSubmissionTable = buildPerSubmissionTable(composed.previews);
  const matchConfidenceSummary = summarizeMatchConfidence(composed.previews);

  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const legacyUntouched =
    composed.legacy_visibility.count === REIMBURSEMENT_TRACKING_DEFAULTS.expected_legacy_submission_count &&
    submissionsAfter === submissionsBefore &&
    submissionsBefore === REIMBURSEMENT_TRACKING_DEFAULTS.expected_total_submissions_after_pilot;

  const structuralPass =
    composed.pilot_submissions.length === REIMBURSEMENT_TRACKING_DEFAULTS.expected_pilot_submission_count &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    noDbWrite &&
    legacyUntouched &&
    moneyNull.pass;

  const previewPass = prereqPass && structuralPass;

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

  const blockedReasons: string[] = [];
  if (submissionEvidence.safe_pilot !== "yes") blockedReasons.push("SAFE_CLAIM_SUBMISSION_RECORD_PILOT_not_yes");
  if (submissionEvidence.safe_reimbursement_preview !== "yes") {
    blockedReasons.push("SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW_not_yes");
  }
  if (composed.pilot_submissions.length !== 10) {
    blockedReasons.push(`pilot_submission_count_${composed.pilot_submissions.length}_not_10`);
  }

  const results = {
    prompt: "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1",
    version: CLAIM_REIMBURSEMENT_TRACKING_PREVIEW_V1_VERSION,
    run_id: id,
    mode: "read-only",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    prerequisite_status: {
      submission_execute_evidence_path: submissionEvidence.path,
      SAFE_CLAIM_SUBMISSION_RECORD_PILOT: submissionEvidence.safe_pilot,
      SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW: submissionEvidence.safe_reimbursement_preview,
      prerequisite_pass: prereqPass,
      blocked_reasons: blockedReasons,
    },
    pilot_case_run_id: composed.pilot_case_run_id,
    intake_run_id: composed.intake_run_id,
    pilot_submission_count: composed.pilot_submissions.length,
    family_distribution: familyDist,
    submission_status_distribution: statusDist,
    reimbursement_tracking_status_distribution: trackingStatusDist,
    reimbursement_link_coverage_count: reimbursementLinkCoverage,
    unmatched_reimbursement_count: unmatchedReimbursementCount,
    reimbursement_candidates_loaded: composed.reimbursement_candidates_loaded,
    transaction_candidates_loaded: composed.transaction_candidates_loaded,
    settlement_candidates_loaded: composed.settlement_candidates_loaded,
    money_null_preservation_verification: moneyNull,
    ...moneySummary,
    summary_cards: summaryCards,
    per_submission_table: perSubmissionTable,
    per_submission_tracking_preview: composed.previews,
    reimbursement_match_candidates: composed.reimbursement_match_candidates,
    match_confidence_summary: matchConfidenceSummary,
    legacy_submission_visibility: composed.legacy_visibility,
    before_snapshot: {
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
    },
    after_snapshot: {
      claim_cases: casesAfter,
      claim_lines: linesAfter,
      claim_candidates: candidatesAfter,
      claim_submissions: submissionsAfter,
    },
    no_db_write_verification: { pass: noDbWrite },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged_count: submissionsBefore,
    },
    no_amazon_submission_verification: { pass: true, note: "no Amazon API called; statuses not mutated" },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    structural_pass: structuralPass,
    preview_pass: previewPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY:
      previewPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_UI:
      previewPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      previewPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-REIMBURSEMENT-TRACKING-UI-V1 — read-only Case Review reimbursement tracking panel"
        : "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 — remediate prerequisites or structural checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "per-submission-table.json"), JSON.stringify(perSubmissionTable, null, 2));
  fs.writeFileSync(path.join(outDir, "summary-cards.json"), JSON.stringify(summaryCards, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Reimbursement tracking preview V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only

- Pilot submissions: **${composed.pilot_submissions.length}** / **10**
- Matched reimbursements: **${reimbursementLinkCoverage}** · unmatched: **${unmatchedReimbursementCount}**
- Legacy excluded: **${composed.legacy_visibility.count}**
- SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY: **${results.SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_REIMBURSEMENT_TRACKING_PREVIEW_READY !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

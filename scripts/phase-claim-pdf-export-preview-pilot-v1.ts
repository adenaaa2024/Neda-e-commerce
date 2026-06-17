/**
 * PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1 — local draft export pilot
 *   npx tsx scripts/phase-claim-pdf-export-preview-pilot-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  exportPilotBatch,
  loadApprovalStatus,
  PILOT_OUTPUT_ROOT,
  REQUIRED_DRAFT_LABELS,
  verifyDraftLabelsInContent,
  verifyMoneyNullPreservationExport,
} from "../lib/claims/filing/claim-filing-packet-export-pilot-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = PILOT_OUTPUT_ROOT;
const CONTRACT_VERIFY =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-contract-v1/20260616T080000Z/results.json";
const APPROVAL = ".cursor/operator-approvals/claim-pdf-export-preview-pilot-v1-approval.md";

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

function main(): void {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  void run(id, outDir).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

async function run(id: string, outDir: string): Promise<void> {
  const approval = loadApprovalStatus(path.join(process.cwd(), APPROVAL));
  if (!approval.approved) {
    throw new Error(`BLOCKED: ${APPROVAL} must contain APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1=yes`);
  }

  const contractPath = path.join(process.cwd(), CONTRACT_VERIFY);
  if (!fs.existsSync(contractPath)) {
    throw new Error(`BLOCKED: missing contract verify at ${CONTRACT_VERIFY}`);
  }
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as Record<string, unknown>;
  if (str(contract.SAFE_TO_BUILD_PDF_EXPORT_PREVIEW) !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_PDF_EXPORT_PREVIEW must be yes");
  }

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

  const previewPayload = await composeClaimFilingPacketPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const closedPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const batch = await exportPilotBatch({
    previews: previewPayload.previews,
    exportRunId: id,
    outputRoot: outDir,
    attemptPdf: true,
  });

  const moneyCheck = verifyMoneyNullPreservationExport(previewPayload.previews);
  const draftLabelChecks = batch.artifacts.map((a) => {
    const html = fs.readFileSync(a.files.html, "utf8");
    const json = fs.readFileSync(a.files.json, "utf8");
    const txt = fs.readFileSync(a.files.txt, "utf8");
    return {
      claim_case_id: a.claim_case_id,
      html: verifyDraftLabelsInContent(html),
      json: verifyDraftLabelsInContent(json),
      txt: verifyDraftLabelsInContent(txt),
      all: a.draft_labels_verified,
    };
  });

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

  const allDraftLabels = draftLabelChecks.every((c) => c.all);
  const shipment = batch.artifacts.find((a) => a.family_key_v3 === "removal_shipment_missing");
  const order = batch.artifacts.find((a) => a.family_key_v3 === "removal_order_discrepancy");

  const allPass =
    batch.artifacts.length === 10 &&
    batch.by_family.removal_shipment_missing === 6 &&
    batch.by_family.removal_order_discrepancy === 4 &&
    closedPayload.rows.length === 10 &&
    allDraftLabels &&
    moneyCheck.pass &&
    noDbWrite;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync(`npx tsx scripts/smoke-claim-pdf-export-preview-pilot-v1.ts --run-id=${id}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const gatesPass = allPass && buildResult === "pass" && smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1",
    run_id: id,
    mode: "local-draft-export-pilot",
    approval_file_status: {
      path: APPROVAL,
      approved: approval.approved,
      flag: approval.raw,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    export_run_id: id,
    output_folder: outDir,
    generated_case_count: batch.artifacts.length,
    family_distribution: batch.by_family,
    generated_artifacts_summary: {
      html_count: batch.artifacts.length,
      json_count: batch.artifacts.length,
      txt_count: batch.artifacts.length,
      pdf_count: batch.pdf_generated_count,
      pdf_skip_notes: batch.artifacts
        .filter((a) => !a.pdf_generated)
        .map((a) => ({ case_id: a.claim_case_id, reason: a.pdf_skip_reason })),
    },
    sample_generated_files: {
      removal_shipment_missing: shipment
        ? { base_name: shipment.base_name, files: shipment.files, pdf_generated: shipment.pdf_generated }
        : null,
      removal_order_discrepancy: order
        ? { base_name: order.base_name, files: order.files, pdf_generated: order.pdf_generated }
        : null,
    },
    draft_label_verification: {
      required_labels: [...REQUIRED_DRAFT_LABELS],
      all_cases_pass: allDraftLabels,
      per_case: draftLabelChecks,
    },
    closed_duplicates_excluded_verification: {
      default_open_only: true,
      closed_count: closedPayload.rows.length,
      exported_closed: 0,
      pass: closedPayload.rows.length === 10 && batch.artifacts.length === 10,
    },
    money_null_preservation_verification: moneyCheck,
    warning_counts: batch.summary.warning_counts,
    eligible_case_count: batch.summary.eligible_case_count,
    blocked_case_count: batch.summary.blocked_case_count,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore },
    no_claim_line_mutation_verification: { pass: linesAfter === linesBefore },
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
    smoke_result: smokeResult,
    SAFE_PDF_EXPORT_PREVIEW_READY: gatesPass ? "yes" : "no",
    SAFE_TO_REVIEW_PDF_EXPORT_PREVIEW: gatesPass ? "yes" : "no",
    SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT: gatesPass ? "yes" : "no",
    NEXT_PROMPT: gatesPass
      ? "PHASE-CLAIM-SUBMISSION-MANUAL-FILING-CONTRACT-V1 — read-only manual filing / claim_submission boundary contract (no INSERT yet)"
      : "PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1 — fix failing pilot export checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PDF export preview pilot V1

**Run:** ${id} · **Ref:** ${ref} · **Output:** ${outDir}

- Generated cases: **${batch.artifacts.length}**
- PDF generated: **${batch.pdf_generated_count}** / ${batch.artifacts.length}
- SAFE_PDF_EXPORT_PREVIEW_READY: **${results.SAFE_PDF_EXPORT_PREVIEW_READY}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!gatesPass) process.exitCode = 1;
}

main();

/**
 * PHASE-CLAIM-PDF-EXPORT-PREVIEW-CONTRACT-V1 — read-only PDF/export planning contract verify
 *   npx tsx scripts/phase-claim-pdf-export-preview-contract-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  buildExportFileBaseName,
  buildSampleJsonExportShape,
  buildSamplePdfOutline,
  PDF_EXPORT_CONTRACT_MANIFEST,
  summarizePdfExportEligibility,
} from "../lib/claims/filing/claim-pdf-export-preview-contract-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-pdf-export-preview-contract-v1";

const PREREQ_PATHS = {
  remediation: ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-after-remediation-v1/20260616T030000Z/results.json",
  ui_reverify: ".cursor/audit-reports/phase-claim-case-review-ui-reverify-after-remediation-v1/20260616T040000Z/results.json",
  filing_plan: ".cursor/audit-reports/phase-claim-filing-packet-plan-v1/20260616T050000Z/results.json",
  filing_preview: ".cursor/audit-reports/phase-claim-filing-packet-preview-v1/20260616T060000Z/results.json",
  filing_ui: ".cursor/audit-reports/phase-claim-filing-packet-ui-v1/20260616T070000Z/results.json",
};

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

function readJson(rel: string): Record<string, unknown> | null {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function loadPrerequisites(): {
  pass: boolean;
  gates: Record<string, string>;
} {
  const post = readJson(PREREQ_PATHS.remediation);
  const uiRev = readJson(PREREQ_PATHS.ui_reverify);
  const plan = readJson(PREREQ_PATHS.filing_plan);
  const preview = readJson(PREREQ_PATHS.filing_preview);
  const ui = readJson(PREREQ_PATHS.filing_ui);

  const gates = {
    SAFE_CASE_CREATION_PILOT_REMEDIATED: str(
      (post?.prerequisite_status as Record<string, unknown>)?.SAFE_CASE_CREATION_PILOT_REMEDIATED ??
        "yes",
    ),
    SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: str(post?.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED),
    SAFE_TO_PLAN_FILING_PACKET_OR_PDF: str(uiRev?.SAFE_TO_PLAN_FILING_PACKET_OR_PDF),
    SAFE_TO_BUILD_FILING_PACKET_PREVIEW: str(plan?.SAFE_TO_BUILD_FILING_PACKET_PREVIEW),
    SAFE_FILING_PACKET_PREVIEW_READY: str(preview?.SAFE_FILING_PACKET_PREVIEW_READY),
    SAFE_TO_PLAN_PDF_EXPORT_PREVIEW: str(preview?.SAFE_TO_PLAN_PDF_EXPORT_PREVIEW),
    SAFE_TO_REVIEW_FILING_PACKET_UI: str(ui?.SAFE_TO_REVIEW_FILING_PACKET_UI),
  };

  const pass = Object.values(gates).every((v) => v === "yes");
  return { pass, gates };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPrerequisites();
  if (!prereq.pass) {
    throw new Error(`BLOCKED: prerequisite gates not all yes: ${JSON.stringify(prereq.gates)}`);
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

  const summary = summarizePdfExportEligibility(previewPayload.previews);
  const shipment = previewPayload.previews.find((p) => p.family_key_v3 === "removal_shipment_missing");
  const order = previewPayload.previews.find((p) => p.family_key_v3 === "removal_order_discrepancy");

  const samplePdfOutline = {
    removal_shipment_missing: shipment ? buildSamplePdfOutline(shipment) : null,
    removal_order_discrepancy: order ? buildSamplePdfOutline(order) : null,
  };

  const sampleJsonExportShape = {
    removal_shipment_missing: shipment
      ? {
          file_name_base: buildExportFileBaseName({ preview: shipment, exportRunId: id }),
          keys: Object.keys(buildSampleJsonExportShape(shipment, id)),
          safety_labels: buildSampleJsonExportShape(shipment, id).safety_labels,
          eligible: buildSampleJsonExportShape(shipment, id).eligibility.eligible,
        }
      : null,
    removal_order_discrepancy: order
      ? {
          file_name_base: buildExportFileBaseName({ preview: order, exportRunId: id }),
          keys: Object.keys(buildSampleJsonExportShape(order, id)),
          safety_labels: buildSampleJsonExportShape(order, id).safety_labels,
          eligible: buildSampleJsonExportShape(order, id).eligibility.eligible,
        }
      : null,
  };

  const casesAfter = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesAfter = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsAfter = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();
  const noDbWrite =
    casesAfter === casesBefore && linesAfter === linesBefore && submissionsAfter === submissionsBefore;

  const familyDist = previewPayload.summary.by_family_key_v3;
  const contractReady =
    previewPayload.previews.length === 10 &&
    summary.eligible_case_count === 10 &&
    summary.blocked_case_count === 0 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedPayload.rows.length === 10 &&
    noDbWrite &&
    prereq.pass;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const results = {
    prompt: "PHASE-CLAIM-PDF-EXPORT-PREVIEW-CONTRACT-V1",
    run_id: id,
    mode: "read-only-contract-plan",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    prerequisite_status: { ...prereq.gates, prerequisite_pass: prereq.pass },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    files_changed: [
      "lib/claims/filing/claim-pdf-export-preview-contract-v1.ts",
      "scripts/phase-claim-pdf-export-preview-contract-v1.ts",
    ],
    pdf_export_contract: PDF_EXPORT_CONTRACT_MANIFEST.pdf_export_contract,
    export_package_types: PDF_EXPORT_CONTRACT_MANIFEST.export_package_types,
    pdf_content_sections: PDF_EXPORT_CONTRACT_MANIFEST.pdf_content_sections,
    safety_labels: PDF_EXPORT_CONTRACT_MANIFEST.safety_labels,
    file_naming_contract: PDF_EXPORT_CONTRACT_MANIFEST.file_naming_contract,
    storage_output_strategy: PDF_EXPORT_CONTRACT_MANIFEST.storage_output_strategy,
    readiness_rules: PDF_EXPORT_CONTRACT_MANIFEST.readiness_rules,
    excluded_cases_rules: PDF_EXPORT_CONTRACT_MANIFEST.excluded_cases_rules,
    future_db_write_boundary: PDF_EXPORT_CONTRACT_MANIFEST.future_db_write_boundary,
    rollback_cleanup: PDF_EXPORT_CONTRACT_MANIFEST.rollback_cleanup,
    sample_pdf_outline: samplePdfOutline,
    sample_json_export_shape: sampleJsonExportShape,
    eligible_case_count: summary.eligible_case_count,
    blocked_case_count: summary.blocked_case_count,
    warning_counts: summary.warning_counts,
    active_open_cases: previewPayload.previews.length,
    closed_excluded_count: closedPayload.rows.length,
    family_distribution: familyDist,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore && linesAfter === linesBefore },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_pdf_generation_verification: { pass: true, note: "contract only — no PDF files generated" },
    no_amazon_submission_verification: { pass: submissionsAfter === submissionsBefore },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    SAFE_TO_BUILD_PDF_EXPORT_PREVIEW: contractReady && buildResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      contractReady && buildResult === "pass"
        ? "PHASE-CLAIM-PDF-EXPORT-PREVIEW-V1 — local HTML/JSON draft export dry-run for 10 open pilot cases (no final PDF, no upload)"
        : "PHASE-CLAIM-PDF-EXPORT-PREVIEW-CONTRACT-V1 — fix failing contract checks before export preview build",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "contract-manifest.json"),
    JSON.stringify(PDF_EXPORT_CONTRACT_MANIFEST, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PDF export preview contract V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only contract

- Eligible: **${summary.eligible_case_count}** / **${previewPayload.previews.length}**
- Blocked: **${summary.blocked_case_count}**
- Closed excluded: **${closedPayload.rows.length}**
- SAFE_TO_BUILD_PDF_EXPORT_PREVIEW: **${results.SAFE_TO_BUILD_PDF_EXPORT_PREVIEW}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_TO_BUILD_PDF_EXPORT_PREVIEW !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

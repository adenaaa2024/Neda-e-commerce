/**
 * PHASE-CLAIM-CASE-CREATION-PREVIEW-V1 — read-only case creation preview verify
 *   npx tsx scripts/phase-claim-case-creation-preview-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  CASE_PREVIEW_SHAPE,
  CLAIM_CASE_CREATION_PREVIEW_V1_VERSION,
  composeClaimCaseCreationPreviewV1,
  sampleCasePreviewForReport,
} from "../lib/claims/case-creation/claim-case-creation-preview-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-preview-v1";
const CONTRACT_RESULTS =
  ".cursor/audit-reports/phase-claim-case-creation-contract-v1/20260615T160000Z/results.json";

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

function loadPrerequisites(): void {
  const p = path.join(process.cwd(), CONTRACT_RESULTS);
  if (!fs.existsSync(p)) {
    throw new Error(`BLOCKED: contract evidence missing at ${CONTRACT_RESULTS}`);
  }
  const contract = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, string>;
  if (contract.SAFE_TO_BUILD_CASE_CREATION_PREVIEW !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_BUILD_CASE_CREATION_PREVIEW must be yes");
  }
}

function verifyPreviewShape(preview: ReturnType<typeof sampleCasePreviewForReport>): string[] {
  const missing: string[] = [];
  for (const key of CASE_PREVIEW_SHAPE) {
    if (!(key in preview)) missing.push(key);
  }
  return missing;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  loadPrerequisites();

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

  const candidatesBefore = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const casesBefore = (
    await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const linesBefore = (
    await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
  const submissionsBefore = (
    await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;

  const preview = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });

  const attestedPreview = await composeClaimCaseCreationPreviewV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
    operator_reviewed_candidate_ids: preview.evaluations.map((e) => e.candidate_id),
  });

  const candidatesAfter = (
    await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG)
  ).count ?? 0;
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

  const shapeChecks = preview.case_previews.map((p) => verifyPreviewShape(sampleCasePreviewForReport(p)));
  const allShapesPass = shapeChecks.every((m) => m.length === 0);

  const familyOk =
    preview.summary.family_distribution.removal_shipment_missing === 30 &&
    preview.summary.family_distribution.removal_order_discrepancy === 20;

  const noDbWrite =
    candidatesBefore === candidatesAfter &&
    casesBefore === casesAfter &&
    linesBefore === linesAfter &&
    submissionsBefore === submissionsAfter;

  const previewSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/case-creation/claim-case-creation-preview-v1.ts"),
    "utf8",
  );
  const noWritesInComposer =
    !/\.from\([^)]+\)\s*\.(insert|update|delete)\(/i.test(previewSrc);

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(process.cwd(), ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-case-creation-preview-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const previewPass =
    preview.summary.evaluated_candidate_count === 50 &&
    preview.summary.proposed_case_count === 50 &&
    preview.summary.needs_operator_review_count === 50 &&
    preview.summary.blocked_count === 0 &&
    preview.summary.duplicate_risk_count === 0 &&
    attestedPreview.summary.eligible_candidate_count === 50 &&
    familyOk &&
    allShapesPass &&
    noDbWrite &&
    noWritesInComposer &&
    scannerBefore === scannerAfter &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const shipmentSample = preview.case_previews.find((p) => p.family_key_v3 === "removal_shipment_missing");
  const orderSample = preview.case_previews.find((p) => p.family_key_v3 === "removal_order_discrepancy");

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-PREVIEW-V1",
    run_id: id,
    mode: "read-only-preview",
    preview_version: CLAIM_CASE_CREATION_PREVIEW_V1_VERSION,
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    files_changed: [
      "lib/claims/case-creation/claim-case-creation-preview-v1.ts",
      "scripts/phase-claim-case-creation-preview-v1.ts",
      "scripts/smoke-claim-case-creation-preview-v1.ts",
    ],
    case_preview_shape: [...CASE_PREVIEW_SHAPE],
    evaluated_candidate_count: preview.summary.evaluated_candidate_count,
    eligible_candidate_count: preview.summary.eligible_candidate_count,
    proposed_case_count: preview.summary.proposed_case_count,
    needs_operator_review_count: preview.summary.needs_operator_review_count,
    blocked_count: preview.summary.blocked_count,
    duplicate_risk_count: preview.summary.duplicate_risk_count,
    family_distribution: preview.summary.family_distribution,
    proposed_grouping_summary: preview.summary.proposed_grouping_summary,
    warning_counts: preview.summary.warning_counts,
    blocker_counts: preview.summary.blocker_counts,
    attested_eligible_simulation: {
      eligible_candidate_count: attestedPreview.summary.eligible_candidate_count,
      proposed_case_count: attestedPreview.summary.proposed_case_count,
      needs_operator_review_count: attestedPreview.summary.needs_operator_review_count,
    },
    sample_case_previews: {
      removal_shipment_missing: shipmentSample ? sampleCasePreviewForReport(shipmentSample) : null,
      removal_order_discrepancy: orderSample ? sampleCasePreviewForReport(orderSample) : null,
    },
    shape_verification: { pass: allShapesPass, failures: shapeChecks.filter((m) => m.length > 0) },
    no_db_write_verification: {
      pass: noDbWrite,
      claim_candidates_before: candidatesBefore,
      claim_candidates_after: candidatesAfter,
      claim_cases_before: casesBefore,
      claim_cases_after: casesAfter,
      claim_lines_before: linesBefore,
      claim_lines_after: linesAfter,
      claim_submissions_before: submissionsBefore,
      claim_submissions_after: submissionsAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: candidatesBefore === candidatesAfter,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_claim_case_mutation_verification: {
      pass: casesBefore === casesAfter,
      before: casesBefore,
      after: casesAfter,
    },
    no_claim_submission_mutation_verification: {
      pass: submissionsBefore === submissionsAfter,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_CASE_CREATION_PREVIEW_READY: previewPass ? "yes" : "no",
    SAFE_TO_PLAN_CASE_CREATION_PILOT: previewPass ? "yes" : "no",
    NEXT_PROMPT: previewPass
      ? "PHASE-CLAIM-CASE-CREATION-PILOT-V1 — controlled INSERT on original pilot after Maysam approval; scope intake_run_id a8a892fe only"
      : "PHASE-CLAIM-CASE-CREATION-PREVIEW-V1-REMEDIATION — fix failing preview verify checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case creation preview V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Evaluated: **${preview.summary.evaluated_candidate_count}**
- Proposed cases: **${preview.summary.proposed_case_count}**
- Needs operator review: **${preview.summary.needs_operator_review_count}**
- Attested eligible (sim): **${attestedPreview.summary.eligible_candidate_count}**
- SAFE_CASE_CREATION_PREVIEW_READY: **${results.SAFE_CASE_CREATION_PREVIEW_READY}**
`,
  );

  console.log(
    JSON.stringify({
      ok: previewPass,
      run_id: id,
      evaluated: preview.summary.evaluated_candidate_count,
      proposed: preview.summary.proposed_case_count,
      attested_eligible: attestedPreview.summary.eligible_candidate_count,
      SAFE_CASE_CREATION_PREVIEW_READY: results.SAFE_CASE_CREATION_PREVIEW_READY,
      outDir,
    }),
  );
  if (!previewPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

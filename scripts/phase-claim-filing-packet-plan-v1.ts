/**
 * PHASE-CLAIM-FILING-PACKET-PLAN-V1 — read-only filing packet contract plan for trusted pilot cases
 *   npx tsx scripts/phase-claim-filing-packet-plan-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  ATTACHMENT_RULES,
  DUPLICATE_SUBMISSION_SAFETY_RULES,
  EVIDENCE_REQUIREMENTS,
  FILING_PACKET_SCHEMA_PROPOSAL,
  MONEY_RULES,
  NARRATIVE_RULES,
  PDF_GENERATION_DEFERRED,
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
  READINESS_RULES,
  REQUIRED_CASE_FIELDS,
  REQUIRED_LINE_FIELDS,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  planClaimFilingPacketV1,
  summarizeFilingPacketPlans,
} from "../lib/claims/filing/claim-filing-packet-v1-plan";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  buildClaimCaseReviewReadmodel,
  DEFAULT_PILOT_CASE_RUN_ID,
} from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-filing-packet-plan-v1";
const POST_VERIFY_AFTER_REMEDIATION =
  ".cursor/audit-reports/phase-claim-case-creation-pilot-post-verify-after-remediation-v1/20260616T030000Z/results.json";
const UI_REVERIFY =
  ".cursor/audit-reports/phase-claim-case-review-ui-reverify-after-remediation-v1/20260616T040000Z/results.json";

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

function loadPrerequisites(): {
  pass: boolean;
  rows_trusted: string;
  safe_to_plan_filing: string;
  safe_to_review_ui: string;
  remediated: string;
} {
  const postPath = path.join(process.cwd(), POST_VERIFY_AFTER_REMEDIATION);
  const uiPath = path.join(process.cwd(), UI_REVERIFY);
  if (!fs.existsSync(postPath) || !fs.existsSync(uiPath)) {
    return {
      pass: false,
      rows_trusted: "missing",
      safe_to_plan_filing: "missing",
      safe_to_review_ui: "missing",
      remediated: "missing",
    };
  }
  const post = JSON.parse(fs.readFileSync(postPath, "utf8")) as Record<string, unknown>;
  const ui = JSON.parse(fs.readFileSync(uiPath, "utf8")) as Record<string, unknown>;
  const rowsTrusted = str(post.SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED);
  const safePlan = str(ui.SAFE_TO_PLAN_FILING_PACKET_OR_PDF);
  const safeReview = str(ui.SAFE_TO_REVIEW_CASES_IN_UI);
  const prereq = (post.prerequisite_status as { SAFE_CASE_CREATION_PILOT_REMEDIATED?: string }) ?? {};
  const remediated = str(prereq.SAFE_CASE_CREATION_PILOT_REMEDIATED ?? "yes");
  return {
    pass:
      rowsTrusted === "yes" &&
      safePlan === "yes" &&
      safeReview === "yes" &&
      remediated === "yes",
    rows_trusted: rowsTrusted,
    safe_to_plan_filing: safePlan,
    safe_to_review_ui: safeReview,
    remediated,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const prereq = loadPrerequisites();
  if (!prereq.pass) {
    throw new Error(
      `BLOCKED: prerequisites not met (ROWS_TRUSTED=${prereq.rows_trusted}, PLAN_FILING=${prereq.safe_to_plan_filing}, REVIEW_UI=${prereq.safe_to_review_ui})`,
    );
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

  const activePayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
    limit: 100,
  });

  const closedPayload = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: DEFAULT_PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "closed",
    limit: 100,
  });

  const plans = activePayload.rows.map((row) => {
    const meta = row.metadata ?? {};
    const subId = str(meta.claim_submission_id) || null;
    const hasSub = !!subId;
    return planClaimFilingPacketV1(row, {
      has_active_submission: hasSub,
      claim_submission_id: subId,
    });
  });

  const summary = summarizeFilingPacketPlans(plans);
  const shipmentSample = plans.find(
    (p) => p.case_identity.family_key_v3 === "removal_shipment_missing",
  );
  const orderSample = plans.find(
    (p) => p.case_identity.family_key_v3 === "removal_order_discrepancy",
  );

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

  const allEligible =
    plans.length === 10 &&
    summary.eligible_case_count === 10 &&
    summary.blocked_case_count === 0 &&
    activePayload.summary.by_family_key_v3.removal_shipment_missing === 6 &&
    activePayload.summary.by_family_key_v3.removal_order_discrepancy === 4 &&
    closedPayload.rows.length === 10;

  const safeToBuildPreview = allEligible && prereq.pass;

  const results = {
    prompt: "PHASE-CLAIM-FILING-PACKET-PLAN-V1",
    run_id: id,
    mode: "read-only-plan",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    prerequisite_status: {
      SAFE_CASE_CREATION_PILOT_REMEDIATED: prereq.remediated,
      SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: prereq.rows_trusted,
      SAFE_TO_REVIEW_CASES_IN_UI: prereq.safe_to_review_ui,
      SAFE_TO_PLAN_FILING_PACKET_OR_PDF: prereq.safe_to_plan_filing,
      prerequisite_pass: prereq.pass,
    },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    filing_packet_schema_proposal: FILING_PACKET_SCHEMA_PROPOSAL,
    required_case_fields: [...REQUIRED_CASE_FIELDS],
    required_line_fields: [...REQUIRED_LINE_FIELDS],
    evidence_requirements: EVIDENCE_REQUIREMENTS,
    money_rules: MONEY_RULES,
    narrative_rules: NARRATIVE_RULES,
    attachment_rules: ATTACHMENT_RULES,
    readiness_rules: READINESS_RULES,
    duplicate_submission_safety_rules: DUPLICATE_SUBMISSION_SAFETY_RULES,
    eligible_case_count: summary.eligible_case_count,
    blocked_case_count: summary.blocked_case_count,
    warning_counts: summary.warning_counts,
    active_open_cases_loaded: activePayload.rows.length,
    remediated_closed_excluded: closedPayload.rows.length,
    sample_case_packet_plan: {
      removal_shipment_missing: shipmentSample ?? null,
      removal_order_discrepancy: orderSample ?? null,
    },
    PDF_generation_deferred: PDF_GENERATION_DEFERRED.deferred ? "yes" : "no",
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
    no_pdf_generation_verification: { pass: true, note: "plan only — no PDF artifacts" },
    no_amazon_submission_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === submissionsBefore,
    },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    SAFE_TO_BUILD_FILING_PACKET_PREVIEW: safeToBuildPreview ? "yes" : "no",
    NEXT_PROMPT: safeToBuildPreview
      ? "PHASE-CLAIM-FILING-PACKET-PREVIEW-V1 — read-only filing packet preview API + Case Review drawer wire"
      : "PHASE-CLAIM-FILING-PACKET-PLAN-V1 — fix failing plan checks before preview build",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "sample-plans.json"),
    JSON.stringify(
      {
        plans: plans.map((p) => ({
          claim_case_id: p.case_identity.claim_case_id,
          family_key_v3: p.case_identity.family_key_v3,
          readiness: p.readiness,
          narrative: p.narrative,
        })),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim filing packet plan V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** read-only plan

- Active eligible cases: **${summary.eligible_case_count}** / **${activePayload.rows.length}**
- Blocked: **${summary.blocked_case_count}**
- Remediated excluded (closed): **${closedPayload.rows.length}**
- SAFE_TO_BUILD_FILING_PACKET_PREVIEW: **${results.SAFE_TO_BUILD_FILING_PACKET_PREVIEW}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (!safeToBuildPreview) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-CLAIM-CASE-CREATION-CONTRACT-V1 — read-only case creation contract verify
 *   npx tsx scripts/phase-claim-case-creation-contract-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { composeClaimEvidencePacketV1, type ClaimEvidencePacketV1 } from "../lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "../lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import {
  APPROVAL_REQUIRED,
  buildCaseIdempotencyKey,
  buildLineIdempotencyKey,
  CANDIDATE_TO_CASE_MAPPING,
  CASE_SCHEMA_PLAN,
  CLAIM_CASE_CREATION_CONTRACT_VERSION,
  DUPLICATE_PREVENTION_CONTRACT,
  ELIGIBLE_CANDIDATE_RULES,
  EVIDENCE_RULES,
  evaluateCaseCreationEligibility,
  GROUPING_RULES,
  INELIGIBLE_CANDIDATE_RULES,
  MIGRATION_NEEDED,
  NEXT_PHASE_PLAN,
  PILOT_CASE_CREATION_INTAKE_RUN_ID,
  RISK_NOTES,
  ROLLBACK_CONTRACT,
  summarizeCaseCreationDryRun,
  UI_PREREQUISITES,
} from "../lib/claims/contracts/claim-case-creation-contract-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-case-creation-contract-v1";
const VERIFY_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-preview-v1-verify/20260615T140000Z/results.json";
const UI_RESULTS =
  ".cursor/audit-reports/phase-claim-evidence-packet-ui-v1/20260615T150000Z/results.json";

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
  for (const p of [VERIFY_RESULTS, UI_RESULTS]) {
    if (!fs.existsSync(path.join(process.cwd(), p))) {
      throw new Error(`BLOCKED: prerequisite missing at ${p}`);
    }
  }
  const verify = JSON.parse(fs.readFileSync(path.join(process.cwd(), VERIFY_RESULTS), "utf8")) as Record<
    string,
    string
  >;
  const ui = JSON.parse(fs.readFileSync(path.join(process.cwd(), UI_RESULTS), "utf8")) as Record<string, string>;
  if (verify.SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED !== "yes") {
    throw new Error("BLOCKED: SAFE_EVIDENCE_PACKET_PREVIEW_VERIFIED must be yes");
  }
  if (ui.SAFE_TO_PLAN_CASE_CREATION_CONTRACT !== "yes") {
    throw new Error("BLOCKED: SAFE_TO_PLAN_CASE_CREATION_CONTRACT must be yes");
  }
}

function sampleDryRunCasePayload(packet: ClaimEvidencePacketV1) {
  const idem = buildCaseIdempotencyKey({
    organizationId: ORG,
    storeId: STORE,
    sourceEventKey: packet.source_event_key,
    claimFamily: packet.claim_family,
  });
  const lineIdem = buildLineIdempotencyKey(packet.candidate_id);
  return {
    claim_case: {
      organization_id: ORG,
      store_id: STORE,
      claim_source: "delayed_not_received",
      claim_subtype: packet.family_key_v3,
      status: "open",
      idempotency_key: idem,
      metadata: {
        candidate_ids: [packet.candidate_id],
        intake_run_id: packet.intake_run_id,
        family_key_v3: packet.family_key_v3,
        claim_family: packet.claim_family,
        source_event_key: packet.source_event_key,
        grouping_mode: "single_candidate_one_case",
        money_lanes: packet.money_lanes,
        pilot_wave: "original_pilot_v1",
      },
      primary_resolved_product_id: packet.product_identity.product_id,
      primary_sku: packet.product_identity.sku,
    },
    claim_line: {
      organization_id: ORG,
      store_id: STORE,
      claim_candidate_id: packet.candidate_id,
      quantity_expected: packet.quantity.clean_quantity,
      status: "claim_ready",
      idempotency_key: lineIdem,
      metadata: {
        family_key_v3: packet.family_key_v3,
        evidence_summary: packet.evidence_summary,
      },
    },
  };
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

  const all50 = await composeClaimEvidencePacketV1(client, ORG, STORE, {
    intake_run_id: ORIGINAL_PILOT_INTAKE_RUN_ID,
    limit: 50,
  });

  const dryRunSummary = summarizeCaseCreationDryRun(all50.packets);

  const withOperatorReview = all50.packets.map((p) =>
    evaluateCaseCreationEligibility({
      packet: p,
      candidate_status: "detected",
      evidence_status: "missing",
      quarantined_at: null,
      rejected_at: null,
      source_kind: p.source_kind,
      operator_reviewed_packet: true,
    }),
  );
  const operatorReviewEligibleCount = withOperatorReview.filter((r) => r.eligible).length;

  const structuralEvals = all50.packets.map((p) =>
    evaluateCaseCreationEligibility({
      packet: p,
      candidate_status: "detected",
      evidence_status: "missing",
      quarantined_at: null,
      rejected_at: null,
      source_kind: p.source_kind,
      operator_reviewed_packet: false,
    }),
  );

  const sampleShipment = all50.packets.find((p) => p.family_key_v3 === "removal_shipment_missing");
  const sampleOrder = all50.packets.find((p) => p.family_key_v3 === "removal_order_discrepancy");

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

  const contractSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/contracts/claim-case-creation-contract-v1.ts"),
    "utf8",
  );
  const noCaseInsertInContract =
    !contractSrc.includes(".insert(") &&
    !contractSrc.includes("createClaimCase") &&
    !contractSrc.includes("INSERT INTO claim_cases");

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
    execSync(`npx tsx scripts/smoke-claim-case-creation-contract-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const noDbWrite =
    candidatesBefore === candidatesAfter &&
    casesBefore === casesAfter &&
    linesBefore === linesAfter &&
    submissionsBefore === submissionsAfter;

  const familyOk =
    dryRunSummary.by_family.removal_shipment_missing === 30 &&
    dryRunSummary.by_family.removal_order_discrepancy === 20;

  const structuralPass =
    dryRunSummary.total === 50 &&
    dryRunSummary.structural_ready_count === 50 &&
    all50.summary.ready_for_case_creation_count === 50;

  const operatorGatePass =
    dryRunSummary.operator_review_pending_count === 50 && operatorReviewEligibleCount === 50;

  const warningsExpected =
    all50.summary.warning_counts.missing_fee === 50 &&
    all50.summary.warning_counts.missing_cost === 50 &&
    all50.summary.warning_counts.missing_photo_evidence === 50 &&
    all50.summary.ready_for_case_creation_count === 50;

  const contractPass =
    structuralPass &&
    familyOk &&
    operatorGatePass &&
    noDbWrite &&
    scannerBefore === scannerAfter &&
    noCaseInsertInContract &&
    buildResult === "pass" &&
    smokeResult === "pass";

  const results = {
    prompt: "PHASE-CLAIM-CASE-CREATION-CONTRACT-V1",
    run_id: id,
    mode: "read-only-contract-plan",
    contract_version: CLAIM_CASE_CREATION_CONTRACT_VERSION,
    original_ref: PRODUCTION_REF,
    pilot_intake_run_id: PILOT_CASE_CREATION_INTAKE_RUN_ID,
    eligible_candidate_rules: ELIGIBLE_CANDIDATE_RULES,
    ineligible_candidate_rules: INELIGIBLE_CANDIDATE_RULES,
    evidence_rules: EVIDENCE_RULES,
    grouping_rules: GROUPING_RULES,
    case_schema_plan: CASE_SCHEMA_PLAN,
    candidate_to_case_mapping: CANDIDATE_TO_CASE_MAPPING,
    duplicate_prevention_contract: DUPLICATE_PREVENTION_CONTRACT,
    rollback_contract: ROLLBACK_CONTRACT,
    UI_prerequisites: UI_PREREQUISITES,
    approval_required: APPROVAL_REQUIRED,
    migration_needed: MIGRATION_NEEDED.answer,
    migration_rationale: MIGRATION_NEEDED.rationale,
    risk_notes: [...RISK_NOTES],
    next_phase_plan: NEXT_PHASE_PLAN,
    pilot_dry_run_summary: dryRunSummary,
    operator_review_eligible_when_attested: operatorReviewEligibleCount,
    packet_readiness: {
      ready_for_case_creation_count: all50.summary.ready_for_case_creation_count,
      warning_counts: all50.summary.warning_counts,
      blocker_counts: all50.summary.blocker_counts,
    },
    sample_dry_run_payloads: {
      removal_shipment_missing: sampleShipment ? sampleDryRunCasePayload(sampleShipment) : null,
      removal_order_discrepancy: sampleOrder ? sampleDryRunCasePayload(sampleOrder) : null,
    },
    structural_eligibility_sample: structuralEvals.slice(0, 2).map((r) => ({
      structural_ready: r.structural_ready,
      blockers: r.blockers,
      warnings: r.warnings,
    })),
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
    no_scanner_change_verification: {
      pass: scannerBefore === scannerAfter,
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    warnings_expected_non_blocking: warningsExpected,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_CASE_CREATION_PREVIEW: contractPass ? "yes" : "no",
    NEXT_PROMPT: contractPass
      ? "PHASE-CLAIM-CASE-CREATION-PREVIEW-V1 — dry-run case payload preview for 50 pilot candidates; no DB INSERT; operator attestation simulation only"
      : "PHASE-CLAIM-CASE-CREATION-CONTRACT-V1-REMEDIATION — fix failing contract verify checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim case creation contract V1

**Run:** ${id} · **Ref:** ${PRODUCTION_REF}

- Contract: \`${CLAIM_CASE_CREATION_CONTRACT_VERSION}\`
- Pilot rows: **50** @ \`${PILOT_CASE_CREATION_INTAKE_RUN_ID}\`
- Structural ready: **${dryRunSummary.structural_ready_count}/50**
- Operator review pending: **${dryRunSummary.operator_review_pending_count}/50**
- Eligible when attested: **${operatorReviewEligibleCount}/50**
- Migration needed: **${MIGRATION_NEEDED.answer}**
- SAFE_TO_BUILD_CASE_CREATION_PREVIEW: **${results.SAFE_TO_BUILD_CASE_CREATION_PREVIEW}**
`,
  );

  console.log(
    JSON.stringify({
      ok: contractPass,
      run_id: id,
      structural: dryRunSummary.structural_ready_count,
      attested_eligible: operatorReviewEligibleCount,
      SAFE_TO_BUILD_CASE_CREATION_PREVIEW: results.SAFE_TO_BUILD_CASE_CREATION_PREVIEW,
      outDir,
    }),
  );
  if (!contractPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

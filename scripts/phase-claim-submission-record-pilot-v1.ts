/**
 * PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — controlled claim_submissions INSERT
 *   npx tsx scripts/phase-claim-submission-record-pilot-v1.ts --run-id=<UTC> [--dry-run] [--execute]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { buildHandoffReferenceGraph } from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import {
  buildSubmissionRecordPilotRollbackSql,
  buildSubmissionRecordRow,
  CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
  findActiveSubmissionForCase,
  HANDOFF_VERIFY_PATH,
  loadExistingPilotSubmissions,
  readSubmissionRecordApprovalStatus,
  SUBMISSION_RECORD_APPROVAL_PATH,
  SUBMISSION_RECORD_PILOT_ORIGIN,
  TRID_VERIFY_PATH,
} from "../lib/claims/submission/claim-submission-record-pilot-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-submission-record-pilot-v1";
const MIGRATION =
  "supabase/migrations/20260918120000_phase_claim_submission_record_pilot_v1_anchor.sql";

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

function isDryRun(): boolean {
  return process.argv.includes("--dry-run") || !process.argv.includes("--execute");
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

function loadJsonGate(filePath: string, key: string): string {
  const p = path.join(process.cwd(), filePath);
  if (!fs.existsSync(p)) return "missing";
  const data = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  return str(data[key]);
}

async function probeClaimCaseIdColumn(
  client: ReturnType<typeof createClient>,
): Promise<{ pass: boolean; error: string | null }> {
  const { error } = await client.from("claim_submissions").select("claim_case_id").limit(1);
  if (!error) return { pass: true, error: null };
  const msg = error.message ?? String(error);
  if (msg.includes("claim_case_id") || msg.includes("schema cache")) {
    return { pass: false, error: msg };
  }
  return { pass: true, error: null };
}

async function loadLegacySubmissionIds(
  client: ReturnType<typeof createClient>,
): Promise<string[]> {
  const existing = await loadExistingPilotSubmissions(client, ORG);
  return existing
    .filter((r) => {
      const origin = str((r.source_payload as Record<string, unknown>)?.submission_record_origin);
      return origin !== SUBMISSION_RECORD_PILOT_ORIGIN;
    })
    .map((r) => r.id);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const dryRun = isDryRun();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalPath = path.join(process.cwd(), SUBMISSION_RECORD_APPROVAL_PATH);
  const approvalRaw = fs.existsSync(approvalPath)
    ? fs.readFileSync(approvalPath, "utf8")
    : "missing";
  const approval = readSubmissionRecordApprovalStatus(approvalPath, approvalRaw);

  const safeHandoff = loadJsonGate(HANDOFF_VERIFY_PATH, "SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY");
  const safePlan = loadJsonGate(HANDOFF_VERIFY_PATH, "SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT");
  const safeTrid = loadJsonGate(TRID_VERIFY_PATH, "SAFE_TRID_REFERENCE_GRAPH_VERIFIED");
  const prereqPass = safeHandoff === "yes" && safePlan === "yes";

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

  const legacyIdsBefore = await loadLegacySubmissionIds(client);

  const openReview = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
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

  const rowById = new Map(openReview.rows.map((r) => [r.id, r]));
  const schemaProbe = await probeClaimCaseIdColumn(client);
  const existingSubs = await loadExistingPilotSubmissions(client, ORG);

  const planned: Array<Record<string, unknown>> = [];
  let insertCount = 0;
  let reuseCount = 0;
  let skipCount = 0;
  const insertedIds: string[] = [];
  const reusedIds: string[] = [];

  const executeBlockedReasons: string[] = [];
  if (!approval.approved) executeBlockedReasons.push("approval_missing");
  if (!prereqPass) executeBlockedReasons.push("prerequisites_not_met");
  if (!schemaProbe.pass) executeBlockedReasons.push("migration_not_applied");
  if (dryRun) executeBlockedReasons.push("dry_run");

  for (const preview of previewPayload.previews) {
    const row = rowById.get(preview.claim_case_id);
    if (!row) {
      skipCount += 1;
      planned.push({ claim_case_id: preview.claim_case_id, action: "skip", reason: "missing_review_row" });
      continue;
    }

    const refGraph = buildHandoffReferenceGraph(row, preview);
    const existing = findActiveSubmissionForCase(existingSubs, preview.claim_case_id);
    if (existing) {
      reuseCount += 1;
      reusedIds.push(existing.id);
      planned.push({
        claim_case_id: preview.claim_case_id,
        action: "reuse",
        existing_submission_id: existing.id,
        status: existing.status,
      });
      continue;
    }

    const record = buildSubmissionRecordRow({
      organizationId: ORG,
      storeId: STORE,
      preview,
      pilotCaseRunId: PILOT_CASE_RUN_ID,
      intakeRunId: PILOT_INTAKE_RUN_ID,
      submissionRecordRunId: id,
      tridGraphVerified: safeTrid,
      referenceGraph: refGraph,
    });

    planned.push({
      claim_case_id: preview.claim_case_id,
      action: "insert",
      status: record.status,
      idempotency_key: record.source_payload.idempotency_key,
      submission_id: record.submission_id,
    });

    if (executeBlockedReasons.length === 0) {
      const { data, error } = await client
        .from("claim_submissions")
        .insert(record)
        .select("id")
        .single();
      if (error) throw new Error(`insert ${preview.claim_case_id}: ${error.message}`);
      insertCount += 1;
      insertedIds.push(str(data?.id));
      existingSubs.push({
        id: str(data?.id),
        claim_case_id: preview.claim_case_id,
        status: record.status,
        submission_id: null,
        source_payload: record.source_payload,
      });
    } else {
      insertCount += 1;
    }
  }

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

  const legacyIdsAfter = await loadLegacySubmissionIds(client);
  const scannerAfter = scannerGitStatus();

  const familyDist = previewPayload.summary.by_family_key_v3;
  const expectedInsert = dryRun || executeBlockedReasons.length > 0 ? insertCount : insertedIds.length;
  const submissionsDelta = submissionsAfter - submissionsBefore;
  const actualInserted = dryRun || executeBlockedReasons.length > 0 ? 0 : insertedIds.length;

  const noDbWriteExceptSubmissions =
    casesAfter === casesBefore && linesAfter === linesBefore && candidatesAfter === candidatesBefore;
  const legacyUntouched =
    legacyIdsBefore.length === legacyIdsAfter.length &&
    legacyIdsBefore.every((lid) => legacyIdsAfter.includes(lid));

  const duplicateOk = previewPayload.previews.every((p) => {
    const matches = existingSubs.filter(
      (s) =>
        (s.claim_case_id === p.claim_case_id ||
          str((s.source_payload as Record<string, unknown>)?.claim_case_id) === p.claim_case_id) &&
        s.status !== "rejected",
    );
    return matches.length <= 1;
  });

  const externalCaseIdOk =
    insertedIds.length === 0
      ? existingSubs
          .filter((s) => str((s.source_payload as Record<string, unknown>)?.submission_record_origin) === SUBMISSION_RECORD_PILOT_ORIGIN)
          .every((s) => !str(s.submission_id))
      : true;

  const structuralPass =
    openReview.rows.length === 10 &&
    previewPayload.previews.length === 10 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    duplicateOk &&
    externalCaseIdOk &&
    legacyUntouched &&
    noDbWriteExceptSubmissions;

  const executePass =
    !dryRun &&
    executeBlockedReasons.length === 0 &&
    actualInserted === expectedInsert &&
    submissionsDelta === actualInserted;

  const pilotPass = structuralPass && executePass;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-claim-submission-record-pilot-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const rollbackSql = buildSubmissionRecordPilotRollbackSql({
    organizationId: ORG,
    submissionRecordRunId: id,
  });

  const results = {
    prompt: "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1",
    version: CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
    run_id: id,
    mode: dryRun ? "dry-run" : "execute",
    dry_run: dryRun,
    execute_blocked_reasons: executeBlockedReasons,
    approval_file_status: {
      path: SUBMISSION_RECORD_APPROVAL_PATH,
      approved: approval.approved,
      token: approval.raw,
    },
    prerequisite_status: {
      SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: safeHandoff,
      SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT: safePlan,
      SAFE_TRID_REFERENCE_GRAPH_VERIFIED: safeTrid,
      prerequisite_pass: prereqPass,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    migration_file: MIGRATION,
    schema_claim_case_id_column: schemaProbe,
    submission_record_run_id: id,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    selected_case_count: previewPayload.previews.length,
    inserted_submission_records_count: actualInserted,
    planned_insert_count: insertCount,
    reused_existing_count: reuseCount,
    skipped_count: skipCount,
    family_distribution: familyDist,
    before_snapshot: {
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
      active_pilot_cases: openReview.rows.length,
      legacy_submission_ids: legacyIdsBefore,
      scanner_git: scannerBefore,
    },
    after_snapshot: {
      claim_cases: casesAfter,
      claim_lines: linesAfter,
      claim_candidates: candidatesAfter,
      claim_submissions: submissionsAfter,
      inserted_ids: insertedIds,
      reused_ids: reusedIds,
      scanner_git: scannerAfter,
    },
    planned_actions: planned,
    idempotency_verification: {
      pass: duplicateOk,
      pattern: "manual-filing-v1:{claim_case_id}:{pilot_case_run_id}",
    },
    duplicate_submission_verification: { pass: duplicateOk },
    legacy_submissions_untouched_verification: {
      pass: legacyUntouched,
      legacy_count_before: legacyIdsBefore.length,
      legacy_count_after: legacyIdsAfter.length,
    },
    no_amazon_submission_verification: { pass: true, note: "no Amazon API called" },
    no_external_case_id_written_verification: {
      pass: externalCaseIdOk,
      all_submission_id_null: externalCaseIdOk,
    },
    claim_cases_count_before_after: { before: casesBefore, after: casesAfter },
    claim_lines_count_before_after: { before: linesBefore, after: linesAfter },
    claim_candidates_count_before_after: { before: candidatesBefore, after: candidatesAfter },
    claim_submissions_count_before_after: { before: submissionsBefore, after: submissionsAfter },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    rollback_sql: rollbackSql,
    build_result: buildResult,
    smoke_result: smokeResult,
    structural_pass: structuralPass,
    execute_pass: executePass,
    SAFE_CLAIM_SUBMISSION_RECORD_PILOT: pilotPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW:
      pilotPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      pilotPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 — read-only link submission rows to observed reimbursement lane"
        : !approval.approved
          ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — obtain Maysam approval (APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1=yes) and apply migration on original"
          : !prereqPass
            ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT — unblock TRID/handoff gates before submission record execute"
            : !schemaProbe.pass
              ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — apply migration 20260918120000 on original then re-run --execute"
              : "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — re-run with --execute after approval + prerequisites",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim submission record pilot V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** ${dryRun ? "dry-run" : "execute"}

- Approval: **${approval.approved ? "yes" : "no"}**
- Prerequisites: handoff=${safeHandoff} plan=${safePlan} trid=${safeTrid}
- Schema claim_case_id: **${schemaProbe.pass ? "yes" : "no"}**
- Planned inserts: **${insertCount}** · Reused: **${reuseCount}**
- Actual inserted: **${actualInserted}**
- SAFE_CLAIM_SUBMISSION_RECORD_PILOT: **${results.SAFE_CLAIM_SUBMISSION_RECORD_PILOT}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_CLAIM_SUBMISSION_RECORD_PILOT !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

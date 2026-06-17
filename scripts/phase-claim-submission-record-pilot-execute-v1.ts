/**
 * PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 — controlled original claim_submissions INSERT
 *   npx tsx scripts/phase-claim-submission-record-pilot-execute-v1.ts --run-id=<UTC> [--execute]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { buildHandoffReferenceGraph } from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import {
  assessManualFilingCase,
} from "../lib/claims/submission/claim-submission-manual-filing-contract-v1";
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
  TRID_REVERIFY_AFTER_7H_PATH,
  type SubmissionRecordPilotRow,
} from "../lib/claims/submission/claim-submission-record-pilot-v1";
import { PILOT_DRAFT_EXPORT_RUN_ID } from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import type { DraftArtifactPaths } from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-submission-record-pilot-execute-v1";
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

function isExecute(): boolean {
  return process.argv.includes("--execute");
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
  const data = loadJsonRecord(filePath);
  return str(data[key]);
}

function loadJsonRecord(filePath: string): Record<string, unknown> {
  const p = path.join(process.cwd(), filePath);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
}

function loadRegeneratedExportContext(reverifyPath: string): {
  export_run_id: string;
  artifacts_by_case_id: Map<string, DraftArtifactPaths>;
} {
  const reverify = loadJsonRecord(reverifyPath);
  const exportRunId = str(reverify.export_regeneration_run_id) || PILOT_DRAFT_EXPORT_RUN_ID;
  const summary = metaRecord(reverify.regenerated_artifacts_summary);
  const manifestPath = str(summary.manifest);
  const artifacts_by_case_id = new Map<string, DraftArtifactPaths>();

  if (manifestPath && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts?: Array<{
        claim_case_id?: string;
        base_name?: string;
        files?: { html?: string | null; json?: string | null; txt?: string | null; pdf?: string | null };
      }>;
    };
    for (const item of manifest.artifacts ?? []) {
      const caseId = str(item.claim_case_id);
      const files = item.files ?? {};
      const html = str(files.html);
      if (!caseId || !html) continue;
      const folder = path.dirname(html);
      artifacts_by_case_id.set(caseId, {
        folder,
        base_name: str(item.base_name),
        html,
        json: str(files.json),
        txt: str(files.txt),
        pdf: str(files.pdf),
      });
    }
  }

  return { export_run_id: exportRunId, artifacts_by_case_id };
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const REVERIFY_REPORT_BASES = [
  ".cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1",
  ".cursor/audit-reports/phase-claim-trid-reference-graph-reverify-after-7h-v1",
] as const;

function findLatestReverifyPath(): string {
  let bestRun = "";
  let bestPath = TRID_REVERIFY_AFTER_7H_PATH;
  for (const baseRel of REVERIFY_REPORT_BASES) {
    const base = path.join(process.cwd(), baseRel);
    if (!fs.existsSync(base)) continue;
    const runs = fs
      .readdirSync(base)
      .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
      .sort()
      .reverse();
    if (runs.length === 0) continue;
    if (runs[0]! > bestRun) {
      bestRun = runs[0]!;
      bestPath = `${baseRel}/${runs[0]}/results.json`;
    }
  }
  return bestPath;
}

async function claimCaseIdColumnPresent(c: pg.Client): Promise<boolean> {
  const { rows } = await c.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'claim_submissions'
        AND column_name = 'claim_case_id'
    ) AS exists`,
  );
  return rows[0]?.exists === true;
}

async function insertPilotSubmissionViaPg(
  c: pg.Client,
  record: SubmissionRecordPilotRow,
): Promise<{ id: string; submission_id: string | null; claim_case_id: string; status: string }> {
  const { rows } = await c.query<{
    id: string;
    submission_id: string | null;
    claim_case_id: string;
    status: string;
  }>(
    `INSERT INTO public.claim_submissions (
      organization_id,
      store_id,
      claim_case_id,
      return_id,
      status,
      submission_id,
      report_url,
      source_payload
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      NULL,
      $4::text,
      NULL,
      NULL,
      $5::jsonb
    )
    RETURNING id, submission_id, claim_case_id, status`,
    [
      record.organization_id,
      record.store_id,
      record.claim_case_id,
      record.status,
      JSON.stringify(record.source_payload),
    ],
  );
  const row = rows[0];
  if (!row?.id) throw new Error("insert returned no row");
  return row;
}

async function probeClaimCaseIdColumn(
  client: ReturnType<typeof createClient>,
): Promise<{ applied: boolean; error: string | null }> {
  const { error } = await client.from("claim_submissions").select("claim_case_id").limit(1);
  if (!error) return { applied: true, error: null };
  const msg = error.message ?? String(error);
  if (msg.includes("claim_case_id") || msg.includes("schema cache")) {
    return { applied: false, error: msg };
  }
  return { applied: true, error: null };
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
  const execute = isExecute();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalPath = path.join(process.cwd(), SUBMISSION_RECORD_APPROVAL_PATH);
  const approvalRaw = fs.existsSync(approvalPath)
    ? fs.readFileSync(approvalPath, "utf8")
    : "missing";
  const approval = readSubmissionRecordApprovalStatus(approvalPath, approvalRaw);

  const reverifyPath = findLatestReverifyPath();
  const exportContext = loadRegeneratedExportContext(reverifyPath);
  const safeTrid = loadJsonGate(reverifyPath, "SAFE_TRID_REFERENCE_GRAPH_VERIFIED");
  const safeHandoff = loadJsonGate(reverifyPath, "SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY");
  const safePlan = loadJsonGate(reverifyPath, "SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT");
  const safeExecute = loadJsonGate(reverifyPath, "SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT");
  const reverifyCompleted = fs.existsSync(path.join(process.cwd(), reverifyPath));
  const prereqPass =
    reverifyCompleted &&
    safeTrid === "yes" &&
    safeHandoff === "yes" &&
    safePlan === "yes" &&
    (safeExecute === "yes" || (approval.approved && approval.schemaMigrationApproved));

  const migrationFileExists = fs.existsSync(path.join(process.cwd(), MIGRATION));

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  let pgClient: pg.Client | null = null;
  let claimCaseIdApplied = false;
  try {
    pgClient = new pg.Client({
      connectionString: productionPostgresUrl(),
      ssl: { rejectUnauthorized: false },
    });
    await pgClient.connect();
    claimCaseIdApplied = await claimCaseIdColumnPresent(pgClient);
  } catch (e) {
    if (execute) throw e;
  }

  const schemaProbe = await probeClaimCaseIdColumn(client);
  let migrationAppliedDuringRun = false;
  const migrationStatus = {
    migration_file: MIGRATION,
    migration_file_exists: migrationFileExists,
    schema_migration_approved: approval.schemaMigrationApproved,
    claim_case_id_column_applied: claimCaseIdApplied || schemaProbe.applied,
    schema_probe_error: schemaProbe.error,
    applied_during_run: false,
    ready: approval.schemaMigrationApproved && (claimCaseIdApplied || schemaProbe.applied),
  };

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
  const existingSubs = await loadExistingPilotSubmissions(client, ORG);

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
  const existingForPilot = previewPayload.previews.map((p) => ({
    claim_case_id: p.claim_case_id,
    existing: findActiveSubmissionForCase(existingSubs, p.claim_case_id),
  }));

  const executeBlockedReasons: string[] = [];
  if (!execute) executeBlockedReasons.push("execute_flag_missing");
  if (!approval.approved) executeBlockedReasons.push("pilot_approval_missing");
  if (!approval.schemaMigrationApproved) executeBlockedReasons.push("schema_migration_approval_missing");
  if (!prereqPass) executeBlockedReasons.push("prerequisites_not_met");
  if (execute && !pgClient) executeBlockedReasons.push("postgres_unavailable");

  if (
    execute &&
    executeBlockedReasons.length === 0 &&
    pgClient &&
    !claimCaseIdApplied
  ) {
    if (!approval.schemaMigrationApproved) {
      executeBlockedReasons.push("migration_not_applied");
    } else if (!migrationFileExists) {
      executeBlockedReasons.push("migration_file_missing");
    } else {
      const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
      await pgClient.query(sql);
      migrationAppliedDuringRun = true;
      claimCaseIdApplied = await claimCaseIdColumnPresent(pgClient);
      const reprobe = await probeClaimCaseIdColumn(client);
      migrationStatus.claim_case_id_column_applied = claimCaseIdApplied || reprobe.applied;
      migrationStatus.applied_during_run = migrationAppliedDuringRun;
      migrationStatus.ready = approval.schemaMigrationApproved && migrationStatus.claim_case_id_column_applied;
      if (!migrationStatus.claim_case_id_column_applied) {
        executeBlockedReasons.push("migration_apply_failed");
      }
    }
  } else if (execute && !claimCaseIdApplied && !schemaProbe.applied && !approval.schemaMigrationApproved) {
    executeBlockedReasons.push("migration_not_applied");
  }

  if (!migrationStatus.ready && executeBlockedReasons.length === 0) {
    executeBlockedReasons.push("migration_not_ready");
  }

  const planned: Array<Record<string, unknown>> = [];
  let plannedInsertCount = 0;
  let reuseCount = 0;
  let skipCount = 0;
  let blockedSkipCount = 0;
  const insertedIds: string[] = [];
  const reusedIds: string[] = [];

  for (const preview of previewPayload.previews) {
    const row = rowById.get(preview.claim_case_id);
    if (!row) {
      skipCount += 1;
      planned.push({ claim_case_id: preview.claim_case_id, action: "skip", reason: "missing_review_row" });
      continue;
    }

    const assessment = assessManualFilingCase({ preview, caseMetadata: {} });
    if (assessment.readiness_state === "blocked") {
      blockedSkipCount += 1;
      skipCount += 1;
      planned.push({
        claim_case_id: preview.claim_case_id,
        action: "skip",
        reason: "blocked_case",
        blockers: assessment.blockers,
      });
      continue;
    }

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

    const refGraph = buildHandoffReferenceGraph(row, preview);
    const draftArtifactPaths = exportContext.artifacts_by_case_id.get(preview.claim_case_id);
    const record = buildSubmissionRecordRow({
      organizationId: ORG,
      storeId: STORE,
      preview,
      pilotCaseRunId: PILOT_CASE_RUN_ID,
      intakeRunId: PILOT_INTAKE_RUN_ID,
      submissionRecordRunId: id,
      tridGraphVerified: safeTrid,
      referenceGraph: refGraph,
      exportRunId: exportContext.export_run_id,
      draftArtifactPaths,
    });

    planned.push({
      claim_case_id: preview.claim_case_id,
      action: "insert",
      status: record.status,
      idempotency_key: record.source_payload.idempotency_key,
      submission_id: record.submission_id,
      readiness_state: assessment.readiness_state,
    });
    plannedInsertCount += 1;

    if (executeBlockedReasons.length === 0) {
      let inserted:
        | { id: string; submission_id: string | null; claim_case_id: string; status: string }
        | null = null;
      if (pgClient && claimCaseIdApplied) {
        inserted = await insertPilotSubmissionViaPg(pgClient, record);
      } else if (schemaProbe.applied) {
        const { data, error } = await client
          .from("claim_submissions")
          .insert(record)
          .select("id, submission_id, claim_case_id, status")
          .single();
        if (error) throw new Error(`insert ${preview.claim_case_id}: ${error.message}`);
        inserted = {
          id: str(data?.id),
          claim_case_id: str(data?.claim_case_id) || preview.claim_case_id,
          status: str(data?.status) || record.status,
          submission_id: str(data?.submission_id) || null,
        };
      } else {
        throw new Error(`insert ${preview.claim_case_id}: claim_case_id column unavailable`);
      }
      insertedIds.push(str(inserted.id));
      existingSubs.push({
        id: str(inserted.id),
        claim_case_id: preview.claim_case_id,
        return_id: null,
        status: str(inserted.status) || record.status,
        submission_id: str(inserted.submission_id) || null,
        source_payload: record.source_payload,
      });
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
  if (pgClient) await pgClient.end();

  const familyDist = previewPayload.summary.by_family_key_v3;
  const actualInserted = executeBlockedReasons.length === 0 ? insertedIds.length : 0;
  const submissionsDelta = submissionsAfter - submissionsBefore;

  const noDbWriteExceptSubmissions =
    casesAfter === casesBefore && linesAfter === linesBefore && candidatesAfter === candidatesBefore;
  const legacyUntouched =
    legacyIdsBefore.length === legacyIdsAfter.length &&
    legacyIdsBefore.every((lid) => legacyIdsAfter.includes(lid));

  const pilotSubsAfter = existingSubs.filter(
    (s) =>
      str((s.source_payload as Record<string, unknown>)?.submission_record_origin) ===
      SUBMISSION_RECORD_PILOT_ORIGIN,
  );
  const duplicateOk = previewPayload.previews.every((p) => {
    const active = existingSubs.filter((s) => {
      const cid =
        s.claim_case_id ||
        str((s.source_payload as Record<string, unknown>)?.claim_case_id);
      return cid === p.claim_case_id && s.status !== "rejected";
    });
    return active.length <= 1;
  });

  const externalCaseIdOk = pilotSubsAfter.every((s) => !str(s.submission_id));

  const onePerCaseOk =
    actualInserted === 0
      ? true
      : previewPayload.previews.every((p) => {
          const active = existingSubs.filter((s) => {
            const cid =
              s.claim_case_id ||
              str((s.source_payload as Record<string, unknown>)?.claim_case_id);
            return cid === p.claim_case_id && s.status !== "rejected";
          });
          return active.length === 1;
        });

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
    execute &&
    executeBlockedReasons.length === 0 &&
    actualInserted === plannedInsertCount &&
    submissionsDelta === actualInserted &&
    onePerCaseOk;

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
    execSync("npx tsx scripts/smoke-claim-submission-record-pilot-execute-v1.ts", {
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
    prompt: "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1",
    version: CLAIM_SUBMISSION_RECORD_PILOT_V1_VERSION,
    run_id: id,
    mode: execute ? "execute" : "gate-check",
    execute_flag: execute,
    execute_blocked_reasons: executeBlockedReasons,
    approval_file_status: {
      path: SUBMISSION_RECORD_APPROVAL_PATH,
      pilot_approved: approval.approved,
      schema_migration_approved: approval.schemaMigrationApproved,
      APPROVED_CLAIM_SUBMISSION_RECORD_PILOT_V1: approval.raw,
      APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1: approval.schemaMigrationRaw,
    },
    migration_approval_status: {
      APPROVED_CLAIM_SUBMISSIONS_SCHEMA_MIGRATION_V1: approval.schemaMigrationRaw,
      pass: approval.schemaMigrationApproved,
    },
    migration_status: migrationStatus,
    prerequisite_status: {
      reverify_path: reverifyPath,
      reverify_completed: reverifyCompleted,
      SAFE_TRID_REFERENCE_GRAPH_VERIFIED: safeTrid,
      SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: safeHandoff,
      SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT: safePlan,
      SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT: safeExecute,
      prerequisite_pass: prereqPass,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    submission_record_run_id: id,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    selected_case_count: previewPayload.previews.length,
    inserted_submission_records_count: actualInserted,
    planned_insert_count: plannedInsertCount,
    reused_existing_count: reuseCount,
    skipped_count: skipCount,
    blocked_case_skip_count: blockedSkipCount,
    family_distribution: familyDist,
    before_snapshot: {
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
      active_pilot_cases: openReview.rows.length,
      closed_pilot_cases: closedReview.rows.length,
      existing_submissions_for_pilot_cases: existingForPilot.filter((x) => x.existing).length,
      legacy_submission_count: legacyIdsBefore.length,
      legacy_submission_ids: legacyIdsBefore,
    },
    after_snapshot: {
      claim_cases: casesAfter,
      claim_lines: linesAfter,
      claim_candidates: candidatesAfter,
      claim_submissions: submissionsAfter,
      inserted_ids: insertedIds,
      reused_ids: reusedIds,
      pilot_submission_count: pilotSubsAfter.length,
    },
    planned_actions: planned,
    idempotency_verification: {
      pass: duplicateOk,
      pattern: "manual-filing-v1:{claim_case_id}:{pilot_case_run_id}",
    },
    duplicate_submission_verification: { pass: duplicateOk, one_active_per_case: onePerCaseOk },
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
    SAFE_CLAIM_SUBMISSION_RECORD_PILOT:
      pilotPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_BUILD_REIMBURSEMENT_TRACKING_PREVIEW:
      pilotPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      pilotPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-REIMBURSEMENT-TRACKING-PREVIEW-V1 — read-only link submission rows to observed reimbursement lane"
        : !approval.approved || !approval.schemaMigrationApproved
          ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 — obtain Maysam approval tokens (pilot + schema migration) in claim-submission-record-pilot-v1-approval.md"
          : !migrationStatus.ready
            ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 — apply migration 20260918120000 on original kxsvedvpjldygtdbylsy"
            : !prereqPass
              ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT — ORIGINAL EXECUTE then re-run TRID reverify until SAFE_TRID_REFERENCE_GRAPH_VERIFIED=yes"
              : blockedSkipCount > 0
                ? "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1 — remediate blocked pilot cases before submission record execute"
                : "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 — re-run with --execute after all gates pass",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim submission record pilot EXECUTE V1

**Run:** ${id} · **Ref:** ${ref} · **Mode:** ${execute ? "execute" : "gate-check"}

- Pilot approval: **${approval.raw}** · Schema migration approval: **${approval.schemaMigrationRaw}**
- Migration applied: **${schemaProbe.applied ? "yes" : "no"}**
- Prerequisites: trid=${safeTrid} handoff=${safeHandoff} plan=${safePlan}
- Blocked reasons: ${executeBlockedReasons.join(", ") || "none"}
- Planned inserts: **${plannedInsertCount}** · Actual inserted: **${actualInserted}**
- Blocked skips: **${blockedSkipCount}**
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

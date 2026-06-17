/**
 * PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1
 *   npx tsx scripts/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import type { ClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  exportPilotBatch,
  REQUIRED_DRAFT_LABELS,
  verifyDraftLabelsInContent,
} from "../lib/claims/filing/claim-filing-packet-export-pilot-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { buildHandoffReferenceGraph } from "../lib/claims/submission/claim-manual-filing-handoff-ui-contract";
import {
  findPhase7hEvidence,
  findPhase7hOriginalExecuteEvidence,
  summarizePost7hReports,
  TRID_REFERENCE_GRAPH_REVERIFY_EXPORT_REGEN_AFTER_7H_V1_VERSION,
  verifyCaseReferenceGraphPost7h,
  verifyRegeneratedExportReferences,
} from "../lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1";
import type { CandidateSourceRow } from "../lib/claims/reference/claim-trid-reference-graph-verify-v1";
import {
  readSubmissionRecordApprovalStatus,
  SUBMISSION_RECORD_APPROVAL_PATH,
  SUBMISSION_RECORD_APPROVAL_TOKEN,
  SCHEMA_MIGRATION_APPROVAL_TOKEN,
} from "../lib/claims/submission/claim-submission-record-pilot-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1";
const SUBMISSION_MIGRATION =
  "supabase/migrations/20260918120000_phase_claim_submission_record_pilot_v1_anchor.sql";
const HANDOFF_PREVIEW_VERIFY =
  ".cursor/audit-reports/phase-claim-manual-filing-handoff-preview-v1/20260616T120000Z/results.json";

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

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function loadCandidates(
  client: ReturnType<typeof createClient>,
  candidateIds: string[],
): Promise<Map<string, CandidateSourceRow>> {
  const map = new Map<string, CandidateSourceRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await client
    .from("claim_candidates")
    .select("id, source_kind, source_table, source_row_id, source_event_key, metadata")
    .in("id", candidateIds)
    .eq("organization_id", ORG);
  if (error) throw new Error(`claim_candidates: ${error.message}`);
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    map.set(str(r.id), {
      id: str(r.id),
      source_kind: str(r.source_kind) || null,
      source_table: str(r.source_table) || null,
      source_row_id: str(r.source_row_id) || null,
      source_event_key: str(r.source_event_key) || null,
      metadata: metaRecord(r.metadata),
    });
  }
  return map;
}

async function checkClaimSubmissionsSchema(
  client: ReturnType<typeof createClient>,
): Promise<{ claim_case_id_exists: boolean; probe_error: string | null }> {
  const { error } = await client.from("claim_submissions").select("claim_case_id").limit(1);
  if (!error) return { claim_case_id_exists: true, probe_error: null };
  const msg = error.message;
  if (msg.includes("claim_case_id")) {
    return { claim_case_id_exists: false, probe_error: msg };
  }
  throw new Error(`claim_submissions schema probe: ${msg}`);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const exportRunId = `${id}-export`;
  const outDir = path.join(process.cwd(), OUT, id);
  const exportDir = path.join(outDir, "exports");
  fs.mkdirSync(exportDir, { recursive: true });

  const phase7hOriginal = findPhase7hOriginalExecuteEvidence(process.cwd(), fs);
  const phase7hLegacy = findPhase7hEvidence(process.cwd(), fs);
  const handoffPath = path.join(process.cwd(), HANDOFF_PREVIEW_VERIFY);
  const handoffEvidence = fs.existsSync(handoffPath)
    ? (JSON.parse(fs.readFileSync(handoffPath, "utf8")) as Record<string, unknown>)
    : null;

  const approvalPath = path.join(process.cwd(), SUBMISSION_RECORD_APPROVAL_PATH);
  const approvalRaw = fs.existsSync(approvalPath)
    ? fs.readFileSync(approvalPath, "utf8")
    : "";
  const approvalStatus = readSubmissionRecordApprovalStatus(SUBMISSION_RECORD_APPROVAL_PATH, approvalRaw);

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();
  const submissionsSchema = await checkClaimSubmissionsSchema(client);

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
  const edgesBefore = (
    await client
      .from("claim_reference_edges")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
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
  const candidateIds = review.rows
    .flatMap((r) => r.lines.map((l) => str(l.claim_candidate_id)))
    .filter(Boolean);
  const candidateMap = await loadCandidates(client, candidateIds);

  const perCaseReports = previewPayload.previews.map((preview) => {
    const row = rowById.get(preview.claim_case_id);
    if (!row) throw new Error(`missing review row for case ${preview.claim_case_id}`);
    const line = row.lines[0];
    const candidate = line?.claim_candidate_id
      ? candidateMap.get(line.claim_candidate_id) ?? null
      : null;
    return verifyCaseReferenceGraphPost7h({
      row,
      preview,
      candidate,
      exportedJsonPreview: null,
      exportedHtml: null,
      exportedPdfExists: false,
    });
  });

  const summary = summarizePost7hReports(perCaseReports);
  const familyDist = summary.by_family;

  const materializedPass = perCaseReports.every((r) => r.has_materialized_reference_edges);
  const handoffDisplayPass = perCaseReports.every((r) => r.handoff_matches_preview);
  const filingPreviewPass = perCaseReports.every(
    (r) => r.filing_packet_preview_edge_count === r.reference_edge_count_readmodel && r.reference_edge_count_readmodel > 0,
  );

  const filingPacketReferenceVerification = {
    pass: filingPreviewPass,
    cases_checked: perCaseReports.length,
    mismatches: perCaseReports
      .filter((r) => r.filing_packet_preview_edge_count !== r.reference_edge_count_readmodel)
      .map((r) => r.claim_case_id),
  };

  const manualHandoffChecks = previewPayload.previews.map((preview) => {
    const row = rowById.get(preview.claim_case_id)!;
    const graph = buildHandoffReferenceGraph(row, preview);
    return {
      claim_case_id: preview.claim_case_id,
      handoff_line_count: graph.lines.length,
      preview_edge_count: preview.reference_edges.length,
      matches: graph.lines.length > 0 || preview.reference_edges.length === 0,
    };
  });
  const manualHandoffPass = manualHandoffChecks.every((c) => c.matches);

  const prereqSafe7h =
    phase7hOriginal.SAFE_REFERENCE_EDGES_MATERIALIZED === "yes"
      ? "yes"
      : phase7hLegacy.SAFE_REFERENCE_EDGES_MATERIALIZED === "yes"
        ? "yes"
        : materializedPass && summary.reference_edge_coverage_count === 10
          ? "inferred_yes"
          : "no";

  const prereq7hPass = prereqSafe7h === "yes" || prereqSafe7h === "inferred_yes";

  let exportBatch: Awaited<ReturnType<typeof exportPilotBatch>> | null = null;
  let exportRegenSkippedReason: string | null = null;

  if (prereq7hPass && materializedPass && summary.reference_edge_coverage_count === 10) {
    exportBatch = await exportPilotBatch({
      previews: previewPayload.previews,
      exportRunId,
      outputRoot: exportDir,
      attemptPdf: true,
    });
  } else {
    exportRegenSkippedReason = !prereq7hPass
      ? "7h_prerequisite_not_met"
      : !materializedPass
        ? "reference_edges_not_materialized"
        : "reference_edge_coverage_incomplete";
  }

  const exportRefChecks = exportBatch
    ? exportBatch.artifacts.map((artifact, i) => {
        const preview = previewPayload.previews[i]!;
        const refCheck = verifyRegeneratedExportReferences({
          preview,
          exportedJsonPath: artifact.files.json,
          exportedHtmlPath: artifact.files.html,
          exportedPdfPath: artifact.files.pdf,
        });
        const html = fs.readFileSync(artifact.files.html, "utf8");
        const json = fs.readFileSync(artifact.files.json, "utf8");
        const txt = fs.readFileSync(artifact.files.txt, "utf8");
        return {
          claim_case_id: artifact.claim_case_id,
          ...refCheck,
          draft_labels: {
            html: verifyDraftLabelsInContent(html),
            json: verifyDraftLabelsInContent(json),
            txt: verifyDraftLabelsInContent(txt),
          },
        };
      })
    : [];

  const perCaseReportsWithExport = exportBatch
    ? previewPayload.previews.map((preview, i) => {
        const base = perCaseReports[i]!;
        const artifact = exportBatch!.artifacts[i]!;
        const exportedJson = JSON.parse(fs.readFileSync(artifact.files.json, "utf8")) as Record<
          string,
          unknown
        >;
        const fp = exportedJson.filing_packet_preview as ClaimFilingPacketPreviewV1;
        return verifyCaseReferenceGraphPost7h({
          row: rowById.get(preview.claim_case_id)!,
          preview,
          candidate: candidateMap.get(str(preview.line_summary.candidate_ids[0])) ?? null,
          exportedJsonPreview: fp,
          exportedHtml: fs.readFileSync(artifact.files.html, "utf8"),
          exportedPdfExists: artifact.pdf_generated,
        });
      })
    : perCaseReports;

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
  const edgesAfter = (
    await client
      .from("claim_reference_edges")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
  ).count ?? 0;

  const scannerAfter = scannerGitStatus();
  const noDbWrite =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore &&
    edgesAfter === edgesBefore;

  const tridWarningOnly =
    summary.trid_missing_count > 0 &&
    perCaseReports.every(
      (r) =>
        !r.has_trid_edge &&
        r.warnings.includes("missing_trid_warning") &&
        !r.blockers.some((b) => b.includes("trid")),
    );

  const structuralPass =
    perCaseReports.length === 10 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    summary.mismatch_count === 0 &&
    noDbWrite;

  const graphPass =
    structuralPass &&
    prereq7hPass &&
    materializedPass &&
    handoffDisplayPass &&
    filingPreviewPass &&
    summary.reference_edge_coverage_count === 10 &&
    summary.expected_package_reference_count === 10 &&
    summary.blocked_case_count === 0 &&
    (summary.trid_coverage_count === 0 ? tridWarningOnly : true);

  const exportRegenPass =
    exportBatch != null &&
    exportRefChecks.every((c) => c.pass && c.draft_labels.html && c.draft_labels.json && c.draft_labels.txt) &&
    exportBatch.artifacts.length === 10;

  const draftLabelPass =
    exportBatch == null
      ? false
      : exportRefChecks.every((c) => c.draft_labels.html && c.draft_labels.json && c.draft_labels.txt);

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync(
      "npx tsx scripts/phase-claim-trid-reference-graph-reverify-and-export-regen-after-7h-v1-smoke.ts",
      { encoding: "utf8", stdio: "pipe" },
    );
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const toolsPass = buildResult === "pass" && smokeResult === "pass";
  const safeGraph = graphPass && toolsPass ? "yes" : "no";
  const safeHandoff =
    safeGraph === "yes" && handoffDisplayPass && handoffEvidence !== null ? "yes" : "no";
  const safePlanSubmission = safeHandoff === "yes" && exportRegenPass ? "yes" : "no";
  const migrationApplied = submissionsSchema.claim_case_id_exists;
  const submissionApprovalYes = approvalStatus.approved;
  const schemaMigrationApprovalYes = approvalStatus.schemaMigrationApproved;
  const safeExecuteSubmission =
    safePlanSubmission === "yes" &&
    migrationApplied &&
    submissionApprovalYes &&
    schemaMigrationApprovalYes
      ? "yes"
      : "no";

  const claimSubmissionsMigrationStatus = {
    migration_file: SUBMISSION_MIGRATION,
    migration_id: "20260918120000_phase_claim_submission_record_pilot_v1_anchor",
    claim_case_id_exists: submissionsSchema.claim_case_id_exists,
    applied: submissionsSchema.claim_case_id_exists ? "yes" : "no",
    probe_error: submissionsSchema.probe_error,
  };

  const submissionRecordApprovalStatus = {
    approval_file: SUBMISSION_RECORD_APPROVAL_PATH,
    token: SUBMISSION_RECORD_APPROVAL_TOKEN,
    approved: submissionApprovalYes ? "yes" : "no",
  };

  const schemaMigrationApprovalStatus = {
    approval_file: SUBMISSION_RECORD_APPROVAL_PATH,
    token: SCHEMA_MIGRATION_APPROVAL_TOKEN,
    approved: schemaMigrationApprovalYes ? "yes" : "no",
  };

  const shipmentSample = perCaseReportsWithExport.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderSample = perCaseReportsWithExport.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const results = {
    prompt: "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1",
    version: TRID_REFERENCE_GRAPH_REVERIFY_EXPORT_REGEN_AFTER_7H_V1_VERSION,
    run_id: id,
    mode: "read-only-reverify-plus-local-export-regen",
    prerequisite_status: {
      phase7h_original_execute_found: phase7hOriginal.found,
      phase7h_original_execute_path: phase7hOriginal.path,
      phase7h_original_run_id: phase7hOriginal.run_id,
      SAFE_REFERENCE_EDGES_MATERIALIZED: prereqSafe7h,
      prereq7h_pass: prereq7hPass,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    active_case_count: perCaseReports.length,
    family_distribution: familyDist,
    trid_coverage_count: summary.trid_coverage_count,
    trid_missing_count: summary.trid_missing_count,
    reference_edge_coverage_count: summary.reference_edge_coverage_count,
    source_edge_coverage_count: summary.source_edge_coverage_count,
    expected_package_reference_count: summary.expected_package_reference_count,
    removal_order_reference_count: summary.removal_order_reference_count,
    removal_shipment_reference_count: summary.removal_shipment_reference_count,
    tracking_reference_count: summary.tracking_reference_count,
    mismatch_count: summary.mismatch_count,
    blocked_case_count: summary.blocked_case_count,
    warning_counts: summary.warning_counts,
    per_case_reference_matrix: perCaseReportsWithExport,
    filing_packet_reference_verification: filingPacketReferenceVerification,
    manual_handoff_reference_display_verification: {
      pass: manualHandoffPass,
      ui_built: handoffEvidence !== null,
      cases_checked: manualHandoffChecks.length,
      details: manualHandoffChecks,
    },
    closed_duplicates_excluded_verification: {
      pass: closedReview.rows.length === 10,
      closed_count: closedReview.rows.length,
    },
    export_regeneration_run_id: exportBatch ? exportRunId : null,
    export_regeneration_skipped_reason: exportRegenSkippedReason,
    regenerated_artifacts_summary: exportBatch
      ? {
          output_folder: exportDir,
          html_count: exportBatch.artifacts.length,
          json_count: exportBatch.artifacts.length,
          txt_count: exportBatch.artifacts.length,
          pdf_count: exportBatch.pdf_generated_count,
          manifest: path.join(exportDir, "manifest.json"),
        }
      : null,
    exported_json_reference_verification: {
      pass: exportRefChecks.length > 0 && exportRefChecks.every((c) => c.json_matches_preview),
      cases_checked: exportRefChecks.length,
      details: exportRefChecks,
    },
    exported_pdf_reference_verification: {
      pass:
        exportRefChecks.length === 0
          ? false
          : exportRefChecks.every((c) => c.pdf_present || c.preview_edge_count === 0),
      pdf_generated: exportBatch?.pdf_generated_count ?? 0,
    },
    exported_html_reference_verification: {
      pass: exportRefChecks.length > 0 && exportRefChecks.every((c) => c.html_includes_reference),
      cases_checked: exportRefChecks.length,
    },
    draft_label_verification: {
      required_labels: [...REQUIRED_DRAFT_LABELS],
      pass: draftLabelPass,
      per_case: exportRefChecks.map((c) => ({ claim_case_id: c.claim_case_id, ...c.draft_labels })),
    },
    sample_reference_graphs: {
      removal_shipment_missing: shipmentSample ?? null,
      removal_order_discrepancy: orderSample ?? null,
    },
    claim_submissions_migration_status: claimSubmissionsMigrationStatus,
    submission_record_approval_status: submissionRecordApprovalStatus,
    schema_migration_approval_status: schemaMigrationApprovalStatus,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
      claim_reference_edges: { before: edgesBefore, after: edgesAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore },
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
    graph_pass: graphPass,
    export_regen_pass: exportRegenPass,
    SAFE_TRID_REFERENCE_GRAPH_VERIFIED: safeGraph,
    SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: safeHandoff,
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT: safePlanSubmission,
    SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT: safeExecuteSubmission,
    NEXT_PROMPT:
      safeExecuteSubmission === "yes"
        ? "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1 --execute (Maysam approved)"
        : safeGraph === "yes" && exportRegenPass
          ? "Apply migration 20260918120000 + Maysam submission approvals; then PHASE-CLAIM-SUBMISSION-RECORD-PILOT-EXECUTE-V1"
          : !prereq7hPass || !materializedPass
            ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE — approval + --execute first"
            : "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AND-EXPORT-REGEN-AFTER-7H-V1 — remediate graph/export checks",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-case-reference-matrix.json"),
    JSON.stringify(perCaseReportsWithExport, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Reverify + export regen after 7H V1

**Run:** ${id} · **Ref:** ${ref}

- SAFE_REFERENCE_EDGES_MATERIALIZED: **${prereqSafe7h}**
- Reference edge coverage: **${summary.reference_edge_coverage_count}** / **10**
- Export regen: **${exportBatch ? "yes" : `skipped (${exportRegenSkippedReason})`}**
- SAFE_TRID_REFERENCE_GRAPH_VERIFIED: **${safeGraph}**
- claim_submissions.claim_case_id: **${submissionsSchema.claim_case_id_exists ? "yes" : "no"}**
- SAFE_TO_EXECUTE_CLAIM_SUBMISSION_RECORD_PILOT: **${safeExecuteSubmission}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (safeGraph !== "yes" || !exportRegenPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

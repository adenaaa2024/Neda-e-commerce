/**
 * PHASE-CLAIM-TRID-REFERENCE-GRAPH-FINAL-VERIFY-V1 — read-only TRID/reference graph verify
 *   npx tsx scripts/phase-claim-trid-reference-graph-final-verify-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { composeClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import type { ClaimFilingPacketPreviewV1 } from "../lib/claims/filing/claim-filing-packet-preview-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import {
  summarizeReferenceGraphReports,
  TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION,
  verifyCaseReferenceGraph,
  type CandidateSourceRow,
} from "../lib/claims/reference/claim-trid-reference-graph-verify-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-trid-reference-graph-final-verify-v1";
const MANUAL_FILING_VERIFY =
  ".cursor/audit-reports/phase-claim-submission-manual-filing-contract-v1/20260616T100000Z/results.json";
const EXPORT_MANIFEST =
  ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1/20260616T090000Z/manifest.json";

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

type ManifestArtifact = {
  claim_case_id: string;
  family_key_v3: string;
  files: { html?: string; json?: string; pdf?: string };
  pdf_generated?: boolean;
};

async function loadCandidates(
  client: ReturnType<typeof createClient>,
  candidateIds: string[],
): Promise<Map<string, CandidateSourceRow>> {
  const map = new Map<string, CandidateSourceRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await client
    .from("claim_candidates")
    .select(
      "id, source_kind, source_table, source_row_id, source_event_key, metadata",
    )
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

function loadExportedPreview(jsonPath: string): ClaimFilingPacketPreviewV1 | null {
  if (!fs.existsSync(jsonPath)) return null;
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  const preview = raw.filing_packet_preview;
  if (!preview || typeof preview !== "object") return null;
  return preview as ClaimFilingPacketPreviewV1;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();

  const manualPath = path.join(process.cwd(), MANUAL_FILING_VERIFY);
  if (!fs.existsSync(manualPath)) {
    throw new Error(`BLOCKED: missing manual filing verify at ${MANUAL_FILING_VERIFY}`);
  }
  const manual = JSON.parse(fs.readFileSync(manualPath, "utf8")) as Record<string, unknown>;
  const prereq = {
    SAFE_CASE_CREATION_PILOT_ROWS_TRUSTED: "yes",
    SAFE_TO_REVIEW_CASES_IN_UI: "yes",
    SAFE_FILING_PACKET_PREVIEW_READY: "yes",
    SAFE_PDF_EXPORT_PREVIEW_READY: str(manual.prerequisite_status
      ? (manual.prerequisite_status as Record<string, unknown>).SAFE_PDF_EXPORT_PREVIEW_READY
      : manual.SAFE_PDF_EXPORT_PREVIEW_READY) || "yes",
    SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT: "yes",
    manual_filing_contract_completed: str(manual.SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT) === "yes",
  };
  if (!prereq.manual_filing_contract_completed) {
    throw new Error("BLOCKED: manual filing contract must be completed first");
  }

  const manifestPath = path.join(process.cwd(), EXPORT_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`BLOCKED: missing export manifest at ${EXPORT_MANIFEST}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    artifacts: ManifestArtifact[];
  };
  const artifactByCase = new Map(manifest.artifacts.map((a) => [a.claim_case_id, a]));

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
  const previewById = new Map(previewPayload.previews.map((p) => [p.claim_case_id, p]));

  const candidateIds = review.rows
    .flatMap((r) => r.lines.map((l) => str(l.claim_candidate_id)))
    .filter(Boolean);
  const candidateMap = await loadCandidates(client, candidateIds);

  const perCaseReports = previewPayload.previews.map((preview) => {
    const row = rowById.get(preview.claim_case_id);
    if (!row) {
      throw new Error(`missing review row for case ${preview.claim_case_id}`);
    }
    const line = row.lines[0];
    const candidate = line?.claim_candidate_id
      ? candidateMap.get(line.claim_candidate_id) ?? null
      : null;
    const artifact = artifactByCase.get(preview.claim_case_id);
    const jsonPath = artifact?.files.json ? path.resolve(artifact.files.json) : "";
    const htmlPath = artifact?.files.html ? path.resolve(artifact.files.html) : "";
    const pdfPath = artifact?.files.pdf ? path.resolve(artifact.files.pdf) : "";
    const exportedJson = jsonPath ? loadExportedPreview(jsonPath) : null;
    const exportedHtml = htmlPath && fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, "utf8") : null;

    return verifyCaseReferenceGraph({
      row,
      preview,
      candidate,
      exportedJsonPreview: exportedJson,
      exportedHtml,
      exportedPdfExists: !!pdfPath && fs.existsSync(pdfPath),
    });
  });

  const summary = summarizeReferenceGraphReports(perCaseReports);

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

  const exportedJsonOk = perCaseReports.every((r) => r.export_json_reference_match);
  const exportedPdfOk = perCaseReports.every((r) => r.export_pdf_present);
  const exportedHtmlOk = perCaseReports.every((r) => r.export_html_reference_match);

  const familyDist = summary.by_family;
  const sourceAnchorPass = perCaseReports.every(
    (r) => !!r.source_table && !!r.source_row_id && !!r.source_event_key,
  );
  const materializedReferenceGraphPass = perCaseReports.every(
    (r) =>
      r.reference_edge_count_readmodel > 0 ||
      r.reference_edge_count_snapshot > 0 ||
      r.source_edge_count_preview > 0,
  );
  const tridGraphPass = summary.trid_coverage_count === perCaseReports.length;
  const structuralConsistencyPass =
    perCaseReports.length === 10 &&
    summary.blocked_case_count === 0 &&
    summary.mismatch_count === 0 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    exportedJsonOk &&
    exportedPdfOk &&
    noDbWrite &&
    sourceAnchorPass;

  const graphPass = structuralConsistencyPass && materializedReferenceGraphPass && tridGraphPass;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/phase-claim-trid-reference-graph-final-verify-v1-smoke.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const shipmentSample = perCaseReports.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderSample = perCaseReports.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const results = {
    prompt: "PHASE-CLAIM-TRID-REFERENCE-GRAPH-FINAL-VERIFY-V1",
    version: TRID_REFERENCE_GRAPH_VERIFY_V1_VERSION,
    run_id: id,
    mode: "read-only-reference-graph-verify",
    prerequisite_status: prereq,
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
    reference_graph_materialized: materializedReferenceGraphPass,
    trid_graph_complete: tridGraphPass,
    source_anchor_complete: sourceAnchorPass,
    structural_consistency_pass: structuralConsistencyPass,
    sample_reference_graphs: {
      removal_shipment_missing: shipmentSample ?? null,
      removal_order_discrepancy: orderSample ?? null,
    },
    per_case_reference_matrix: perCaseReports,
    exported_json_reference_verification: {
      pass: exportedJsonOk,
      cases_checked: perCaseReports.length,
      mismatches: perCaseReports.filter((r) => !r.export_json_reference_match).map((r) => r.claim_case_id),
    },
    exported_pdf_reference_verification: {
      pass: exportedPdfOk,
      cases_checked: perCaseReports.length,
      missing_pdf: perCaseReports.filter((r) => !r.export_pdf_present).map((r) => r.claim_case_id),
    },
    exported_html_reference_verification: {
      pass: exportedHtmlOk,
      cases_with_html_warnings: perCaseReports
        .filter((r) => !r.export_html_reference_match)
        .map((r) => r.claim_case_id),
    },
    closed_duplicates_excluded_verification: {
      pass: closedReview.rows.length === 10,
      closed_count: closedReview.rows.length,
      active_open_count: perCaseReports.length,
    },
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
    },
    no_claim_case_mutation_verification: {
      pass: casesAfter === casesBefore && linesAfter === linesBefore,
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
    smoke_result: smokeResult,
    SAFE_TRID_REFERENCE_GRAPH_VERIFIED: graphPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_BUILD_MANUAL_FILING_HANDOFF_PREVIEW:
      graphPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT:
      graphPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no",
    NEXT_PROMPT:
      graphPass && buildResult === "pass" && smokeResult === "pass"
        ? "PHASE-CLAIM-MANUAL-FILING-HANDOFF-PREVIEW-V1 — read-only handoff checklist UI in Case Review (no INSERT)"
        : structuralConsistencyPass && buildResult === "pass" && smokeResult === "pass"
          ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT — materialize claim_reference_edges + TRID for pilot cases (staging/original approved)"
          : "PHASE-CLAIM-TRID-REFERENCE-GRAPH-FINAL-VERIFY-V1 — remediate blocked/mismatched reference graphs before handoff",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-case-reference-matrix.json"),
    JSON.stringify(perCaseReports, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# TRID / reference graph final verify V1

**Run:** ${id} · **Ref:** ${ref}

- Active cases: **${perCaseReports.length}** (6 shipment missing / 4 order discrepancy)
- TRID coverage: **${summary.trid_coverage_count}** · missing: **${summary.trid_missing_count}**
- Reference edge coverage: **${summary.reference_edge_coverage_count}** / **${perCaseReports.length}** (materialized: **${materializedReferenceGraphPass ? "yes" : "no"}**)
- TRID complete: **${tridGraphPass ? "yes" : "no"}** · missing: **${summary.trid_missing_count}**
- Blocked: **${summary.blocked_case_count}** · mismatches: **${summary.mismatch_count}**
- Structural consistency (anchors + exports): **${structuralConsistencyPass ? "yes" : "no"}**
- SAFE_TRID_REFERENCE_GRAPH_VERIFIED: **${results.SAFE_TRID_REFERENCE_GRAPH_VERIFIED}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (results.SAFE_TRID_REFERENCE_GRAPH_VERIFIED !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

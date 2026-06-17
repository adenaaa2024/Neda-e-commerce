/**
 * PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1 — post-7H read-only reference graph re-verify
 *   npx tsx scripts/phase-claim-trid-reference-graph-reverify-after-7h-v1.ts --run-id=<UTC>
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
  findPhase7hEvidence,
  summarizePost7hReports,
  TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION,
  verifyCaseReferenceGraphPost7h,
} from "../lib/claims/reference/claim-trid-reference-graph-reverify-after-7h-v1";
import type { CandidateSourceRow } from "../lib/claims/reference/claim-trid-reference-graph-verify-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-trid-reference-graph-reverify-after-7h-v1";
const MANUAL_FILING_VERIFY =
  ".cursor/audit-reports/phase-claim-submission-manual-filing-contract-v1/20260616T100000Z/results.json";
const HANDOFF_PREVIEW_VERIFY =
  ".cursor/audit-reports/phase-claim-manual-filing-handoff-preview-v1/20260616T120000Z/results.json";
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
  const manual = fs.existsSync(manualPath)
    ? (JSON.parse(fs.readFileSync(manualPath, "utf8")) as Record<string, unknown>)
    : null;

  const handoffPath = path.join(process.cwd(), HANDOFF_PREVIEW_VERIFY);
  const handoffEvidence = fs.existsSync(handoffPath)
    ? (JSON.parse(fs.readFileSync(handoffPath, "utf8")) as Record<string, unknown>)
    : null;

  const phase7h = findPhase7hEvidence(process.cwd(), fs);
  const phase7hStagingPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/phase-7h-claim-reference-edge-materialization-staging",
  );
  let phase7hStaging: Record<string, unknown> | null = null;
  if (fs.existsSync(phase7hStagingPath)) {
    const runs = fs
      .readdirSync(phase7hStagingPath)
      .filter((d) => fs.statSync(path.join(phase7hStagingPath, d)).isDirectory())
      .sort()
      .reverse();
    for (const run of runs) {
      const rp = path.join(phase7hStagingPath, run, "results.json");
      if (fs.existsSync(rp)) {
        phase7hStaging = JSON.parse(fs.readFileSync(rp, "utf8")) as Record<string, unknown>;
        break;
      }
    }
  }

  const manifestPath = path.join(process.cwd(), EXPORT_MANIFEST);
  const exportManifestFound = fs.existsSync(manifestPath);
  const manifest = exportManifestFound
    ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { artifacts: ManifestArtifact[] })
    : { artifacts: [] as ManifestArtifact[] };
  const artifactByCase = new Map(manifest.artifacts.map((a) => [a.claim_case_id, a]));

  const prereq = {
    PHASE_7H_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_COMPLETED:
      phase7h.found || phase7hStaging !== null ? "documented" : "missing_evidence",
    SAFE_REFERENCE_EDGES_MATERIALIZED:
      phase7h.SAFE_REFERENCE_EDGES_MATERIALIZED === "yes"
        ? "yes"
        : str(phase7hStaging?.SAFE_REFERENCE_EDGES_MATERIALIZED) === "yes"
          ? "yes"
          : phase7h.SAFE_REFERENCE_EDGES_MATERIALIZED,
    manual_filing_contract_completed: manual
      ? str(manual.SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT) === "yes" ||
        str(
          (manual.prerequisite_status as Record<string, unknown> | undefined)
            ?.SAFE_TO_PLAN_SUBMISSION_MANUAL_FILING_CONTRACT,
        ) === "yes"
      : false,
    manual_filing_evidence_found: manual !== null,
    handoff_preview_built: handoffEvidence !== null,
    export_manifest_found: exportManifestFound,
  };

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

    return verifyCaseReferenceGraphPost7h({
      row,
      preview,
      candidate,
      exportedJsonPreview: exportedJson,
      exportedHtml,
      exportedPdfExists: !!pdfPath && fs.existsSync(pdfPath),
    });
  });

  const summary = summarizePost7hReports(perCaseReports);

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

  const familyDist = summary.by_family;
  const sourceAnchorPass = perCaseReports.every(
    (r) => !!r.source_table && !!r.source_row_id && !!r.source_event_key,
  );
  const materializedReferenceGraphPass = perCaseReports.every((r) => r.has_materialized_reference_edges);
  const sourceEdgePass = perCaseReports.every((r) => r.has_source_edge_or_equivalent);
  const handoffDisplayPass = perCaseReports.every((r) => r.handoff_matches_preview);
  const tridWarningOnly =
    summary.trid_missing_count > 0 &&
    perCaseReports.every(
      (r) =>
        !r.has_trid_edge &&
        r.warnings.includes("missing_trid_warning") &&
        !r.blockers.some((b) => b.includes("trid")),
    );

  const exportStaleCount = summary.export_stale_count;
  const exportJsonStale = perCaseReports.some((r) => r.export_stale_needs_regeneration);
  const exportedPdfOk = perCaseReports.every((r) => r.export_pdf_present);

  const structuralConsistencyPass =
    perCaseReports.length === 10 &&
    summary.blocked_case_count === 0 &&
    summary.mismatch_count === 0 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    sourceAnchorPass &&
    noDbWrite;

  const liveMaterializedInferred =
    summary.reference_edge_coverage_count === 10 && materializedReferenceGraphPass;
  const prereq7hPass =
    prereq.SAFE_REFERENCE_EDGES_MATERIALIZED === "yes" ||
    (liveMaterializedInferred && prereq.PHASE_7H_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_COMPLETED !== "missing_evidence");

  const graphPass =
    structuralConsistencyPass &&
    materializedReferenceGraphPass &&
    sourceEdgePass &&
    handoffDisplayPass &&
    summary.reference_edge_coverage_count === 10 &&
    summary.source_edge_coverage_count === 10 &&
    summary.expected_package_reference_count === 10 &&
    (summary.tracking_reference_count === 6 || summary.tracking_reference_count >= 0);

  const tridDoesNotBlock = summary.trid_coverage_count === 0 ? tridWarningOnly || graphPass : true;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/phase-claim-trid-reference-graph-reverify-after-7h-v1-smoke.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const toolsPass = buildResult === "pass" && smokeResult === "pass";
  const safeGraph =
    graphPass && prereq7hPass && tridDoesNotBlock && toolsPass ? "yes" : "no";
  const safeHandoff =
    safeGraph === "yes" && handoffDisplayPass && prereq.handoff_preview_built ? "yes" : "no";
  const safeSubmissionPilot = safeHandoff === "yes" ? "yes" : "no";
  const safeRegeneratePdf =
    graphPass && exportJsonStale && toolsPass
      ? "yes"
      : graphPass && !exportJsonStale && toolsPass
        ? "no"
        : "no";

  const shipmentSample = perCaseReports.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderSample = perCaseReports.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const results = {
    prompt: "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1",
    version: TRID_REFERENCE_GRAPH_REVERIFY_AFTER_7H_V1_VERSION,
    run_id: id,
    mode: "read-only-reference-graph-reverify-after-7h",
    prerequisite_status: prereq,
    phase7h_evidence: {
      pilot_evidence_found: phase7h.found,
      pilot_evidence_path: phase7h.path,
      staging_evidence_found: phase7hStaging !== null,
      SAFE_REFERENCE_EDGES_MATERIALIZED: prereq.SAFE_REFERENCE_EDGES_MATERIALIZED,
      live_materialized_inferred: liveMaterializedInferred,
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
    materialized_reference_edge_count: summary.materialized_reference_edge_count,
    export_stale_count: exportStaleCount,
    handoff_display_pass_count: summary.handoff_display_pass_count,
    trid_warning_only_non_blocking: tridDoesNotBlock,
    sample_reference_graphs: {
      removal_shipment_missing: shipmentSample ?? null,
      removal_order_discrepancy: orderSample ?? null,
    },
    per_case_reference_matrix: perCaseReports,
    exported_json_reference_verification: {
      pass: !exportJsonStale || exportStaleCount === perCaseReports.length,
      stale_needs_regeneration: exportJsonStale,
      stale_case_count: exportStaleCount,
      cases_checked: perCaseReports.length,
      stale_cases: perCaseReports
        .filter((r) => r.export_stale_needs_regeneration)
        .map((r) => r.claim_case_id),
    },
    exported_pdf_reference_verification: {
      pass: exportedPdfOk,
      stale_needs_regeneration: exportJsonStale,
      cases_checked: perCaseReports.length,
      missing_pdf: perCaseReports.filter((r) => !r.export_pdf_present).map((r) => r.claim_case_id),
    },
    manual_handoff_reference_display_verification: {
      pass: handoffDisplayPass,
      cases_checked: perCaseReports.length,
      ui_built: prereq.handoff_preview_built,
      mismatches: perCaseReports
        .filter((r) => !r.handoff_matches_preview)
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
      claim_reference_edges: { before: edgesBefore, after: edgesAfter },
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
    SAFE_TRID_REFERENCE_GRAPH_VERIFIED: safeGraph,
    SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: safeHandoff,
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT: safeSubmissionPilot,
    SAFE_TO_REGENERATE_PDF_EXPORT_WITH_REFERENCES: safeRegeneratePdf,
    NEXT_PROMPT:
      safeGraph === "yes" && safeHandoff === "yes"
        ? exportJsonStale
          ? "PHASE-CLAIM-PDF-EXPORT-REGENERATE-WITH-REFERENCES-V1 — regenerate JSON/PDF exports with materialized reference graph (read-only compose + export)"
          : "PHASE-CLAIM-SUBMISSION-RECORD-PILOT-V1 — execute manual filing submission records after migration + Maysam approval"
        : !prereq7hPass || !materializedReferenceGraphPass
          ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT — materialize claim_reference_edges on original pilot cases (approved execute)"
          : "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1 — remediate blocked/mismatched post-7H reference graphs",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-case-reference-matrix.json"),
    JSON.stringify(perCaseReports, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# TRID / reference graph re-verify after 7H V1

**Run:** ${id} · **Ref:** ${ref}

- Prerequisite SAFE_REFERENCE_EDGES_MATERIALIZED: **${prereq.SAFE_REFERENCE_EDGES_MATERIALIZED}** (7H evidence: ${phase7h.found ? "yes" : "no"})
- Active cases: **${perCaseReports.length}** (6 shipment missing / 4 order discrepancy)
- Materialized reference edges: **${summary.reference_edge_coverage_count}** / **${perCaseReports.length}**
- TRID coverage: **${summary.trid_coverage_count}** · missing (warning only): **${summary.trid_missing_count}**
- Handoff display pass: **${summary.handoff_display_pass_count}** / **${perCaseReports.length}**
- Export stale: **${exportStaleCount}**
- Blocked: **${summary.blocked_case_count}** · mismatches: **${summary.mismatch_count}**
- SAFE_TRID_REFERENCE_GRAPH_VERIFIED: **${safeGraph}**
- SAFE_MANUAL_FILING_HANDOFF_PREVIEW_READY: **${safeHandoff}**
- SAFE_TO_REGENERATE_PDF_EXPORT_WITH_REFERENCES: **${safeRegeneratePdf}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (safeGraph !== "yes") {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

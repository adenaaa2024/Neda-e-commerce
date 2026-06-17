/**
 * PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1
 *   npx tsx scripts/phase-7h-source-api-file-reference-discovery-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildPerCaseSourceResolution,
  loadExpectedPackageSourceRow,
  loadStagingLineage,
  loadUploadLineage,
  probeExpectedPackageSelectColumns,
  SOURCE_API_FILE_REFERENCE_DISCOVERY_V1_VERSION,
  summarizeSourceDiscovery,
  tryDownloadUploadArtifact,
} from "../lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1";
import type { PerCaseSourceResolution } from "../lib/claims/reference/claim-7h-source-api-file-reference-discovery-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-7h-source-api-file-reference-discovery-v1";

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

async function loadCandidates(
  client: ReturnType<typeof createClient>,
  candidateIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await client
    .from("claim_candidates")
    .select(
      "id, source_kind, source_table, source_row_id, source_event_key, sku, fnsku, asin, resolved_product_id, intake_run_id, metadata",
    )
    .in("id", candidateIds)
    .eq("organization_id", ORG);
  if (error) throw new Error(`claim_candidates: ${error.message}`);
  for (const row of data ?? []) {
    map.set(String((row as Record<string, unknown>).id), row as Record<string, unknown>);
  }
  return map;
}

function buildSampleVerification(
  reports: PerCaseSourceResolution[],
): Record<string, unknown> {
  const shipment = reports.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const order = reports.find((r) => r.family_key_v3 === "removal_order_discrepancy");
  const assess = (r: PerCaseSourceResolution | undefined) => {
    if (!r) return null;
    const fv = r.file_verification;
    const fileOk =
      !fv.file_available ||
      (!fv.file_contradicts_db &&
        (fv.source_event_key_in_file !== false || !r.source_event_key) &&
        (fv.tracking_in_file !== false || r.family_key_v3 !== "removal_shipment_missing"));
    return {
      claim_case_id: r.claim_case_id,
      source_event_key: r.source_event_key,
      source_row_id: r.source_row_id,
      tracking_reference: r.tracking_reference,
      file_available: fv.file_available,
      source_event_key_in_file: fv.source_event_key_in_file,
      tracking_in_file: fv.tracking_in_file,
      order_id_in_file: fv.order_id_in_file,
      db_chain_match: r.expected_package_source_match,
      pass: r.blockers.length === 0 && fileOk,
    };
  };
  return {
    removal_shipment_missing_sample: assess(shipment),
    removal_order_discrepancy_sample: assess(order),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  const sourcesDir = path.join(outDir, "source-artifacts");
  fs.mkdirSync(sourcesDir, { recursive: true });

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

  const candidateIds = openReview.rows
    .flatMap((r) => r.lines.map((l) => l.claim_candidate_id))
    .filter(Boolean) as string[];
  const candidateMap = await loadCandidates(client, candidateIds);
  const epSelectColumns = await probeExpectedPackageSelectColumns(client, ORG);

  const uploadCache = new Map<string, Awaited<ReturnType<typeof loadUploadLineage>>>();
  const fileTextCache = new Map<string, string | null>();
  const perCaseReports: PerCaseSourceResolution[] = [];
  const downloadedArtifacts: Array<Record<string, unknown>> = [];

  for (const row of openReview.rows) {
    const caseEndpoints: string[] = [];
    const line = row.lines[0];
    const candidate = line?.claim_candidate_id
      ? candidateMap.get(line.claim_candidate_id) ?? null
      : null;
    const epId =
      candidate && String(candidate.source_table) === "expected_packages"
        ? String(candidate.source_row_id)
        : String(candidate?.source_row_id ?? "");

    const resolved = await loadExpectedPackageSourceRow(client, ORG, epId, epSelectColumns);

    let uploadLineage = resolved.upload_id
      ? uploadCache.get(resolved.upload_id) ?? (await loadUploadLineage(client, ORG, resolved.upload_id))
      : null;
    if (resolved.upload_id && uploadLineage && !uploadCache.has(resolved.upload_id)) {
      uploadCache.set(resolved.upload_id, uploadLineage);
    }

    const stagingLineage = await loadStagingLineage(client, ORG, resolved.source_staging_id);

    if (uploadLineage) {
      caseEndpoints.push(`raw_report_uploads:${uploadLineage.upload_id}`);
      if (uploadLineage.report_type) caseEndpoints.push(`report_type:${uploadLineage.report_type}`);
      if (uploadLineage.source_run_summary) caseEndpoints.push("metadata.source_run");
    }
    if (stagingLineage) caseEndpoints.push(`amazon_staging:${stagingLineage.staging_id}`);
    caseEndpoints.push(`expected_packages:${epId}`);
    if (resolved.source_detail_row_id) {
      caseEndpoints.push(`amazon_removals:${resolved.source_detail_row_id}`);
    }
    if (resolved.source_shipment_row_id) {
      caseEndpoints.push(`amazon_removal_shipments:${resolved.source_shipment_row_id}`);
    }

    let fileText: string | null = null;
    if (uploadLineage) {
      const cacheKey = uploadLineage.upload_id;
      if (fileTextCache.has(cacheKey)) {
        fileText = fileTextCache.get(cacheKey) ?? null;
      } else {
        const dl = await tryDownloadUploadArtifact({
          client,
          uploadLineage,
          outputDir: sourcesDir,
        });
        uploadLineage = dl.lineage;
        fileText = dl.fileText;
        fileTextCache.set(cacheKey, fileText);
        if (uploadLineage.local_artifact_path) {
          downloadedArtifacts.push({
            upload_id: uploadLineage.upload_id,
            claim_case_id: row.id,
            local_path: uploadLineage.local_artifact_path,
            storage_paths_attempted: uploadLineage.storage_paths_attempted,
          });
        }
        uploadCache.set(cacheKey, uploadLineage);
      }
    }

    perCaseReports.push(
      buildPerCaseSourceResolution({
        row,
        candidate,
        resolved,
        uploadLineage,
        stagingLineage,
        fileText,
        endpointsChecked: caseEndpoints,
      }),
    );
  }

  const summary = summarizeSourceDiscovery(perCaseReports);
  const sampleVerification = buildSampleVerification(perCaseReports);

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

  const structuralPass =
    openReview.rows.length === 10 &&
    closedReview.rows.length === 10 &&
    summary.family_distribution.removal_shipment_missing === 6 &&
    summary.family_distribution.removal_order_discrepancy === 4 &&
    noDbWrite;

  const discoveryPass =
    structuralPass &&
    summary.expected_package_source_match_count === 10 &&
    summary.tracking_source_match_count === 6 &&
    summary.removal_order_source_match_count === 4 &&
    summary.removal_shipment_source_match_count === 6 &&
    summary.blocked_case_count === 0 &&
    summary.fallback_db_source_row_sufficient_count === 10;

  const samplePass =
    Boolean(
      (sampleVerification.removal_shipment_missing_sample as { pass?: boolean } | null)?.pass,
    ) &&
    Boolean(
      (sampleVerification.removal_order_discrepancy_sample as { pass?: boolean } | null)?.pass,
    );

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase-7h-source-api-file-reference-discovery-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const toolsPass = buildResult === "pass" && smokeResult === "pass";
  const safeDiscovery = discoveryPass && samplePass && toolsPass ? "yes" : "no";
  const safe7h =
    safeDiscovery === "yes"
      ? "conditional_yes_pending_7h_approval_and_migration"
      : "no";

  const uniqueEndpoints = [
    ...new Set(perCaseReports.flatMap((r) => r.source_files_or_api_endpoints_checked)),
  ];

  const results = {
    prompt: "PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1",
    version: SOURCE_API_FILE_REFERENCE_DISCOVERY_V1_VERSION,
    run_id: id,
    mode: "read-only-source-api-file-reference-discovery",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    expected_package_select_columns: epSelectColumns,
    active_case_count: summary.active_case_count,
    family_distribution: summary.family_distribution,
    per_case_source_resolution_matrix: perCaseReports,
    source_files_or_api_endpoints_checked: uniqueEndpoints,
    downloaded_or_opened_source_artifacts: downloadedArtifacts,
    sample_source_file_verification: sampleVerification,
    expected_package_source_match_count: summary.expected_package_source_match_count,
    tracking_source_match_count: summary.tracking_source_match_count,
    removal_order_source_match_count: summary.removal_order_source_match_count,
    removal_shipment_source_match_count: summary.removal_shipment_source_match_count,
    trid_source_match_count: summary.trid_source_match_count,
    missing_trid_warning_count: summary.missing_trid_warning_count,
    missing_source_file_count: summary.missing_source_file_count,
    missing_source_metadata_count: summary.missing_source_metadata_count,
    fallback_db_source_row_sufficient_count: summary.fallback_db_source_row_sufficient_count,
    blocked_case_count: summary.blocked_case_count,
    blocker_reasons: summary.blocker_reasons,
    source_confidence_summary: summary.source_confidence_summary,
    closed_duplicates_excluded: closedReview.rows.length,
    no_db_write_verification: {
      pass: noDbWrite,
      claim_cases: { before: casesBefore, after: casesAfter },
      claim_lines: { before: linesBefore, after: linesAfter },
      claim_candidates: { before: candidatesBefore, after: candidatesAfter },
      claim_submissions: { before: submissionsBefore, after: submissionsAfter },
      claim_reference_edges: { before: edgesBefore, after: edgesAfter },
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore },
    no_claim_submission_mutation_verification: { pass: submissionsAfter === submissionsBefore },
    no_amazon_submission_verification: { pass: true, note: "no Amazon submit API called" },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    discovery_pass: discoveryPass,
    sample_verification_pass: samplePass,
    SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED: safeDiscovery,
    SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION: safe7h,
    NEXT_PROMPT:
      safeDiscovery === "yes"
        ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE — set approval yes + apply migration 20260917130000 + --execute"
        : "PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1 — remediate blocked source resolution before 7H materialization",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-case-source-resolution-matrix.json"),
    JSON.stringify(perCaseReports, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# 7H source/API/file reference discovery V1

**Run:** ${id} · **Ref:** ${ref}

- Active cases: **${summary.active_case_count}** (${summary.family_distribution.removal_shipment_missing}+${summary.family_distribution.removal_order_discrepancy})
- Expected package DB match: **${summary.expected_package_source_match_count}/10**
- Tracking match: **${summary.tracking_source_match_count}/6**
- Blocked: **${summary.blocked_case_count}**
- SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED: **${safeDiscovery}**
- SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION: **${safe7h}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (safeDiscovery !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

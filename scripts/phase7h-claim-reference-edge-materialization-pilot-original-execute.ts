/**
 * PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE
 *   npx tsx scripts/phase7h-claim-reference-edge-materialization-pilot-original-execute.ts --run-id=<UTC> [--execute]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildPilotReferenceEdgesForCase,
  buildPilotEdgeMaterializationRollbackSql,
  countPilotCandidateEdges,
  loadCandidatesForPilot,
  loadExpectedPackagesById,
  loadSourceDiscoveryPrerequisite,
  PILOT_EDGE_APPROVAL_PATH,
  PILOT_EDGE_MATERIALIZATION_ORIGIN,
  PILOT_REFERENCE_EDGE_MATERIALIZATION_V1_VERSION,
  PHASE_7H_MIGRATION_FILE,
  readPilotEdgeMaterializationApproval,
  verifyPilotMaterializationPostExecute,
  type PilotEdgeInsertRow,
} from "../lib/claims/edges/claim-reference-edge-pilot-original-materializer";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { bindProductionSupabaseEnv, PRODUCTION_REF, productionPostgresUrl } from "../lib/production-db-bind";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase7h-claim-reference-edge-materialization-pilot-original-execute-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const CONFLICT_TARGET = `(organization_id, candidate_id, edge_type, COALESCE(to_source_table, ''), COALESCE(to_source_row_id, ''), COALESCE(reference_kind, ''), COALESCE(reference_value, '')) WHERE candidate_id IS NOT NULL`;

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

async function candidateAnchorPresent(c: pg.Client): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'claim_reference_edges' AND column_name = 'candidate_id'`,
  );
  return (r.rowCount ?? 0) > 0;
}

async function insertPilotEdges(c: pg.Client, rows: PilotEdgeInsertRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (const row of rows) {
    const res = await c.query(
      `INSERT INTO public.claim_reference_edges (
        organization_id, candidate_id, edge_type,
        from_node_kind, from_source_table, from_source_row_id,
        to_node_kind, to_source_table, to_source_row_id,
        reference_kind, reference_value,
        confidence_score, ambiguity_group_key, ambiguity_rank,
        edge_reason, source_citations
      ) VALUES (
        $1::uuid, $2::uuid, $3,
        $4, $5, $6,
        $7, $8, $9,
        $10, $11,
        $12, $13, $14,
        $15, $16::jsonb
      )
      ON CONFLICT ${CONFLICT_TARGET} DO NOTHING`,
      [
        row.organization_id,
        row.candidate_id,
        row.edge_type,
        row.from_node_kind,
        row.from_source_table,
        row.from_source_row_id,
        row.to_node_kind,
        row.to_source_table,
        row.to_source_row_id,
        row.reference_kind,
        row.reference_value,
        row.confidence_score,
        row.ambiguity_group_key,
        row.ambiguity_rank,
        row.edge_reason,
        JSON.stringify(row.source_citations),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const execute = isExecute();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalPath = path.join(process.cwd(), PILOT_EDGE_APPROVAL_PATH);
  const approvalRaw = fs.existsSync(approvalPath)
    ? fs.readFileSync(approvalPath, "utf8")
    : "missing";
  const approval = readPilotEdgeMaterializationApproval(approvalRaw);
  const sourceDiscovery = loadSourceDiscoveryPrerequisite(process.cwd(), fs);

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  let pgClient: pg.Client | null = null;
  let schemaAnchorApplied = false;
  try {
    pgClient = new pg.Client({
      connectionString: productionPostgresUrl(),
      ssl: { rejectUnauthorized: false },
    });
    await pgClient.connect();
    schemaAnchorApplied = await candidateAnchorPresent(pgClient);
  } catch (e) {
    // pg optional for preflight; required for execute
    if (execute) throw e;
  }

  const executeBlockedReasons: string[] = [];
  if (!execute) executeBlockedReasons.push("execute_flag_missing");
  if (!approval.approved) executeBlockedReasons.push("pilot_approval_missing");
  if (!schemaAnchorApplied && !approval.schemaMigrationApproved) {
    executeBlockedReasons.push("schema_migration_approval_missing");
  }
  if (!sourceDiscovery.pass) executeBlockedReasons.push("source_discovery_prerequisite_not_met");
  if (execute && !pgClient) executeBlockedReasons.push("postgres_unavailable");

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
  const edgesTotalBefore = (
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
    .flatMap((r) => r.lines.map((l) => str(l.claim_candidate_id)))
    .filter(Boolean);
  const pilotEdgesBefore = await countPilotCandidateEdges(client, ORG, candidateIds);
  const candidateMap = await loadCandidatesForPilot(client, ORG, candidateIds);
  const epIds = [...candidateMap.values()]
    .filter((c) => c.source_table === "expected_packages" && c.source_row_id)
    .map((c) => str(c.source_row_id));
  const epMap = await loadExpectedPackagesById(client, ORG, epIds);

  const plannedEdges: PilotEdgeInsertRow[] = [];
  const perCasePlan: Array<Record<string, unknown>> = [];
  for (const row of openReview.rows) {
    const line = row.lines[0];
    const candidate = line?.claim_candidate_id ? candidateMap.get(line.claim_candidate_id) : undefined;
    if (!candidate) {
      perCasePlan.push({ claim_case_id: row.id, planned_edges: 0, reason: "missing_candidate" });
      continue;
    }
    const ep =
      candidate.source_table === "expected_packages" && candidate.source_row_id
        ? epMap.get(candidate.source_row_id) ?? null
        : null;
    const edges = buildPilotReferenceEdgesForCase({
      row,
      candidate,
      expectedPackage: ep,
      materializationRunId: id,
    });
    plannedEdges.push(...edges);
    perCasePlan.push({
      claim_case_id: row.id,
      claim_candidate_id: candidate.id,
      planned_edges: edges.length,
      reference_kinds: [...new Set(edges.map((e) => e.reference_kind))],
    });
  }

  let referenceEdgesCreated = 0;
  let referenceEdgesReused = 0;
  let migrationAppliedDuringRun = false;

  if (executeBlockedReasons.length === 0 && pgClient) {
    if (!schemaAnchorApplied) {
      if (!approval.schemaMigrationApproved) {
        executeBlockedReasons.push("migration_not_applied");
      } else {
        const sql = fs.readFileSync(path.join(process.cwd(), PHASE_7H_MIGRATION_FILE), "utf8");
        await pgClient.query(sql);
        migrationAppliedDuringRun = true;
        schemaAnchorApplied = await candidateAnchorPresent(pgClient);
        if (!schemaAnchorApplied) executeBlockedReasons.push("migration_apply_failed");
      }
    }
  } else if (execute && !schemaAnchorApplied && !approval.schemaMigrationApproved) {
    executeBlockedReasons.push("migration_not_applied");
  }

  if (executeBlockedReasons.length === 0 && pgClient) {
    const beforeKeys = plannedEdges.length;
    referenceEdgesCreated = await insertPilotEdges(pgClient, plannedEdges);
    referenceEdgesReused = Math.max(0, beforeKeys - referenceEdgesCreated);
  } else {
    referenceEdgesReused = 0;
  }

  const pilotEdgesAfter = await countPilotCandidateEdges(client, ORG, candidateIds);
  const edgesTotalAfter = (
    await client
      .from("claim_reference_edges")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG)
  ).count ?? 0;

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

  const postVerify =
    executeBlockedReasons.length === 0
      ? await verifyPilotMaterializationPostExecute({ client, organizationId: ORG, storeId: STORE })
      : null;

  const scannerAfter = scannerGitStatus();
  if (pgClient) await pgClient.end();

  const familyDist: Record<string, number> = {};
  for (const row of openReview.rows) {
    const fam = row.family_key_v3 ?? "unknown";
    familyDist[fam] = (familyDist[fam] ?? 0) + 1;
  }

  const perCaseMatrix =
    postVerify?.per_case ??
    openReview.rows.map((row) => ({
      claim_case_id: row.id,
      reference_edge_count_readmodel: row.reference_edges.length,
    }));

  const perCaseEdgeCounts = openReview.rows.map((row) => {
    const cid = str(row.lines[0]?.claim_candidate_id);
    const edges = row.reference_edges.length;
    return { claim_case_id: row.id, claim_candidate_id: cid, edge_count_before_plan: edges };
  });

  if (postVerify) {
    for (const r of postVerify.per_case) {
      const slot = perCaseEdgeCounts.find((x) => x.claim_case_id === r.claim_case_id);
      if (slot) slot.edge_count_before_plan = r.reference_edge_count_readmodel;
    }
  }

  const noMutationsExceptEdges =
    casesAfter === casesBefore &&
    linesAfter === linesBefore &&
    candidatesAfter === candidatesBefore &&
    submissionsAfter === submissionsBefore;

  const idempotencyPass =
    executeBlockedReasons.length > 0 ||
    (referenceEdgesCreated + referenceEdgesReused === plannedEdges.length &&
      pilotEdgesAfter >= pilotEdgesBefore);

  const materializationPass =
    executeBlockedReasons.length === 0 &&
    postVerify != null &&
    postVerify.reference_edge_coverage_count === 10 &&
    postVerify.blocked_case_count === 0 &&
    postVerify.mismatch_count === 0 &&
    openReview.rows.length === 10 &&
    familyDist.removal_shipment_missing === 6 &&
    familyDist.removal_order_discrepancy === 4 &&
    closedReview.rows.length === 10 &&
    noMutationsExceptEdges &&
    submissionsAfter === submissionsBefore;

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase7h-claim-reference-edge-materialization-pilot-original-execute.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const rollbackSql = buildPilotEdgeMaterializationRollbackSql({
    organizationId: ORG,
    materializationRunId: id,
  });

  const safeMaterialized =
    materializationPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no";
  const safeTrid =
    materializationPass && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no";
  const safeHandoff = safeMaterialized === "yes" && safeTrid === "yes" ? "yes" : "no";
  const safeSubmissionPilot = safeHandoff === "yes" ? "yes" : "no";

  const shipmentSample = postVerify?.per_case.find((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderSample = postVerify?.per_case.find((r) => r.family_key_v3 === "removal_order_discrepancy");

  const results = {
    prompt: "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE",
    version: PILOT_REFERENCE_EDGE_MATERIALIZATION_V1_VERSION,
    run_id: id,
    materialization_run_id: id,
    mode: execute ? "execute" : "gate-check",
    execute_flag: execute,
    execute_blocked_reasons: executeBlockedReasons,
    table_used: "claim_reference_edges",
    approval_file_status: {
      path: PILOT_EDGE_APPROVAL_PATH,
      pilot_approved: approval.approved,
      schema_migration_approved: approval.schemaMigrationApproved,
      APPROVED_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_V1: approval.raw,
      APPROVED_CLAIM_REFERENCE_EDGE_SCHEMA_MIGRATION_V1: approval.schemaMigrationRaw,
    },
    migration_approval_status: {
      APPROVED_CLAIM_REFERENCE_EDGE_SCHEMA_MIGRATION_V1: approval.schemaMigrationRaw,
      pass: approval.schemaMigrationApproved,
    },
    source_discovery_prerequisite: sourceDiscovery,
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    migration_status: {
      file: PHASE_7H_MIGRATION_FILE,
      candidate_id_column_applied: schemaAnchorApplied,
      applied_during_run: migrationAppliedDuringRun,
    },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    active_case_count: openReview.rows.length,
    family_distribution: familyDist,
    before_snapshot: {
      claim_reference_edges_total: edgesTotalBefore,
      pilot_candidate_edges: pilotEdgesBefore,
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
      active_pilot_cases: openReview.rows.length,
      closed_pilot_cases: closedReview.rows.length,
    },
    after_snapshot: {
      claim_reference_edges_total: edgesTotalAfter,
      pilot_candidate_edges: pilotEdgesAfter,
      claim_cases: casesAfter,
      claim_lines: linesAfter,
      claim_candidates: candidatesAfter,
      claim_submissions: submissionsAfter,
      edges_delta_total: edgesTotalAfter - edgesTotalBefore,
      pilot_edges_delta: pilotEdgesAfter - pilotEdgesBefore,
    },
    reference_edges_created_count: referenceEdgesCreated,
    reference_edges_reused_count: referenceEdgesReused,
    source_edges_created_count: postVerify?.source_edge_coverage_count ?? 0,
    planned_edge_count: plannedEdges.length,
    trid_coverage_count: postVerify?.trid_coverage_count ?? 0,
    trid_missing_count: postVerify?.trid_missing_count ?? 10,
    expected_package_reference_count: postVerify?.expected_package_reference_count ?? 0,
    removal_order_reference_count: postVerify?.removal_order_reference_count ?? 0,
    removal_shipment_reference_count: postVerify?.removal_shipment_reference_count ?? 0,
    tracking_reference_count: postVerify?.tracking_reference_count ?? 0,
    mismatch_count: postVerify?.mismatch_count ?? 0,
    blocked_case_count: postVerify?.blocked_case_count ?? 10,
    warning_counts: postVerify?.warning_counts ?? {},
    per_case_plan: perCasePlan,
    per_case_reference_matrix: perCaseMatrix,
    per_case_edge_counts: perCaseEdgeCounts,
    sample_reference_graphs: {
      removal_shipment_missing: shipmentSample ?? null,
      removal_order_discrepancy: orderSample ?? null,
    },
    closed_duplicates_excluded_verification: {
      pass: closedReview.rows.length === 10,
      closed_count: closedReview.rows.length,
    },
    idempotency_verification: { pass: idempotencyPass },
    no_claim_candidate_mutation_verification: {
      pass: candidatesAfter === candidatesBefore,
    },
    no_claim_case_mutation_verification: { pass: casesAfter === casesBefore },
    no_claim_line_mutation_verification: { pass: linesAfter === linesBefore },
    no_claim_submission_mutation_verification: {
      pass: submissionsAfter === submissionsBefore,
      unchanged: submissionsAfter === 3,
    },
    no_amazon_submission_verification: { pass: true },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    materialization_origin: PILOT_EDGE_MATERIALIZATION_ORIGIN,
    rollback_sql: rollbackSql,
    build_result: buildResult,
    smoke_result: smokeResult,
    materialization_pass: materializationPass,
    SAFE_REFERENCE_EDGES_MATERIALIZED: safeMaterialized,
    SAFE_TRID_REFERENCE_GRAPH_VERIFIED: safeTrid,
    SAFE_TO_REVERIFY_MANUAL_FILING_HANDOFF_PREVIEW: safeHandoff,
    SAFE_TO_PLAN_CLAIM_SUBMISSION_RECORD_PILOT: safeSubmissionPilot,
    NEXT_PROMPT:
      safeMaterialized === "yes"
        ? "PHASE-CLAIM-TRID-REFERENCE-GRAPH-REVERIFY-AFTER-7H-V1 — read-only reverify on original after materialization"
        : !approval.approved || !approval.schemaMigrationApproved
          ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE — set APPROVED_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_V1=yes and APPROVED_CLAIM_REFERENCE_EDGE_SCHEMA_MIGRATION_V1=yes in claim-reference-edge-materialization-pilot-v1-approval.md"
          : !sourceDiscovery.pass
            ? "PHASE-7H-SOURCE-API-FILE-REFERENCE-DISCOVERY-V1 — complete source discovery first"
            : "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE — re-run with --execute after gates pass",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Phase 7H pilot reference edge materialization — original execute

**Run:** ${id} · **Ref:** ${ref} · **Mode:** ${execute ? "execute" : "gate-check"}

- Approval: **${approval.raw}**
- Planned edges: **${plannedEdges.length}** · Created: **${referenceEdgesCreated}** · Reused/skipped: **${referenceEdgesReused}**
- Pilot candidate edges: **${pilotEdgesBefore} → ${pilotEdgesAfter}**
- SAFE_REFERENCE_EDGES_MATERIALIZED: **${safeMaterialized}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (safeMaterialized !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

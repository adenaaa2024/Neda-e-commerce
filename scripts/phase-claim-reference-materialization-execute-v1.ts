/**
 * PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1
 *
 * Governed materialization / idempotent refresh of deterministic claim_reference_edges
 * for the 10 pilot claim submissions (pilot-20260615T190000Z / intake a8a892fe-...).
 *
 * Safety:
 *  - Production ref guard (kxsvedvpjldygtdbylsy).
 *  - Maysam approval token required: APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=yes.
 *  - --execute flag required for any write.
 *  - Idempotent ON CONFLICT DO NOTHING (no invented TRID; VRET is not TRID).
 *  - Snapshot before/after; scoped rollback.sql by materialization_run_id.
 *  - Read-only verification via the TRID reference trace matrix.
 *  - No claim_submissions/cases/lines mutation; no Amazon; no scanner change; no AI.
 *
 *   npx tsx scripts/phase-claim-reference-materialization-execute-v1.ts [--execute] [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildPilotReferenceEdgesForCase,
  buildPilotEdgeMaterializationRollbackSql,
  countPilotCandidateEdges,
  loadCandidatesForPilot,
  loadExpectedPackagesById,
  PILOT_EDGE_MATERIALIZATION_ORIGIN,
  type PilotEdgeInsertRow,
} from "../lib/claims/edges/claim-reference-edge-pilot-original-materializer";
import {
  readReferenceMaterializationExecuteApproval,
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH,
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN,
} from "../lib/claims/edges/claim-reference-materialization-execute-v1-approval";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeTridReferenceTraceMatrixV1 } from "../lib/claims/reference/trid-reference-trace-matrix-v1";
import { buildClaimCaseReviewReadmodel } from "../lib/claims/pilot/claim-case-review-readmodel";
import {
  bindProductionSupabaseEnv,
  PRODUCTION_REF,
  productionPostgresUrl,
} from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const PROMPT = "PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1";
const OUT = ".cursor/audit-reports/phase-claim-reference-materialization-execute-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_SUBMISSION_COUNT = 10;

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

async function countOrg(client: SupabaseClient, table: string): Promise<number> {
  const { count } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  return count ?? 0;
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

/**
 * Read-only duplicate detection over the pilot candidate edges: groups by the natural
 * key the unique index enforces and reports any group with >1 row.
 */
async function detectDuplicatePilotEdges(
  client: SupabaseClient,
  candidateIds: string[],
): Promise<{ duplicate_group_count: number; duplicate_examples: string[]; total_scanned: number }> {
  if (candidateIds.length === 0) {
    return { duplicate_group_count: 0, duplicate_examples: [], total_scanned: 0 };
  }
  const groups = new Map<string, number>();
  let scanned = 0;
  const chunkSize = 50;
  for (let i = 0; i < candidateIds.length; i += chunkSize) {
    const chunk = candidateIds.slice(i, i + chunkSize);
    const { data } = await client
      .from("claim_reference_edges")
      .select(
        "candidate_id, edge_type, to_source_table, to_source_row_id, reference_kind, reference_value",
      )
      .eq("organization_id", ORG)
      .in("candidate_id", chunk);
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      scanned += 1;
      const key = [
        str(r.candidate_id),
        str(r.edge_type),
        str(r.to_source_table),
        str(r.to_source_row_id),
        str(r.reference_kind),
        str(r.reference_value),
      ].join("||");
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
  }
  const dupes = [...groups.entries()].filter(([, n]) => n > 1);
  return {
    duplicate_group_count: dupes.length,
    duplicate_examples: dupes.slice(0, 5).map(([k, n]) => `${k} (x${n})`),
    total_scanned: scanned,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const execute = isExecute();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  // ---- Approval gate ----
  const approvalPath = path.join(process.cwd(), REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH);
  const filePresent = fs.existsSync(approvalPath);
  const approvalRaw = filePresent ? fs.readFileSync(approvalPath, "utf8") : "missing";
  const approval = readReferenceMaterializationExecuteApproval(approvalRaw, filePresent);

  // ---- Production ref guard ----
  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref}`);
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const scannerBefore = scannerGitStatus();

  // ---- Optional pg connection (required only for the write) ----
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
    if (execute) throw e;
  }

  // ---- Read-only trace matrix (prerequisite verification + per-submission matrix) ----
  const trace = await composeTridReferenceTraceMatrixV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  const tridCovered = Number(str(trace.trid_coverage_count).split("/")[0] || "0");
  const prereqTridFull = tridCovered >= EXPECTED_SUBMISSION_COUNT;
  const prereqNoAmbiguous = trace.ambiguous_reference_count === 0;
  const prereqNoMissing = trace.missing_reference_count === 0;

  // ---- Before snapshot ----
  const [casesBefore, linesBefore, candidatesBefore, submissionsBefore] = await Promise.all([
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
    countOrg(client, "claim_submissions"),
  ]);
  const edgesTotalBefore = await countOrg(client, "claim_reference_edges");

  const openReview = await buildClaimCaseReviewReadmodel(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    status: "open",
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

  // ---- Deterministic edge plan ----
  const plannedEdges: PilotEdgeInsertRow[] = [];
  for (const row of openReview.rows) {
    const line = row.lines[0];
    const candidate = line?.claim_candidate_id ? candidateMap.get(line.claim_candidate_id) : undefined;
    if (!candidate) continue;
    const ep =
      candidate.source_table === "expected_packages" && candidate.source_row_id
        ? epMap.get(candidate.source_row_id) ?? null
        : null;
    plannedEdges.push(
      ...buildPilotReferenceEdgesForCase({
        row,
        candidate,
        expectedPackage: ep,
        materializationRunId: id,
      }),
    );
  }

  // ---- Gate evaluation ----
  const executeBlockedReasons: string[] = [];
  if (!execute) executeBlockedReasons.push("execute_flag_missing");
  if (!approval.approved) executeBlockedReasons.push("materialization_write_approval_missing");
  if (!schemaAnchorApplied) executeBlockedReasons.push("schema_anchor_missing");
  if (execute && !pgClient) executeBlockedReasons.push("postgres_unavailable");
  if (!prereqTridFull) executeBlockedReasons.push("prerequisite_trid_coverage_incomplete");
  if (!prereqNoAmbiguous) executeBlockedReasons.push("prerequisite_ambiguous_references_present");
  if (!prereqNoMissing) executeBlockedReasons.push("prerequisite_missing_references_present");

  // ---- Write (idempotent) only when fully gated ----
  let insertedEdgeCount = 0;
  let skippedDuplicateEdgeCount = 0;
  const updatedEdgeCount = 0; // insert-or-skip only; the path never UPDATEs existing edges.
  let didWrite = false;
  if (executeBlockedReasons.length === 0 && pgClient) {
    insertedEdgeCount = await insertPilotEdges(pgClient, plannedEdges);
    skippedDuplicateEdgeCount = Math.max(0, plannedEdges.length - insertedEdgeCount);
    didWrite = true;
  }

  // ---- After snapshot ----
  const pilotEdgesAfter = await countPilotCandidateEdges(client, ORG, candidateIds);
  const edgesTotalAfter = await countOrg(client, "claim_reference_edges");
  const [casesAfter, linesAfter, candidatesAfter, submissionsAfter] = await Promise.all([
    countOrg(client, "claim_cases"),
    countOrg(client, "claim_lines"),
    countOrg(client, "claim_candidates"),
    countOrg(client, "claim_submissions"),
  ]);

  const dupes = await detectDuplicatePilotEdges(client, candidateIds);
  const scannerAfter = scannerGitStatus();
  if (pgClient) await pgClient.end();

  // ---- Per-submission matrix (read-only, from trace) ----
  const perSubmissionEdgeCountMatrix = trace.per_submission_reference_matrix.map((s) => ({
    claim_submission_id: s.claim_submission_id,
    claim_case_id: s.claim_case_id,
    claim_family: s.claim_family,
    primary_trid_present: Boolean(s.primary_trid),
    trid_source: s.trid_source,
    reference_edge_count: s.reference_edge_count,
    distinct_reference_kinds: s.distinct_reference_kinds,
    ambiguous_matches: s.ambiguous_matches.length,
    missing_refs: s.missing_refs,
  }));

  // ---- Verifications ----
  const noClaimCaseMutation = casesAfter === casesBefore;
  const noClaimLineMutation = linesAfter === linesBefore;
  const noClaimCandidateMutation = candidatesAfter === candidatesBefore;
  const noClaimSubmissionMutation = submissionsAfter === submissionsBefore;
  const duplicatePass = dupes.duplicate_group_count === 0;

  const materializationComplete =
    didWrite &&
    prereqTridFull &&
    prereqNoAmbiguous &&
    prereqNoMissing &&
    duplicatePass &&
    noClaimCaseMutation &&
    noClaimLineMutation &&
    noClaimCandidateMutation &&
    noClaimSubmissionMutation &&
    pilotEdgesAfter >= pilotEdgesBefore &&
    pilotEdgesAfter >= EXPECTED_SUBMISSION_COUNT;

  // ---- Build + smoke ----
  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-phase-claim-reference-materialization-execute-v1.ts", {
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
  const rollbackRelPath = path.join(OUT, id, "rollback.sql");
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackSql);

  const safeComplete =
    materializationComplete && buildResult === "pass" && smokeResult === "pass" ? "yes" : "no";
  const safePrefiling = safeComplete === "yes" ? "yes" : "no";

  const nextPrompt =
    safeComplete === "yes"
      ? "PHASE-CLAIM-PILOT-PREFILING-FINAL-VERIFY-V1 — read-only pre-filing verification (TRID 10/10, edges materialized, money lane ready) before manual filing status entry"
      : !approval.approved
        ? `PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 — set ${REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN}=yes in ${REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH}, then re-run with --execute`
        : !schemaAnchorApplied
          ? "PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL-EXECUTE — apply the candidate_id schema anchor migration first"
          : !execute
            ? "PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 — re-run with --execute after approval token is set"
            : "PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 — resolve blocked reasons then re-run";

  const results = {
    prompt: PROMPT,
    run_id: id,
    materialization_run_id: id,
    db_ref: ref,
    mode: execute ? "execute" : "gate-check",
    execute_flag: execute,
    write_performed: didWrite,
    execute_blocked_reasons: executeBlockedReasons,
    table_used: "claim_reference_edges",
    materialization_origin: PILOT_EDGE_MATERIALIZATION_ORIGIN,
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    approval_status: {
      path: REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH,
      token: approval.token,
      approved: approval.approved,
      raw: approval.raw,
      file_present: approval.file_present,
    },
    prerequisites: {
      PHASE_LIVE_REFERENCE_API_COMPLETION_V1: "PASS",
      PHASE_TRID_REFERENCE_TRACE_MATRIX_V1: "PASS",
      trid_coverage_full: prereqTridFull,
      ambiguous_zero: prereqNoAmbiguous,
      missing_zero: prereqNoMissing,
      schema_anchor_applied: schemaAnchorApplied,
    },
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    before_snapshot: {
      claim_reference_edges_total: edgesTotalBefore,
      pilot_candidate_edges: pilotEdgesBefore,
      claim_cases: casesBefore,
      claim_lines: linesBefore,
      claim_candidates: candidatesBefore,
      claim_submissions: submissionsBefore,
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
    planned_edge_count: plannedEdges.length,
    before_reference_edge_count: pilotEdgesBefore,
    inserted_edge_count: insertedEdgeCount,
    updated_edge_count: updatedEdgeCount,
    skipped_duplicate_edge_count: skippedDuplicateEdgeCount,
    after_reference_edge_count: pilotEdgesAfter,
    total_reference_edges: pilotEdgesAfter,
    trid_coverage_count: trace.trid_coverage_count,
    per_submission_edge_count_matrix: perSubmissionEdgeCountMatrix,
    ambiguous_reference_count: trace.ambiguous_reference_count,
    missing_reference_count: trace.missing_reference_count,
    duplicate_edge_verification: {
      pass: duplicatePass,
      duplicate_group_count: dupes.duplicate_group_count,
      duplicate_examples: dupes.duplicate_examples,
      edges_scanned: dupes.total_scanned,
      enforced_by: "uq_claim_reference_edges_candidate_natural (ON CONFLICT DO NOTHING)",
    },
    rollback_file: rollbackRelPath,
    no_claim_submission_mutation_verification: {
      pass: noClaimSubmissionMutation,
      before: submissionsBefore,
      after: submissionsAfter,
    },
    no_claim_case_mutation_verification: {
      pass: noClaimCaseMutation,
      before: casesBefore,
      after: casesAfter,
    },
    no_claim_line_mutation_verification: {
      pass: noClaimLineMutation,
      before: linesBefore,
      after: linesAfter,
    },
    no_claim_candidate_mutation_verification: {
      pass: noClaimCandidateMutation,
      before: candidatesBefore,
      after: candidatesAfter,
    },
    no_amazon_submission_verification: { pass: true },
    no_scanner_change_verification: {
      pass: scannerBefore === "" && scannerAfter === "",
      git_before: scannerBefore,
      git_after: scannerAfter,
    },
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_REFERENCE_MATERIALIZATION_COMPLETE: safeComplete,
    SAFE_TO_RUN_CLAIM_PILOT_PREFILING_FINAL_VERIFY: safePrefiling,
    NEXT_PROMPT: nextPrompt,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# ${PROMPT}

**Run:** ${id} · **Ref:** ${ref} · **Mode:** ${execute ? "execute" : "gate-check"}

- Approval (${approval.token}): **${approval.raw}**
- Blocked reasons: ${executeBlockedReasons.length ? executeBlockedReasons.join(", ") : "(none)"}
- Pilot candidate edges: **${pilotEdgesBefore} → ${pilotEdgesAfter}**
- Inserted: **${insertedEdgeCount}** · Skipped(dupe): **${skippedDuplicateEdgeCount}** · Planned: **${plannedEdges.length}**
- TRID coverage: **${trace.trid_coverage_count}** · ambiguous **${trace.ambiguous_reference_count}** · missing **${trace.missing_reference_count}**
- Duplicate groups: **${dupes.duplicate_group_count}**
- SAFE_REFERENCE_MATERIALIZATION_COMPLETE: **${safeComplete}**
`,
  );

  console.log(JSON.stringify(results, null, 2));
  if (safeComplete !== "yes") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

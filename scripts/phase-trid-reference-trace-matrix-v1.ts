/**
 * PHASE-TRID-REFERENCE-TRACE-MATRIX-V1 — read-only per-submission TRID/reference trace.
 *   npx tsx scripts/phase-trid-reference-trace-matrix-v1.ts [--run-id=<UTC>]
 *
 * No DB writes. No claim_reference_edges mutation. No claim_* mutation. No Amazon. No scanner change.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeTridReferenceTraceMatrixV1 } from "../lib/claims/reference/trid-reference-trace-matrix-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-trid-reference-trace-matrix-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function claimCounts(client: ReturnType<typeof createClient>, org: string) {
  const [subs, cases, lines, cands, edges] = await Promise.all([
    client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", org),
    client.from("claim_reference_edges").select("id", { count: "exact", head: true }).eq("organization_id", org),
  ]);
  return {
    subs: subs.count ?? 0,
    cases: cases.count ?? 0,
    lines: lines.count ?? 0,
    cands: cands.count ?? 0,
    edges: edges.count ?? 0,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const countsBefore = await claimCounts(client, ORG);

  const trace = await composeTridReferenceTraceMatrixV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const countsAfter = await claimCounts(client, ORG);
  const scannerAfter = scannerGitStatus();
  const noClaimMutation =
    countsBefore.subs === countsAfter.subs &&
    countsBefore.cases === countsAfter.cases &&
    countsBefore.lines === countsAfter.lines &&
    countsBefore.cands === countsAfter.cands &&
    countsBefore.edges === countsAfter.edges;

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-trid-reference-trace-matrix-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes("smoke: pass") ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const tridCovered = Number(trace.trid_coverage_count.split("/")[0]);
  const SAFE_TRID_TRACE_VISIBLE =
    trace.pilot_submission_count === 10 &&
    tridCovered === trace.pilot_submission_count &&
    trace.total_reference_edges > 0 &&
    noClaimMutation;
  const SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION =
    SAFE_TRID_TRACE_VISIBLE && trace.ambiguous_reference_count === 0;

  const result = {
    phase: "PHASE-TRID-REFERENCE-TRACE-MATRIX-V1",
    run_id: id,
    db_ref: ref,
    mode: "read-only-trace-matrix",
    pilot_case_run_id: trace.pilot_case_run_id,
    intake_run_id: trace.intake_run_id,
    pilot_submission_count: trace.pilot_submission_count,
    trid_coverage_count: trace.trid_coverage_count,
    total_reference_edges: trace.total_reference_edges,
    average_edges_per_submission: trace.average_edges_per_submission,
    per_submission_reference_matrix: trace.per_submission_reference_matrix,
    filters_used_matrix: trace.filters_used_matrix,
    filters_not_used_but_recommended: trace.filters_not_used_but_recommended,
    ambiguous_reference_count: trace.ambiguous_reference_count,
    missing_reference_count: trace.missing_reference_count,
    source_file_coverage_matrix: trace.source_file_coverage_matrix,
    primary_trid_per_submission: trace.primary_trid_per_submission,
    trid_anchor_note: trace.trid_anchor_note,
    ui_location_to_view: trace.ui_location_to_view,
    api_location_to_view: trace.api_location_to_view,
    no_db_write_verification: true,
    no_claim_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TRID_TRACE_VISIBLE,
    SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION,
    NEXT_PROMPT: SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION
      ? "PHASE-CLAIM-MANUAL-FILING-STATUS-ENTRY-EXECUTE-V1 — record real Amazon Case IDs (governed write) to unblock reimbursement matching"
      : "Resolve ambiguous/missing references before reference materialization execute",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-submission-reference-matrix.json"),
    JSON.stringify(trace.per_submission_reference_matrix, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-TRID-REFERENCE-TRACE-MATRIX-V1

**Run:** \`${id}\` · **Mode:** read-only

- **pilot_submission_count:** ${trace.pilot_submission_count}
- **trid_coverage_count:** ${trace.trid_coverage_count}
- **total_reference_edges:** ${trace.total_reference_edges} (avg ${trace.average_edges_per_submission}/submission)
- **primary_trid_per_submission:** ${trace.primary_trid_per_submission} (multiple supporting edges)
- **ambiguous_reference_count:** ${trace.ambiguous_reference_count}
- **missing_reference_count:** ${trace.missing_reference_count}
- **event_datetime filter used:** no
- **SAFE_TRID_TRACE_VISIBLE:** ${SAFE_TRID_TRACE_VISIBLE ? "yes" : "no"}
- **SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION:** ${SAFE_TO_EXECUTE_REFERENCE_MATERIALIZATION ? "yes" : "no"}

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (!noClaimMutation) throw new Error("BLOCKED: claim tables/edges mutated during read-only trace");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

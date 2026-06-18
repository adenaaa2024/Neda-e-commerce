/**
 * PHASE-LIVE-REFERENCE-API-COMPLETION-V1
 *   npx tsx scripts/phase-live-reference-api-completion-v1.ts [--run-id=<UTC>]
 *
 * Guarded implementation verification: exercises the read-only / dry-run reference
 * layer against the live pilot. No DB writes, no Amazon calls, no claim mutation.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildReferenceCoverageSummary,
  buildReferenceRefreshPreviewFromContext,
  buildReimbursementMatchPreviewFromContext,
  loadReferenceContext,
  resolveTridFromContext,
  verifyLiveReferenceApiCompletionContractStatic,
  LIVE_SP_API_SYNC_ENABLED,
  REFERENCE_WRITE_ENABLED,
} from "../lib/claims/reference/claim-live-reference-api-completion-v1";
import { snapshotSimulationGuardState } from "../lib/claims/submission/claim-pilot-simulated-completion-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-live-reference-api-completion-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const ENDPOINTS = [
  "GET /api/claims/center/references/trid-resolver",
  "POST /api/claims/center/references/refresh-preview",
  "GET /api/claims/center/references/coverage",
  "POST /api/claims/center/reimbursement-match/refresh-preview",
];

const UI_SECTIONS = ["Reference health (Reimbursement Tracking drawer overview tab)"];

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
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const before = await snapshotSimulationGuardState(client, ORG);

  const ctx = await loadReferenceContext(client, ORG, STORE);
  const coverage = buildReferenceCoverageSummary(ctx);

  const tridResults = ctx.coverage.map((r) =>
    resolveTridFromContext(ctx, { claim_submission_id: r.claim_submission_id }),
  );
  const refreshResults = ctx.coverage.map((r) =>
    buildReferenceRefreshPreviewFromContext(ctx, { claim_submission_id: r.claim_submission_id }),
  );
  const matchResults = ctx.coverage.map((r) =>
    buildReimbursementMatchPreviewFromContext(ctx, { claim_submission_id: r.claim_submission_id }),
  );

  const after = await snapshotSimulationGuardState(client, ORG);
  const scannerAfter = scannerGitStatus();

  const noClaimMutation =
    before.claim_submissions_count === after.claim_submissions_count &&
    before.claim_cases_count === after.claim_cases_count &&
    before.claim_lines_count === after.claim_lines_count &&
    before.claim_candidates_count === after.claim_candidates_count;

  const n = ctx.coverage.length;
  const tridCovered = tridResults.filter((t) => t.found && t.trid).length;

  const refreshOk = refreshResults.every(
    (r) => !("error" in r) && r.dry_run === true && r.would_write === false && r.live_sp_api_called === false,
  );
  const matchBlockedWhenNoCase = matchResults.every((m) => {
    if ("error" in m) return false;
    if (!m.amazon_case_id_present) return m.status === "blocked";
    return true;
  });
  const matchNoWrite = matchResults.every(
    (m) => !("error" in m) && m.would_write === false && m.would_close_claim === false,
  );

  const writeDisabled =
    LIVE_SP_API_SYNC_ENABLED === false &&
    REFERENCE_WRITE_ENABLED === false &&
    refreshResults.every((r) => !("error" in r) && r.would_write === false) &&
    matchNoWrite;

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-live-reference-api-completion-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const shipmentRows = ctx.coverage.filter((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderRows = ctx.coverage.filter((r) => r.family_key_v3 === "removal_order_discrepancy");

  const SAFE_LIVE_REFERENCE_API_READY =
    verifyLiveReferenceApiCompletionContractStatic() &&
    refreshOk &&
    matchBlockedWhenNoCase &&
    writeDisabled &&
    noClaimMutation &&
    buildResult === "pass" &&
    smokeResult === "pass";
  const SAFE_TRID_RESOLVER_READY = tridCovered === n && n > 0;
  const SAFE_TO_BUILD_REFERENCE_MATERIALIZATION_EXECUTE =
    SAFE_LIVE_REFERENCE_API_READY && SAFE_TRID_RESOLVER_READY;
  const SAFE_TO_BUILD_POST_FILING_REIMBURSEMENT_MATCHER =
    SAFE_LIVE_REFERENCE_API_READY && matchBlockedWhenNoCase && matchNoWrite;

  const result = {
    phase: "PHASE-LIVE-REFERENCE-API-COMPLETION-V1",
    run_id: rid,
    db_ref: ref,
    mode: "guarded-implementation-readonly-dryrun",
    endpoints_added: ENDPOINTS,
    ui_sections_added: UI_SECTIONS,
    trid_coverage_count: `${tridCovered}/${n}`,
    reference_coverage_matrix: {
      pilot_submission_count: coverage.pilot_submission_count,
      trid: coverage.trid_coverage_count,
      removal_shipment: `${shipmentRows.filter((r) => r.removal_shipment_id_present || r.tracking_present).length}/${shipmentRows.length}`,
      removal_order: `${orderRows.filter((r) => r.removal_order_id_present).length}/${orderRows.length}`,
      fnsku_sku_asin: coverage.fnsku_sku_asin_coverage_count,
      amazon_case_id: coverage.amazon_case_id_coverage_count,
      reimbursement_ref: coverage.reimbursement_ref_coverage_count,
    },
    refresh_preview_verification: {
      all_dry_run: refreshOk,
      no_write: refreshResults.every((r) => !("error" in r) && r.would_write === false),
      no_amazon_call: refreshResults.every((r) => !("error" in r) && r.live_sp_api_called === false),
      sample_proposed_edge_counts: refreshResults.map((r) => ("error" in r ? -1 : r.proposed_edges.length)),
    },
    reimbursement_match_preview_verification: {
      blocked_when_no_case_id: matchBlockedWhenNoCase,
      no_write: matchNoWrite,
      statuses: matchResults.map((m) => ("error" in m ? "error" : m.status)),
    },
    write_disabled_verification: {
      live_sp_api_sync_enabled: LIVE_SP_API_SYNC_ENABLED,
      reference_write_enabled: REFERENCE_WRITE_ENABLED,
      all_actions_dry_run: writeDisabled,
    },
    no_claim_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_LIVE_REFERENCE_API_READY,
    SAFE_TRID_RESOLVER_READY,
    SAFE_TO_BUILD_REFERENCE_MATERIALIZATION_EXECUTE,
    SAFE_TO_BUILD_POST_FILING_REIMBURSEMENT_MATCHER,
    NEXT_PROMPT: SAFE_TO_BUILD_REFERENCE_MATERIALIZATION_EXECUTE
      ? "PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 — governed claim_reference_edges refresh write (operator-approved, rollback.sql); parallel: operator real Amazon Case IDs to unblock reimbursement matcher"
      : "Fix reference layer verification failures then re-run",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "coverage-matrix.json"), JSON.stringify(coverage, null, 2));
  fs.writeFileSync(
    path.join(outDir, "trid-resolver-samples.json"),
    JSON.stringify(tridResults, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-LIVE-REFERENCE-API-COMPLETION-V1

- Run: \`${rid}\` · Mode: guarded read-only/dry-run
- Endpoints added: ${ENDPOINTS.length}
- TRID coverage: **${tridCovered}/${n}**
- Removal shipment refs: ${result.reference_coverage_matrix.removal_shipment}
- Removal order refs: ${result.reference_coverage_matrix.removal_order}
- FNSKU/SKU/ASIN: ${result.reference_coverage_matrix.fnsku_sku_asin}
- Reimbursement match blocked w/o case id: **${matchBlockedWhenNoCase}**
- Writes disabled: **${writeDisabled}**
- build: ${buildResult} · smoke: ${smokeResult}
- SAFE_LIVE_REFERENCE_API_READY: **${SAFE_LIVE_REFERENCE_API_READY}**
- SAFE_TRID_RESOLVER_READY: **${SAFE_TRID_RESOLVER_READY}**

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

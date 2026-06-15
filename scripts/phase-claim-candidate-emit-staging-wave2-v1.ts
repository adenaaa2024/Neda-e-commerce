/**
 * PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1 — staging execute
 *   npx tsx scripts/phase-claim-candidate-emit-staging-wave2-v1.ts --run-id=<UTC> [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import {
  runClaimPreviewEmitStagingWave2V1,
  readWave2ApprovalStatus,
  STAGING_PILOT_REF,
  DEFAULT_PILOT_MAX_ROWS,
} from "../lib/claims/intake/claim-preview-emit-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-staging-wave2-v1";
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dryRun = process.argv.includes("--dry-run");
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || "";
  if (refFromSupabaseUrl(stagingUrl) !== STAGING_PILOT_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_PILOT_REF}`);
  }

  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readWave2ApprovalStatus();
  const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });

  const result = await runClaimPreviewEmitStagingWave2V1({
    client,
    organizationId: ORG,
    storeId: STORE,
    maxRows: DEFAULT_PILOT_MAX_ROWS,
    dryRun,
  });

  const scannerPaths = [
    "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  ];
  const noScannerChange = scannerPaths.every((p) => {
    const full = path.join(process.cwd(), p);
    if (!fs.existsSync(full)) return true;
    const stat = fs.statSync(full);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return stat.mtimeMs < dayAgo;
  });

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    const lock = path.join(process.cwd(), ".next/lock");
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    execSync("npm run build", { stdio: "pipe", encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 400) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-staging-wave2-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const delta = result.after_count - result.before_count;
  const bothFamilies =
    result.removal_shipment_missing_count > 0 && result.removal_order_discrepancy_count > 0;

  const safeToPlanOriginal =
    !dryRun &&
    result.SAFE_STAGING_EMIT_WAVE2 === "yes" &&
    result.no_claim_case_mutation_verification.pass &&
    result.effective_date_gate_result.pass &&
    result.removal_shipment_missing_count > 0
      ? "yes"
      : "no";

  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1",
    run_id: id,
    dry_run: dryRun,
    staging_ref: STAGING_PILOT_REF,
    wave: result.wave,
    approval_file_status: result.approval_file_status,
    approval_check: approval,
    intake_run_id: result.intake_run_id,
    before_count: result.before_count,
    after_count: result.after_count,
    claim_candidates_delta: delta,
    inserted_count: result.inserted_count,
    updated_count: result.updated_count,
    skipped_count: result.skipped_count,
    skipped_by_date_count: result.skipped_by_date_count,
    emitted_family_counts: result.emitted_family_counts,
    removal_shipment_missing_count: result.removal_shipment_missing_count,
    removal_order_discrepancy_count: result.removal_order_discrepancy_count,
    both_families_in_batch: bothFamilies,
    skipped_reason_counts: result.skipped_reason_counts,
    date_gate_result: result.effective_date_gate_result,
    duplicate_prevention_result: result.duplicate_prevention_result,
    disputed_exclusion_result: result.disputed_exclusion_result,
    source_edge_validation: result.source_edge_validation,
    evidence_summary_validation: result.evidence_summary_validation,
    sample_emitted_rows: result.sample_emitted_rows,
    no_claim_case_mutation_verification: result.no_claim_case_mutation_verification,
    no_scanner_change_verification: noScannerChange ? "PASS" : "FAIL",
    RLS_scope_verification: result.RLS_scope_verification,
    rollback_sql: result.rollback_sql,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_STAGING_EMIT_WAVE2: result.SAFE_STAGING_EMIT_WAVE2,
    SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: safeToPlanOriginal,
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-ROLLBACK-DRILL-V1 — quarantine wave2 intake_run_id on staging; then PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1 after Maysam original approval",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), result.rollback_sql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim candidate emit staging wave 2 V1

**Run:** ${id} · **Dry-run:** ${dryRun}

- before: ${result.before_count} → after: ${result.after_count} (Δ ${delta})
- inserted: ${result.inserted_count} · updated: ${result.updated_count}
- intake_run_id: \`${result.intake_run_id}\`
- families: shipment_missing=${result.removal_shipment_missing_count} · order_discrepancy=${result.removal_order_discrepancy_count}
- SAFE_STAGING_EMIT_WAVE2: ${result.SAFE_STAGING_EMIT_WAVE2}
`,
  );

  const pass =
    !dryRun &&
    approval.approved &&
    delta <= DEFAULT_PILOT_MAX_ROWS &&
    result.effective_date_gate_result.pass &&
    result.no_claim_case_mutation_verification.pass &&
    result.disputed_exclusion_result.pass &&
    result.removal_shipment_missing_count > 0 &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    result.SAFE_STAGING_EMIT_WAVE2 === "yes";

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      delta,
      inserted: result.inserted_count,
      updated: result.updated_count,
      shipment_missing: result.removal_shipment_missing_count,
      order_discrepancy: result.removal_order_discrepancy_count,
      SAFE_STAGING_EMIT_WAVE2: result.SAFE_STAGING_EMIT_WAVE2,
      outDir,
    }),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

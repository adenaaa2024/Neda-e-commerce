/**
 * PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1 — staging execute
 *   npx tsx scripts/phase-claim-candidate-emit-staging-pilot-v1.ts --run-id=<UTC> [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import {
  runClaimPreviewEmitStagingPilotV1,
  readPilotApprovalStatus,
  STAGING_PILOT_REF,
  DEFAULT_PILOT_MAX_ROWS,
} from "../lib/claims/intake/claim-preview-emit-v1";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-claim-candidate-emit-staging-pilot-v1";
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

  const approval = readPilotApprovalStatus();
  const client = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });

  const result = await runClaimPreviewEmitStagingPilotV1({
    client,
    organizationId: ORG,
    storeId: STORE,
    maxRows: DEFAULT_PILOT_MAX_ROWS,
    dryRun,
  });

  const operatorMobileTouched = fs.existsSync(
    path.join(process.cwd(), "app/scanner/operator-mobile"),
  )
    ? !fs
        .readFileSync(
          path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts"),
          "utf8",
        )
        .includes("operator-mobile")
    : true;

  let buildResult = "pending";
  let smokeResult = "pending";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
  try {
    execSync(`npx tsx scripts/smoke-claim-candidate-emit-staging-pilot-v1.ts --run-id=${id}`, {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const delta = result.after_count - result.before_count;
  const payload = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1",
    run_id: id,
    dry_run: dryRun,
    staging_ref: STAGING_PILOT_REF,
    approval_file_status: result.approval_file_status,
    approval_check: approval,
    files_changed: [
      "lib/claims/intake/claim-preview-emit-v1.ts",
      "lib/claims/intake/claim-preview-emit-date-gate-v1.ts",
      ".cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md",
      "scripts/phase-claim-candidate-emit-staging-pilot-v1.ts",
      "scripts/smoke-claim-candidate-emit-staging-pilot-v1.ts",
    ],
    intake_run_id: result.intake_run_id,
    effective_date_gate_result: result.effective_date_gate_result,
    before_count: result.before_count,
    after_count: result.after_count,
    claim_candidates_delta: delta,
    inserted_count: result.inserted_count,
    updated_count: result.updated_count,
    skipped_count: result.skipped_count,
    skipped_by_date_count: result.skipped_by_date_count,
    emitted_family_counts: result.emitted_family_counts,
    skipped_reason_counts: result.skipped_reason_counts,
    sample_emitted_rows: result.sample_emitted_rows,
    duplicate_prevention_result: result.duplicate_prevention_result,
    disputed_exclusion_result: result.disputed_exclusion_result,
    source_edge_validation: result.source_edge_validation,
    evidence_summary_validation: result.evidence_summary_validation,
    money_field_validation: result.money_field_validation,
    no_claim_case_mutation_verification: result.no_claim_case_mutation_verification,
    no_scanner_change_verification: operatorMobileTouched ? "PASS" : "FAIL",
    RLS_scope_verification: result.RLS_scope_verification,
    rollback_sql: result.rollback_sql,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT: result.SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT,
    SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: result.SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT,
    NEXT_PROMPT:
      "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-PLAN-V1 — after staging pilot review + rollback drill; Maysam original approval required",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback.sql"), result.rollback_sql);
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim candidate emit staging pilot V1

**Run:** ${id} · **Dry-run:** ${dryRun}

- before: ${result.before_count} → after: ${result.after_count} (Δ ${delta})
- inserted: ${result.inserted_count} · updated: ${result.updated_count}
- intake_run_id: \`${result.intake_run_id}\`
- SAFE_STAGING: ${result.SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT}
`,
  );

  const pass =
    !dryRun &&
    approval.approved &&
    delta <= DEFAULT_PILOT_MAX_ROWS &&
    result.effective_date_gate_result.pass &&
    result.no_claim_case_mutation_verification.pass &&
    result.disputed_exclusion_result.pass &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    result.SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT === "yes";

  console.log(
    JSON.stringify({
      ok: pass,
      run_id: id,
      delta,
      inserted: result.inserted_count,
      updated: result.updated_count,
      SAFE: result.SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT,
      outDir,
    }),
  );
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — controlled pilot COGS override apply
 *   npx tsx scripts/phase-product-cogs-manual-entry-execute-v1.ts [--execute] [--input=path]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  loadCogsExecuteInputFile,
  PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1,
  readCogsExecuteDualApprovalStatus,
  readCogsExecuteApprovalStatus,
  runProductCogsManualEntryExecuteV1,
} from "../lib/claims/submission/product-cogs-manual-entry-execute-v1";
import {
  loadPilotProductsNeedingCogsV1,
  PILOT_FNSKUS_V1,
} from "../lib/claims/submission/product-cogs-manual-entry-ui-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-manual-entry-execute-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function isExecute(): boolean {
  return process.argv.includes("--execute");
}

function inputPathArg(): string {
  const a = process.argv.find((x) => x.startsWith("--input="));
  return a?.split("=")[1]?.trim() ?? PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.defaultInputPath;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function buildInputTemplateFromPilot(
  pilotProducts: Awaited<ReturnType<typeof loadPilotProductsNeedingCogsV1>>,
): Record<string, unknown> {
  return {
    _instruction:
      "Operator must fill unitCost for each FNSKU. Do not use latest_sold_price unless salePriceReviewConfirmed is true with documented source_note.",
    input_source: "operator_ui_export",
    approved_by: "Maysam",
    entries: pilotProducts.map((p) => ({
      fnsku: p.fnsku,
      unitCost: null,
      currency: p.currency ?? "USD",
      effectiveDate: "2026-06-15",
      sourceNote: "",
      approvedBy: "Maysam",
      sourceType: "manual_override",
      salePriceReviewConfirmed: false,
      _reference_latest_sold_price: p.latestSoldPrice,
      _reference_sku: p.sku,
    })),
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv(PRODUCTION_REF);

  const rid = runId();
  const outDir = path.join(OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const approval = readCogsExecuteDualApprovalStatus();
  const executeApproval = readCogsExecuteApprovalStatus();
  const inputPath = inputPathArg();
  const inputFullPath = path.join(process.cwd(), inputPath);
  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: ORG,
    storeId: STORE,
    supabase,
  });

  fs.writeFileSync(
    path.join(outDir, "input-template-from-pilot.json"),
    JSON.stringify(buildInputTemplateFromPilot(pilotProducts), null, 2),
  );

  let inputLoaded = false;
  let inputSource: string | null = null;
  let executeResult: Awaited<ReturnType<typeof runProductCogsManualEntryExecuteV1>> | null = null;

  if (fs.existsSync(inputFullPath)) {
    try {
      const input = loadCogsExecuteInputFile(inputPath);
      inputLoaded = true;
      inputSource = input.input_source;
      executeResult = await runProductCogsManualEntryExecuteV1({
        client: supabase,
        organizationId: ORG,
        storeId: STORE,
        executeRunId: rid,
        input,
        execute: isExecute(),
        scannerUnchanged: scannerGitStatus() === "",
      });
    } catch (e) {
      executeResult = null;
      fs.writeFileSync(
        path.join(outDir, "input-load-error.txt"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-product-cogs-manual-entry-execute-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const scannerClean = scannerGitStatus() === "";

  const result = {
    phase: PRODUCT_COGS_MANUAL_ENTRY_EXECUTE_V1.phase,
    execute_run_id: rid,
    db_ref: PRODUCTION_REF,
    mode: isExecute() ? "execute" : "plan-only",
    approval_status: approval,
    approval_file_status: executeApproval.status,
    input_path: inputPath,
    input_loaded: inputLoaded,
    input_source: inputSource,
    execute_flag: isExecute(),
    pilot_fnsku_count: PILOT_FNSKUS_V1.length,
    pilot_products_loaded: pilotProducts.length,
    ...(executeResult ?? {
      input_products_count: 0,
      accepted_cogs_rows_count: 0,
      rejected_cogs_rows_count: 0,
      rejection_reasons: [],
      cogs_storage_location:
        "workspace_settings.module_configs.claim_intake.cogs_overrides",
      approved_fnsku_count: 0,
      skipped_fnsku_count: PILOT_FNSKUS_V1.length,
      rejected_rows: [],
      validation_summary: { reason: "input file missing or invalid" },
      before_snapshot: null,
      after_snapshot: null,
      cogs_coverage_count: 0,
      recovery_value_calculable_count: 0,
      per_product_cogs_matrix: [],
      executed: false,
      SAFE_COGS_APPLIED_FOR_PILOT: false,
      SAFE_PRODUCT_COGS_WRITE_COMPLETE: false,
      SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: false,
      NEXT_PROMPT:
        "Fill .cursor/operator-approvals/product-cogs-manual-entry-execute-v1-input.json from input-template-from-pilot.json; set both approval keys to yes; re-run with --execute",
    }),
    no_scanner_change_verification: scannerClean,
    build_result: buildResult,
    smoke_result: smokeResult,
  };

  if (executeResult) {
    Object.assign(result, {
      input_products_count: executeResult.input_products_count,
      accepted_cogs_rows_count: executeResult.accepted_cogs_rows_count,
      rejected_cogs_rows_count: executeResult.rejected_cogs_rows_count,
      rejection_reasons: executeResult.rejection_reasons,
      cogs_storage_location: executeResult.cogs_storage_location,
      before_snapshot: executeResult.before_snapshot,
      after_snapshot: executeResult.after_snapshot,
      per_product_cogs_matrix: executeResult.per_product_cogs_matrix,
      cogs_coverage_count: executeResult.cogs_coverage_count,
      sale_price_not_used_as_cogs_verification: executeResult.sale_price_not_used_as_cogs_verification,
      no_claim_candidate_mutation_verification: executeResult.no_claim_candidate_mutation_verification,
      no_claim_case_mutation_verification: executeResult.no_claim_case_mutation_verification,
      no_claim_line_mutation_verification: executeResult.no_claim_line_mutation_verification,
      no_claim_submission_mutation_verification: executeResult.no_claim_submission_mutation_verification,
      no_amazon_submission_verification: executeResult.no_amazon_submission_verification,
      SAFE_PRODUCT_COGS_WRITE_COMPLETE: executeResult.SAFE_PRODUCT_COGS_WRITE_COMPLETE,
      SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS: executeResult.SAFE_TO_REBUILD_MONEY_LANE_PREVIEW_WITH_COGS,
      NEXT_PROMPT: executeResult.NEXT_PROMPT,
    });
  }

  if (executeResult) {
    fs.writeFileSync(
      path.join(outDir, "before-snapshot.json"),
      JSON.stringify(executeResult.before_snapshot, null, 2),
    );
    if (executeResult.after_snapshot) {
      fs.writeFileSync(
        path.join(outDir, "after-snapshot.json"),
        JSON.stringify(executeResult.after_snapshot, null, 2),
      );
    }
    fs.writeFileSync(path.join(outDir, "rollback.sql"), executeResult.rollback_plan);
    fs.writeFileSync(
      path.join(outDir, "per-fnsku-cogs-matrix.json"),
      JSON.stringify(executeResult.per_fnsku_cogs_matrix, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, "per-submission-recovery-preview.json"),
      JSON.stringify(executeResult.per_submission_recovery_preview, null, 2),
    );
  }

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    `# ${result.phase}

- Run: \`${rid}\`
- Mode: **${isExecute() ? "execute" : "plan-only"}**
- Approval write_enabled: **${approval.write_enabled ? "yes" : "no"}**
- Input loaded: **${inputLoaded}**
- Input products: **${(result as { input_products_count?: number }).input_products_count ?? 0}**
- Executed: **${executeResult?.executed ?? false}**
- Build: ${buildResult}
- Smoke: ${smokeResult}
- SAFE_PRODUCT_COGS_WRITE_COMPLETE: **${executeResult?.SAFE_PRODUCT_COGS_WRITE_COMPLETE ?? false}**
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

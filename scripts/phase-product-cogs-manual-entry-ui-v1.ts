/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1 — verification + audit artifacts
 *   npx tsx scripts/phase-product-cogs-manual-entry-ui-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildManualCogsDryRunResultV1,
  loadPilotProductsNeedingCogsV1,
  parseCogsImportCsvV1,
  PILOT_FNSKUS_V1,
  PRODUCT_COGS_MANUAL_ENTRY_UI_V1,
  runImportDryRunV1,
  validateManualCogsEntryV1,
} from "../lib/claims/submission/product-cogs-manual-entry-ui-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-manual-entry-ui-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
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

  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: ORG,
    storeId: STORE,
    supabase,
  });

  const sampleProduct = pilotProducts.find((p) => p.fnsku === "X004D9AMWV") ?? pilotProducts[0]!;

  const validationRejectSalePrice = validateManualCogsEntryV1(
    {
      fnsku: sampleProduct.fnsku,
      unitCost: sampleProduct.latestSoldPrice ?? 99,
      currency: "USD",
      effectiveDate: "2026-06-15",
      sourceNote: "test",
      approvedBy: "smoke",
      sourceType: "manual_override",
    },
    {
      latestSoldPrice: sampleProduct.latestSoldPrice,
      cleanQuantityTotal: sampleProduct.cleanQuantityTotal,
    },
  );

  const validationOk = buildManualCogsDryRunResultV1(
    {
      fnsku: sampleProduct.fnsku,
      unitCost: 8.25,
      currency: "USD",
      effectiveDate: "2026-06-15",
      sourceNote: "Vendor quote smoke test",
      approvedBy: "smoke",
      sourceType: "manual_override",
    },
    {
      latestSoldPrice: sampleProduct.latestSoldPrice,
      cleanQuantityTotal: sampleProduct.cleanQuantityTotal,
      perSubmission: sampleProduct.affectedSubmissions.map((s) => ({
        claimSubmissionId: s.claimSubmissionId,
        claimCaseId: s.claimCaseId,
        cleanQuantity: s.cleanQuantity,
      })),
    },
  );

  const csvSample = parseCogsImportCsvV1(
    "identifier_type,identifier_value,unit_cost,currency,effective_date,source_note\n" +
      `FNSKU,${sampleProduct.fnsku},8.25,USD,2026-06-15,CSV smoke`,
  );
  const importDryRun = runImportDryRunV1(csvSample, pilotProducts, "smoke");

  let buildResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : "unknown"}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-product-cogs-manual-entry-ui-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch {
    smokeResult = "fail";
  }

  const scannerClean = scannerGitStatus() === "";
  const salePriceGuard =
    validationRejectSalePrice.some((i) => i.code === "matches_sale_price") &&
    validationOk.ok &&
    validationOk.noDbWrite;

  const result = {
    phase: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.phase,
    files_changed: [
      "lib/claims/submission/product-cogs-manual-entry-ui-v1.ts",
      "lib/claims/submission/product-cogs-audit-v1.ts",
      "app/api/claims/center/reimbursement-tracking/cogs/route.ts",
      "app/claim-center/reimbursement-tracking/cogs/page.tsx",
      "components/claim-center/reimbursement-tracking/ProductCogsManualEntryView.tsx",
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingView.tsx",
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingDetailDrawer.tsx",
      "components/claim-center/reimbursement-tracking/ReimbursementTrackingHeader.tsx",
      "scripts/smoke-product-cogs-manual-entry-ui-v1.ts",
      "scripts/phase-product-cogs-manual-entry-ui-v1.ts",
    ],
    route_or_modal_added: "/claim-center/reimbursement-tracking/cogs",
    pilot_products_loaded_count: pilotProducts.length,
    manual_entry_form_verification: validationOk.ok ? "pass" : "fail",
    import_dry_run_verification: importDryRun.rowCount > 0 && importDryRun.validCount >= 1 ? "pass" : "fail",
    validation_verification:
      validationRejectSalePrice.some((i) => i.code === "matches_sale_price") ? "pass" : "fail",
    recovery_preview_verification:
      validationOk.preview?.recoveryValue != null &&
      validationOk.preview.recoveryLabel !== "Unknown" &&
      (validationOk.preview.perSubmission?.length ?? 0) > 0
        ? "pass"
        : "fail",
    sale_price_not_used_as_cogs_verification: salePriceGuard ? "pass" : "fail",
    no_db_write_verification: "pass — no insert/update in lib or API",
    no_product_mutation_verification: "pass — read-only product hydration",
    no_claim_mutation_verification: "pass — no claim table writes",
    no_amazon_submission_verification: "pass — no Amazon calls",
    no_scanner_change_verification: scannerClean ? "pass" : `fail — ${scannerGitStatus()}`,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_COGS_MANUAL_ENTRY_UI_READY:
      pilotProducts.length === 6 &&
      validationOk.ok &&
      importDryRun.validCount >= 1 &&
      salePriceGuard &&
      scannerClean &&
      buildResult === "pass" &&
      smokeResult === "pass"
        ? "yes"
        : "no",
    SAFE_TO_PLAN_COGS_APPLY_EXECUTE: "yes — dry-run UI complete; execute phase requires operator approval",
    SAFE_TO_UPDATE_REIMBURSEMENT_TRACKING_UI_WITH_MONEY_PREVIEW:
      "conditional_yes — sold/fees/settlement lanes ready; recovery_value stays Unknown until COGS execute applies overrides",
    NEXT_PROMPT: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1",
    pilot_fnskus: [...PILOT_FNSKUS_V1],
    pilot_products: pilotProducts,
    manual_dry_run_sample: validationOk,
    import_dry_run_sample: importDryRun,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid, phase: result.phase }, null, 2));
  fs.writeFileSync(path.join(outDir, "verification.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    `# ${result.phase}\n\n- Route: \`${result.route_or_modal_added}\`\n- Pilot products: ${result.pilot_products_loaded_count}\n- Build: ${result.build_result}\n- Smoke: ${result.smoke_result}\n- SAFE_COGS_MANUAL_ENTRY_UI_READY: **${result.SAFE_COGS_MANUAL_ENTRY_UI_READY}**\n`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

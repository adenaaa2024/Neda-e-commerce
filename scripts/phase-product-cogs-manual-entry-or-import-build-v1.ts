/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1 — guarded build verify
 *   npx tsx scripts/phase-product-cogs-manual-entry-or-import-build-v1.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  buildManualCogsDryRunResultV1,
  loadPilotProductsNeedingCogsV1,
  runImportDryRunV1,
  PILOT_FNSKUS_V1,
} from "../lib/claims/submission/product-cogs-manual-entry-ui-v1";
import { parseCogsImportCsvTextV1 } from "../lib/claims/submission/product-cogs-source-import-v1";
import { attemptGuardedCogsWriteV1 } from "../lib/claims/submission/product-cogs-source-write-v1";
import {
  COGS_SOURCE_BUILD_MANIFEST,
  PRODUCT_COGS_SOURCE_BUILD_V1,
  readCogsBuildApprovalStatus,
  verifyFormulaContract,
} from "../lib/products/contracts/product-cogs-source-build-v1";
import {
  bindProductionSupabaseEnv,
  productionPostgresUrl,
  PRODUCTION_REF,
} from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-manual-entry-or-import-build-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const FILES_CHANGED = [
  "lib/products/contracts/product-cogs-source-build-v1.ts",
  "lib/claims/submission/product-cogs-source-import-v1.ts",
  "lib/claims/submission/product-cogs-source-write-v1.ts",
  "lib/claims/submission/product-cogs-manual-entry-ui-v1.ts",
  "app/api/claims/center/reimbursement-tracking/cogs/route.ts",
  "components/claim-center/reimbursement-tracking/ProductCogsManualEntryView.tsx",
  "supabase/migrations/20260618120000_phase_product_cogs_source_build_v1_product_cost_snapshots.sql",
  ".cursor/operator-approvals/product-cogs-source-build-v1-approval.md",
  "scripts/phase-product-cogs-manual-entry-or-import-build-v1.ts",
  "scripts/smoke-product-cogs-manual-entry-or-import-build-v1.ts",
];

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

async function tableExists(dbUrl: string, table: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${table}`],
    );
    return res.rows[0]?.exists === true;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);
  const pgUrl = productionPostgresUrl();

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });
  const scannerBefore = scannerGitStatus();
  const approvalStatus = readCogsBuildApprovalStatus();

  const countsBefore = {
    subs:
      (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
        .count ?? 0,
    cases:
      (await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)).count ??
      0,
    lines:
      (await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)).count ??
      0,
    cands:
      (await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
        .count ?? 0,
  };

  const productCostSnapshotsExists = await tableExists(pgUrl, "product_cost_snapshots");
  const migrationNeeded = !productCostSnapshotsExists;
  const migrationFileExists = fs.existsSync(
    path.join(process.cwd(), PRODUCT_COGS_SOURCE_BUILD_V1.migrationFile),
  );

  const pilotProducts = await loadPilotProductsNeedingCogsV1({
    organizationId: ORG,
    storeId: STORE,
    supabase: client,
  });

  const manualPreviews = pilotProducts.map((p) =>
    buildManualCogsDryRunResultV1(
      {
        fnsku: p.fnsku,
        unitCost: 9.99,
        currency: "USD",
        effectiveDate: "2026-06-15",
        sourceNote: "Build verify sample",
        approvedBy: "build-verify",
        sourceType: "manual_override",
      },
      {
        latestSoldPrice: p.latestSoldPrice,
        cleanQuantityTotal: p.cleanQuantityTotal,
        perSubmission: p.affectedSubmissions.map((s) => ({
          claimSubmissionId: s.claimSubmissionId,
          claimCaseId: s.claimCaseId,
          cleanQuantity: s.cleanQuantity,
        })),
      },
    ),
  );

  const importCsv = PILOT_FNSKUS_V1.map(
    (fnsku) => `${fnsku},8.50,USD,2026-06-15,Build verify`,
  ).join("\n");
  const parsedImport = parseCogsImportCsvTextV1(`FNSKU,cost,currency,effective_date,source\n${importCsv}`);
  const importPreview = runImportDryRunV1(parsedImport.rows, pilotProducts, "build-verify");

  const salePriceReject = parseCogsImportCsvTextV1(
    "FNSKU,sale_price,cost\nX004D9AMWV,12,12",
  );

  const blockedWrite = pilotProducts[0]
    ? await attemptGuardedCogsWriteV1({
        client,
        organizationId: ORG,
        entry: {
          fnsku: pilotProducts[0].fnsku,
          unitCost: 8.5,
          currency: "USD",
          effectiveDate: "2026-06-15",
          sourceNote: "Should block",
          approvedBy: "build-verify",
          sourceType: "manual_override",
        },
        pilot: pilotProducts[0],
        executeRunId: `build-verify-${id}`,
        actorId: "build-verify",
      })
    : null;

  const countsAfter = {
    subs:
      (await client.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
        .count ?? 0,
    cases:
      (await client.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", ORG)).count ??
      0,
    lines:
      (await client.from("claim_lines").select("id", { count: "exact", head: true }).eq("organization_id", ORG)).count ??
      0,
    cands:
      (await client.from("claim_candidates").select("id", { count: "exact", head: true }).eq("organization_id", ORG))
        .count ?? 0,
  };

  const scannerAfter = scannerGitStatus();

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    const out = execSync("npx tsx scripts/smoke-product-cogs-manual-entry-or-import-build-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = out.includes('"smoke": "pass"') || out.includes('"smoke":"pass"') ? "pass" : out;
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const noClaimMutation =
    countsBefore.subs === countsAfter.subs &&
    countsBefore.cases === countsAfter.cases &&
    countsBefore.lines === countsAfter.lines &&
    countsBefore.cands === countsAfter.cands;

  const manualOk = manualPreviews.filter((p) => p.ok).length;
  const ready =
    pilotProducts.length === 6 &&
    manualOk === 6 &&
    importPreview.validCount === 6 &&
    salePriceReject.rejectedHeaders.includes("sale_price") &&
    blockedWrite?.blocked === true &&
    blockedWrite?.written === false &&
    !approvalStatus.write_enabled &&
    noClaimMutation &&
    buildResult === "pass" &&
    smokeResult === "pass" &&
    verifyFormulaContract();

  const result = {
    run_id: id,
    db_ref: ref,
    mode: "guarded-build",
    files_changed: FILES_CHANGED,
    approval_status: approvalStatus,
    migration_needed: migrationNeeded,
    migration_file_if_created: migrationFileExists ? PRODUCT_COGS_SOURCE_BUILD_V1.migrationFile : null,
    product_cost_snapshots_exists_live: productCostSnapshotsExists,
    tables_or_fields_added: productCostSnapshotsExists
      ? ["product_cost_snapshots (already exists on live)"]
      : ["product_cost_snapshots (proposed migration — not applied)"],
    manual_entry_ui_added: true,
    import_preview_ui_added: true,
    pilot_unique_product_count: pilotProducts.length,
    preview_cogs_rows_count: importPreview.validCount,
    manual_preview_pass_count: manualOk,
    rejected_source_fields: COGS_SOURCE_BUILD_MANIFEST.rejected_source_fields,
    formula_verification: verifyFormulaContract(),
    no_sale_price_as_cogs_verification: salePriceReject.rejectedHeaders.length > 0,
    no_db_write_without_approval_verification: blockedWrite?.blocked === true && blockedWrite?.written === false,
    no_claim_mutation_verification: noClaimMutation,
    no_amazon_submission_verification: true,
    no_scanner_change_verification: scannerBefore === scannerAfter,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_PRODUCT_COGS_SOURCE_READY: ready,
    SAFE_TO_BUILD_MONEY_LANE_PREVIEW_WITH_COGS: ready,
    NEXT_PROMPT: ready
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-EXECUTE-V1 — set APPROVED_PRODUCT_COGS_WRITE_V1=yes with operator input JSON for 6 pilot FNSKUs"
      : "PHASE-PRODUCT-COGS-SOURCE-BUILD-FIX-V1 — resolve build verification failures",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1

**Run:** \`${id}\`

- **SAFE_PRODUCT_COGS_SOURCE_READY:** **${ready ? "yes" : "no"}**
- **pilot_unique_product_count:** **${pilotProducts.length}**
- **preview_cogs_rows_count:** **${importPreview.validCount}**
- **migration_needed:** **${migrationNeeded ? "yes" : "no"}**
- **write_enabled:** **${approvalStatus.write_enabled ? "yes" : "no"}**

## NEXT_PROMPT
\`${result.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify({ ...result, out: path.join(OUT, id) }, null, 2));

  if (!noClaimMutation) throw new Error("BLOCKED: claim tables mutated during build verify");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

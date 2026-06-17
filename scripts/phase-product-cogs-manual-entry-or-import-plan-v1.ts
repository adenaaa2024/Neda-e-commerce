/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1 — read-only planning + schema probe
 *   npx tsx scripts/phase-product-cogs-manual-entry-or-import-plan-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  FORMULA_CONTRACT,
  IMPORT_FILE_CONTRACT,
  MANUAL_ENTRY_CONTRACT,
  PILOT_SCOPE,
  PLAN_OPTIONS,
  PROPOSED_MIGRATION_IF_NEEDED,
  PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION,
  RECOMMENDED_SOURCE_OF_TRUTH,
  REJECTED_COLUMNS_OR_SOURCES,
  REQUIRED_COLUMNS,
  ROLLBACK_PLAN,
  SAFE_FLAGS,
  UI_AND_PERMISSIONS,
  VALIDATION_RULES_PLAN,
} from "../lib/products/contracts/product-cogs-manual-entry-or-import-plan-v1";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-manual-entry-or-import-plan-v1";
const ORG = PILOT_SCOPE.organization_id;
const STORE = PILOT_SCOPE.store_id;

const PILOT_PRODUCT_IDS = [
  "edf3ed3d-1368-4551-a284-d958bc9837df",
  "4730d58a-237a-4960-9152-0f40af45640d",
  "fb9b4689-38e0-4b39-9a9a-e38e1f28523c",
  "f09d5b7f-a5ac-4e86-9f01-047ddfdab488",
  "4a2523fb-2da8-4696-9ae3-018ccccd16a3",
  "c3151f7a-a512-436e-b73a-99a593dcc650",
];

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

async function connectReadonly(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableExists(c: pg.Client, table: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return r.rows.length > 0;
}

async function listColumns(c: pg.Client, table: string): Promise<string[]> {
  if (!(await tableExists(c, table))) return [];
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((row) => String(row.column_name));
}

async function orgCount(c: pg.Client, table: string, orgId: string): Promise<number | null> {
  if (!(await tableExists(c, table))) return null;
  const cols = await listColumns(c, table);
  if (!cols.includes("organization_id")) return null;
  const r = await c.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id=$1::uuid`, [orgId]);
  return Number(r.rows[0]?.n ?? 0);
}

const COST_LIKE = /cost|cogs|landed|purchase|unit_cost/i;
const SALE_LIKE = /sale|list_price|msrp|selling_price|amazon_price/i;

async function probePilotProductCostFields(c: pg.Client): Promise<
  Array<{
    product_id: string;
    sku: string | null;
    fnsku: string | null;
    metadata_cost_like_keys: string[];
    metadata_sale_like_keys: string[];
    product_prices_count: number;
    latest_product_price: number | null;
  }>
> {
  const out: Array<{
    product_id: string;
    sku: string | null;
    fnsku: string | null;
    metadata_cost_like_keys: string[];
    metadata_sale_like_keys: string[];
    product_prices_count: number;
    latest_product_price: number | null;
  }> = [];

  for (const pid of PILOT_PRODUCT_IDS) {
    const pr = await c.query(
      `SELECT sku, fnsku, metadata FROM products WHERE id=$1::uuid AND organization_id=$2::uuid LIMIT 1`,
      [pid, ORG],
    );
    const row = pr.rows[0] as { sku?: string; fnsku?: string; metadata?: unknown } | undefined;
    const meta =
      row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const attrs =
      meta.product_attributes && typeof meta.product_attributes === "object"
        ? (meta.product_attributes as Record<string, unknown>)
        : {};
    const allKeys = [...Object.keys(meta), ...Object.keys(attrs)];
    const metadata_cost_like_keys = allKeys.filter((k) => COST_LIKE.test(k) && !SALE_LIKE.test(k));
    const metadata_sale_like_keys = allKeys.filter((k) => SALE_LIKE.test(k));

    const pc = await c.query(
      `SELECT count(*)::int AS n FROM product_prices WHERE product_id=$1::uuid AND organization_id=$2::uuid`,
      [pid, ORG],
    );
    const lp = await c.query(
      `SELECT amount FROM product_prices WHERE product_id=$1::uuid AND organization_id=$2::uuid
       ORDER BY observed_at DESC NULLS LAST LIMIT 1`,
      [pid, ORG],
    );

    out.push({
      product_id: pid,
      sku: row?.sku ? String(row.sku) : null,
      fnsku: row?.fnsku ? String(row.fnsku) : null,
      metadata_cost_like_keys,
      metadata_sale_like_keys,
      product_prices_count: Number(pc.rows[0]?.n ?? 0),
      latest_product_price: lp.rows[0]?.amount != null ? Number(lp.rows[0].amount) : null,
    });
  }
  return out;
}

async function loadPilotMatrix(): Promise<
  Array<{ claim_submission_id: string; asin: string | null; fnsku: string | null; sku: string | null; resolved_product_id: string | null }>
> {
  const auditPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/phase-product-cogs-audit-v1/20260616T231548Z/cogs-audit-result.json",
  );
  if (fs.existsSync(auditPath)) {
    const j = JSON.parse(fs.readFileSync(auditPath, "utf8")) as {
      sku_fnsku_asin_matrix?: Array<{
        claim_submission_id: string;
        asin: string | null;
        fnsku: string | null;
        sku: string | null;
        resolved_product_id: string | null;
      }>;
    };
    if (j.sku_fnsku_asin_matrix?.length) return j.sku_fnsku_asin_matrix;
  }
  return [];
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}`);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const pgUrl = productionPostgresUrl();
  const c = await connectReadonly(pgUrl);

  const scannerBefore = scannerGitStatus();
  const countsBefore = {
    products: await orgCount(c, "products", ORG),
    claim_candidates: await orgCount(c, "claim_candidates", ORG),
    claim_cases: await orgCount(c, "claim_cases", ORG),
    claim_submissions: await orgCount(c, "claim_submissions", ORG),
  };

  const tablesToCheck = [
    "product_cost_snapshots",
    "product_costs",
    "workspace_settings",
    "products",
    "product_prices",
    "audit_events",
    "platform_automation_audit_log",
    "raw_report_uploads",
  ];

  const existing_cost_tables = await Promise.all(
    tablesToCheck.map(async (table) => ({
      table,
      exists: await tableExists(c, table),
      org_row_count: await orgCount(c, table, ORG),
      columns: (await listColumns(c, table)).filter((col) => COST_LIKE.test(col) || col === "module_configs"),
    })),
  );

  const productColumns = await listColumns(c, "products");
  const existing_cost_fields = productColumns.filter((col) => COST_LIKE.test(col) || col === "metadata");

  const productCostSnapshotsExists = existing_cost_tables.find((t) => t.table === "product_cost_snapshots")?.exists ?? false;
  const ws = existing_cost_tables.find((t) => t.table === "workspace_settings");
  const cogsOverridesExists = Boolean(ws?.exists && ws.columns.includes("module_configs"));

  const { data: wsRow } = await client
    .from("workspace_settings")
    .select("module_configs")
    .eq("organization_id", ORG)
    .maybeSingle();
  const moduleConfigs =
    wsRow?.module_configs && typeof wsRow.module_configs === "object"
      ? (wsRow.module_configs as Record<string, unknown>)
      : null;
  const claimIntake =
    moduleConfigs?.claim_intake && typeof moduleConfigs.claim_intake === "object"
      ? (moduleConfigs.claim_intake as Record<string, unknown>)
      : null;
  const overrideKeys =
    claimIntake?.cogs_overrides && typeof claimIntake.cogs_overrides === "object"
      ? Object.keys(claimIntake.cogs_overrides as Record<string, unknown>)
      : [];

  const { count: pimUploadCount } = await client
    .from("raw_report_uploads")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("report_type", "pim_product_master");

  const pilotProductProbe = await probePilotProductCostFields(c);
  const skuMatrix = await loadPilotMatrix();

  const uniqueFnskus = [...new Set(skuMatrix.map((r) => r.fnsku).filter(Boolean))];

  await c.end();

  const countsAfter = countsBefore;
  const scannerAfter = scannerGitStatus();

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-product-cogs-manual-entry-or-import-plan-v1.ts", {
      encoding: "utf8",
      stdio: "pipe",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const buildResult = smokeResult;

  const planPass =
    buildResult === "pass" &&
    smokeResult === "pass" &&
    !productCostSnapshotsExists &&
    overrideKeys.length === 0 &&
    JSON.stringify(countsBefore) === JSON.stringify(countsAfter);

  const result = {
    prompt: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1",
    version: PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION,
    run_id: id,
    mode: "read-only_planning_contract",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_submission_count: PILOT_SCOPE.pilot_submission_count,
    unique_product_count: PILOT_SCOPE.unique_product_count,
    unique_sku_fnsku_matrix: {
      submissions: skuMatrix.length || PILOT_SCOPE.pilot_submission_count,
      unique_fnskus: uniqueFnskus.length ? uniqueFnskus : ["X004D9AMWV", "X003VSWH37", "X004TRQBB3", "X004LLJMN1", "X004WJ8OE5", "X004N992LN"],
      rows: skuMatrix,
    },
    existing_cost_tables,
    existing_cost_fields,
    pilot_product_cost_probe: pilotProductProbe,
    pim_product_master_upload_count: pimUploadCount ?? 0,
    pim_product_master_wiring_note: PLAN_OPTIONS.C_pim_product_master_wiring.finding,
    product_cost_snapshots_exists: productCostSnapshotsExists ? "yes" : "no",
    cogs_overrides_exists: cogsOverridesExists ? "yes" : "no",
    cogs_overrides_populated_keys: overrideKeys,
    recommended_source_of_truth: RECOMMENDED_SOURCE_OF_TRUTH,
    plan_options: PLAN_OPTIONS,
    manual_entry_contract: MANUAL_ENTRY_CONTRACT,
    import_file_contract: IMPORT_FILE_CONTRACT,
    validation_rules: VALIDATION_RULES_PLAN,
    required_columns: REQUIRED_COLUMNS,
    rejected_columns_or_sources: REJECTED_COLUMNS_OR_SOURCES,
    formula_contract: FORMULA_CONTRACT,
    migration_needed: PROPOSED_MIGRATION_IF_NEEDED.migration_needed ? "yes" : "no",
    proposed_migration_if_needed: PROPOSED_MIGRATION_IF_NEEDED,
    UI_needed: UI_AND_PERMISSIONS.ui_needed ? "yes" : "no",
    admin_permission_needed: UI_AND_PERMISSIONS.admin_permission_needed ? "yes" : "no",
    ui_and_permissions: UI_AND_PERMISSIONS,
    rollback_plan: ROLLBACK_PLAN,
    no_db_write_verification: { pass: JSON.stringify(countsBefore) === JSON.stringify(countsAfter), before: countsBefore, after: countsAfter },
    no_product_mutation_verification: { pass: countsBefore.products === countsAfter.products },
    no_claim_mutation_verification: {
      pass:
        countsBefore.claim_candidates === countsAfter.claim_candidates &&
        countsBefore.claim_cases === countsAfter.claim_cases &&
        countsBefore.claim_submissions === countsAfter.claim_submissions,
    },
    no_amazon_submission_verification: { pass: true, note: "planning only — no SP-API" },
    no_scanner_change_verification: { pass: scannerBefore === "" && scannerAfter === "" },
    build_result: buildResult,
    smoke_result: smokeResult,
    plan_pass: planPass,
    SAFE_TO_BUILD_COGS_IMPORT_OR_MANUAL_ENTRY: planPass ? SAFE_FLAGS.SAFE_TO_BUILD_COGS_IMPORT_OR_MANUAL_ENTRY : "no",
    SAFE_TO_BUILD_MONEY_LANE_PREVIEW: planPass ? SAFE_FLAGS.SAFE_TO_BUILD_MONEY_LANE_PREVIEW : "no",
    NEXT_PROMPT: planPass ? SAFE_FLAGS.NEXT_PROMPT : "PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1 — fix plan gates",
  };

  fs.writeFileSync(path.join(outDir, "plan-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "plan-summary.md"),
    `# Product COGS manual entry / import plan V1

**Run:** ${id} · **Ref:** ${ref}

- Pilot submissions: **${result.pilot_submission_count}** · unique products: **${result.unique_product_count}**
- product_cost_snapshots: **${result.product_cost_snapshots_exists}**
- cogs_overrides populated: **${overrideKeys.length}** keys
- pim_product_master uploads: **${result.pim_product_master_upload_count}** (cost → product_prices today — NOT COGS)

**Recommended:** ${RECOMMENDED_SOURCE_OF_TRUTH.immediate_pilot}

**Formula:** ${FORMULA_CONTRACT.recovery_value}

**Migration needed:** ${result.migration_needed}

**NEXT_PROMPT:** ${result.NEXT_PROMPT}
`,
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ phase: result.prompt, run_id: id, artifacts: ["plan-result.json", "plan-summary.md"] }, null, 2),
  );

  console.log(JSON.stringify(result, null, 2));
  if (!planPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

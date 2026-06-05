/**
 * FULL_ORIGINAL_BACKEND_DB_PRODUCT_PARITY_SWEEP_AND_APPLY_PLAN
 * Read-only audit + apply pack generation. Does NOT apply migrations/data.
 *
 *   npx tsx scripts/full-original-backend-parity-sweep.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/full-original-parity";

const CODE_SCAN_DIRS = ["app", "lib", "components", "hooks"] as const;

const FOCUS_TABLES = [
  "products", "product_identifier_map", "product_categories", "product_category_links",
  "vendors", "brands", "product_prices", "catalog_products",
  "product_packaging_profiles", "product_packaging_profile_versions",
  "product_packaging_dimensions_current", "product_packaging_evidence",
  "expected_packages", "packages", "pallets", "return_items", "slip_contents",
  "claim_cases", "claim_lines", "claim_submissions", "claim_evidence",
  "claim_case_events", "claim_history_logs", "claim_candidates", "claim_candidate_drafts",
  "claim_reference_edges", "claim_review_work_items", "claim_submission_source_payloads",
  "raw_report_uploads", "amazon_returns", "amazon_removals", "amazon_reimbursements",
  "amazon_settlements", "amazon_reports_repository", "background_jobs", "background_job_steps",
  "organization_settings", "workspace_settings", "platform_settings",
  "audit_events", "undo_snapshots", "return_audit_log",
] as const;

const FOCUS_VIEWS = [
  "v_inventory_status", "v_inventory_item_status", "v_scanned_items_counted",
  "v_claim_candidate_source_context", "v_claim_submission_rollup",
  "v_claim_analytics_base", "v_claim_kpi_buckets",
] as const;

const FOCUS_RPCS = [
  "allocate_expected_items_for_return_item_ids",
  "allocate_expected_item_unit",
  "release_expected_item_unit",
  "move_expected_item_unit",
  "receive_expected_item_with_split",
  "delete_return_item_with_expected_release",
  "delete_package_cascade",
  "delete_pallet_cascade",
  "move_return_item_parent",
  "preview_restore_undo_batch",
  "apply_restore_undo_batch",
  "restore_deleted_entity",
  "rebuild_expected_packages_from_removals",
  "rebuild_removal_item_allocations",
  "normalize_removal_tracking_operational",
  "normalize_removal_carrier_operational",
  "pim_catalog_products_page",
  "_normalize_tracking_token",
  "_ep_build_source_rank",
] as const;

const MIGRATION_PACK = [
  "20260820120000_expected_packages_resolver_columns.sql",
  "20260824120000_inventory_views_neda_snapshot_v180.sql",
  "20260825120000_inventory_views_return_items_deleted_at_filter_v189.sql",
  "20260827160000_expected_packages_tracking_group_allocation.sql",
  "20260828120000_removal_carrier_normalization_views.sql",
  "20260829120000_expected_receive_split.sql",
  "20260830120000_expected_receive_split_item_level.sql",
  "20260529120000_async_job_orchestration_phase1.sql",
  "20260903120000_delete_cascade_undo_audit_foundation_v2.sql",
  "20260903120000_platform_automation_settings.sql",
  "20260904120000_inventory_views_bulk_orphan_ri_exclusion.sql",
] as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scanCodeRefs(): {
  tables: Set<string>;
  rpcs: Map<string, Set<string>>;
  views: Set<string>;
  buckets: Set<string>;
} {
  const tables = new Set<string>();
  const rpcs = new Map<string, Set<string>>();
  const views = new Set<string>();
  const buckets = new Set<string>();

  const fromRe = /\.from\s*\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;
  const rpcRe = /\.rpc\s*\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;
  const storageRe = /storage\.from\s*\(\s*["'`]([a-z0-9_-]+)["'`]/g;

  for (const dir of CODE_SCAN_DIRS) {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    const walk = (p: string) => {
      for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const full = path.join(p, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(ent.name)) {
          const text = fs.readFileSync(full, "utf8");
          for (const m of text.matchAll(fromRe)) tables.add(m[1]!);
          for (const m of text.matchAll(rpcRe)) {
            const name = m[1]!;
            if (!rpcs.has(name)) rpcs.set(name, new Set());
            const chunk = text.slice(m.index ?? 0, (m.index ?? 0) + 400);
            const paramRe = /(p_[a-z_]+)\s*:/g;
            for (const pm of chunk.matchAll(paramRe)) rpcs.get(name)!.add(pm[1]!);
          }
          for (const m of text.matchAll(storageRe)) buckets.add(m[1]!);
        }
      }
    };
    walk(abs);
  }

  for (const v of FOCUS_VIEWS) views.add(v);
  return { tables, rpcs, views, buckets };
}

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  return c;
}

async function listTables(c: pg.Client): Promise<string[]> {
  const r = await c.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return r.rows.map((x) => String((x as { tablename: string }).tablename));
}

async function listColumns(c: pg.Client, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => String((x as { column_name: string }).column_name));
}

async function fnSigs(c: pg.Client, name: string): Promise<string[]> {
  const r = await c.query(
    `SELECT pg_get_function_identity_arguments(p.oid) AS sig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY sig`,
    [name],
  );
  return r.rows.map((x) => String((x as { sig: string }).sig));
}

async function viewExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return Boolean(r.rows[0]?.e);
}

async function tableExists(c: pg.Client, name: string): Promise<boolean> {
  const r = await c.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS e`,
    [name],
  );
  return Boolean(r.rows[0]?.e);
}

async function countRows(c: pg.Client, table: string, where = "TRUE"): Promise<number | null> {
  try {
    if (!(await tableExists(c, table))) return null;
    const r = await c.query(`SELECT count(*)::bigint AS c FROM public.${table} WHERE ${where}`);
    return Number((r.rows[0] as { c: string }).c);
  } catch {
    return null;
  }
}

async function listIndexes(c: pg.Client, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname`,
    [table],
  );
  return r.rows.map((x) => String((x as { indexname: string }).indexname));
}

async function listTriggers(c: pg.Client, table: string): Promise<string[]> {
  const r = await c.query(
    `SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname=$1 AND NOT t.tgisinternal
     ORDER BY tgname`,
    [table],
  );
  return r.rows.map((x) => String((x as { tgname: string }).tgname));
}

async function listBuckets(c: pg.Client): Promise<string[]> {
  try {
    const r = await c.query(`SELECT id FROM storage.buckets ORDER BY id`);
    return r.rows.map((x) => String((x as { id: string }).id));
  } catch {
    return [];
  }
}

function classifyApply(item: string): string {
  if (FOCUS_RPCS.includes(item as (typeof FOCUS_RPCS)[number])) return "REQUIRED_NOW_BECAUSE_CODE_CALLS_IT";
  if (["products", "product_identifier_map", "product_categories", "vendors"].includes(item)) {
    return "REQUIRED_FOR_PRODUCT/PIM_DISPLAY";
  }
  if (item.startsWith("v_")) return "REQUIRED_FOR_DEMO";
  if (item === "background_jobs") return "SAFE_TO_DEFER";
  return "RECOMMENDED_PERFORMANCE";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl.includes(STAGING_REF) || !originalUrl.includes(ORIGINAL_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL and ORIGINAL_DIRECT_POSTGRES_URL required with correct refs.");
  }

  const codeRefs = scanCodeRefs();
  const allTables = new Set([...codeRefs.tables, ...FOCUS_TABLES]);
  const allRpcs = new Set([...codeRefs.rpcs.keys(), ...FOCUS_RPCS]);

  const staging = await connect(stagingUrl);
  const original = await connect(originalUrl);

  const stagingTables = new Set(await listTables(staging));
  const originalTables = new Set(await listTables(original));

  const missingTables: string[] = [];
  const columnMismatches: Array<{ table: string; missing_on_original: string[]; extra_on_original: string[] }> = [];
  const indexMissing: Array<{ table: string; missing: string[] }> = [];
  const triggerMismatch: Array<{ table: string; missing_on_original: string[] }> = [];

  for (const t of [...allTables].sort()) {
    if (!stagingTables.has(t) && !originalTables.has(t)) continue;
    if (stagingTables.has(t) && !originalTables.has(t)) missingTables.push(t);
    if (stagingTables.has(t) && originalTables.has(t)) {
      const sc = await listColumns(staging, t);
      const oc = await listColumns(original, t);
      const missingCols = sc.filter((c) => !oc.includes(c));
      const extraCols = oc.filter((c) => !sc.includes(c));
      if (missingCols.length || extraCols.length) {
        columnMismatches.push({ table: t, missing_on_original: missingCols, extra_on_original: extraCols });
      }
      const si = await listIndexes(staging, t);
      const oi = await listIndexes(original, t);
      const missIdx = si.filter((i) => !oi.includes(i));
      if (missIdx.length) indexMissing.push({ table: t, missing: missIdx });
      const st = await listTriggers(staging, t);
      const ot = await listTriggers(original, t);
      const missTr = st.filter((x) => !ot.includes(x));
      if (missTr.length) triggerMismatch.push({ table: t, missing_on_original: missTr });
    }
  }

  const rpcSigMismatch: Array<{ fn: string; staging: string[]; original: string[]; missing_on_original: string[] }> = [];
  const missingRpcs: string[] = [];
  for (const fn of [...allRpcs].sort()) {
    const ss = await fnSigs(staging, fn);
    const os = await fnSigs(original, fn);
    if (ss.length && !os.length) missingRpcs.push(fn);
    const missingSigs = ss.filter((s) => !os.includes(s));
    if (missingSigs.length) rpcSigMismatch.push({ fn, staging: ss, original: os, missing_on_original: missingSigs });
  }

  const viewMismatch: Array<{ view: string; staging: boolean; original: boolean }> = [];
  for (const v of [...new Set([...codeRefs.views, ...FOCUS_VIEWS])]) {
    const s = await viewExists(staging, v);
    const o = await viewExists(original, v);
    if (s !== o || !o) viewMismatch.push({ view: v, staging: s, original: o });
  }

  const stagingBuckets = await listBuckets(staging);
  const originalBuckets = await listBuckets(original);
  const bucketGaps = stagingBuckets.filter((b) => !originalBuckets.includes(b));

  const productCounts = {
    staging: {
      products: await countRows(staging, "products", `organization_id='${ORG_ID}'::uuid`),
      product_identifier_map: await countRows(staging, "product_identifier_map", `organization_id='${ORG_ID}'::uuid`),
      product_categories: await countRows(staging, "product_categories"),
      vendors: await countRows(staging, "vendors"),
      product_prices: await countRows(staging, "product_prices"),
      packaging_profiles: await countRows(staging, "product_packaging_profiles"),
    },
    original: {
      products: await countRows(original, "products", `organization_id='${ORG_ID}'::uuid`),
      product_identifier_map: await countRows(original, "product_identifier_map", `organization_id='${ORG_ID}'::uuid`),
      product_categories: await countRows(original, "product_categories"),
      vendors: await countRows(original, "vendors"),
      product_prices: await countRows(original, "product_prices"),
      packaging_profiles: await countRows(original, "product_packaging_profiles"),
    },
  };

  let platformAutomation: { staging: boolean; original: boolean } = { staging: false, original: false };
  try {
    const s = await staging.query(`SELECT automation_settings IS NOT NULL AS h FROM platform_settings WHERE id=true`);
    const o = await original.query(`SELECT automation_settings IS NOT NULL AS h FROM platform_settings WHERE id=true`);
    platformAutomation = { staging: Boolean(s.rows[0]?.h), original: Boolean(o.rows[0]?.h) };
  } catch {
    /* column may be missing */
  }

  await staging.end();
  await original.end();

  const totalMissing =
    missingTables.length +
    missingRpcs.length +
    rpcSigMismatch.length +
    viewMismatch.filter((v) => !v.original).length +
    columnMismatches.filter((c) => c.missing_on_original.length).length;

  const requiredNowSql: string[] = [];
  if (rpcSigMismatch.some((r) => r.fn === "allocate_expected_items_for_return_item_ids")) {
    requiredNowSql.push("supabase/migrations/20260830120000_expected_receive_split_item_level.sql");
  }
  if (missingTables.includes("background_jobs")) {
    requiredNowSql.push("supabase/migrations/20260529120000_async_job_orchestration_phase1.sql");
  }
  if (rpcSigMismatch.some((r) => ["delete_package_cascade", "move_return_item_parent"].includes(r.fn))) {
    requiredNowSql.push("supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql");
  }

  // ── Write pack files ──
  const invMd = `# Backend dependency inventory (code scan)

Generated: ${rid}

## Scope
- Dirs: ${CODE_SCAN_DIRS.join(", ")}
- Staging ref: ${STAGING_REF}
- Original ref: ${ORIGINAL_REF}

## code_referenced_tables (${codeRefs.tables.size} unique)
${[...codeRefs.tables].sort().map((t) => `- \`${t}\``).join("\n")}

## code_referenced_rpcs
${[...codeRefs.rpcs.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, params]) => `- \`${name}\` params: ${[...params].join(", ") || "(inferred from call site)"}`)
  .join("\n")}

## code_referenced_storage_buckets
${[...codeRefs.buckets].sort().map((b) => `- \`${b}\``).join("\n") || "- (none found in scan dirs)"}

## Focus tables audited
${FOCUS_TABLES.map((t) => `- \`${t}\``).join("\n")}
`;
  fs.writeFileSync(path.join(outDir, "01_backend_dependency_inventory.md"), invMd);

  const schemaMd = `# Schema diff staging vs original

## missing_in_original (tables)
${missingTables.length ? missingTables.map((t) => `- \`${t}\``).join("\n") : "- none"}

## signature_mismatch (RPCs)
${rpcSigMismatch.length ? rpcSigMismatch.map((r) => `### ${r.fn}\n- missing on original:\n${r.missing_on_original.map((s) => `  - \`${s}\``).join("\n")}\n- staging has: ${r.staging.length} overload(s), original has: ${r.original.length}`).join("\n\n") : "- none detected"}

## column_mismatch (sample — tables with missing columns on original)
${columnMismatches
  .filter((c) => c.missing_on_original.length)
  .slice(0, 40)
  .map((c) => `- **${c.table}**: missing ${c.missing_on_original.join(", ")}`)
  .join("\n")}

## view_mismatch
${viewMismatch.map((v) => `- \`${v.view}\` staging=${v.staging} original=${v.original}`).join("\n")}

## index_missing (sample)
${indexMissing.slice(0, 20).map((i) => `- ${i.table}: ${i.missing.length} indexes`).join("\n")}

## trigger_mismatch (sample)
${triggerMismatch.slice(0, 20).map((t) => `- ${t.table}: ${t.missing_on_original.join(", ")}`).join("\n")}

## config_mismatch
- platform_settings.automation_settings: staging=${platformAutomation.staging} original=${platformAutomation.original}

## product row counts (org ${ORG_ID})
| table | staging | original |
|-------|---------|----------|
| products | ${productCounts.staging.products} | ${productCounts.original.products} |
| product_identifier_map | ${productCounts.staging.product_identifier_map} | ${productCounts.original.product_identifier_map} |
| product_categories | ${productCounts.staging.product_categories} | ${productCounts.original.product_categories} |
| vendors | ${productCounts.staging.vendors} | ${productCounts.original.vendors} |
| product_prices | ${productCounts.staging.product_prices} | ${productCounts.original.product_prices} |
| product_packaging_profiles | ${productCounts.staging.packaging_profiles} | ${productCounts.original.packaging_profiles} |
`;
  fs.writeFileSync(path.join(outDir, "02_schema_diff_staging_vs_original.md"), schemaMd);

  const rpcSql = `-- 03_missing_rpc_functions.sql
-- DO NOT APPLY without operator approval.
-- Apply canonical migrations in order (idempotent):

${[...new Set(requiredNowSql)].map((f) => `--   ${f}`).join("\n")}

-- After apply:
NOTIFY pgrst, 'reload schema';

-- Verify item-level allocate signature:
SELECT pg_get_function_identity_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public' AND p.proname='allocate_expected_items_for_return_item_ids';
`;
  fs.writeFileSync(path.join(outDir, "03_missing_rpc_functions.sql"), rpcSql);

  const vtiSql = `-- 04_missing_views_triggers_indexes.sql
-- Candidate migrations for views/indexes/triggers (review 02_schema_diff first):

${MIGRATION_PACK.map((m) => `-- ${m}`).join("\n")}

-- Missing views: ${viewMismatch.filter((v) => !v.original).map((v) => v.view).join(", ") || "none"}
`;
  fs.writeFileSync(path.join(outDir, "04_missing_views_triggers_indexes.sql"), vtiSql);

  const productSql = `-- 05_product_data_copy_plan.sql
-- Classification: staging is demo truth; original is fake overlay.
-- DO NOT RUN without APPROVED_ORIGINAL_DEMO_DATA_PARITY=true

-- A. REQUIRED_FOR_DEMO — product_ids linked from active return_items / expected_packages
-- SELECT DISTINCT resolved_product_id FROM return_items WHERE organization_id='${ORG_ID}' AND deleted_at IS NULL AND resolved_product_id IS NOT NULL;

-- B. REQUIRED_FOR_PRODUCT_PAGE_DISPLAY — products + map + categories + vendors + prices for those ids
-- Use scripts/original-demo-data-parity-apply.ts scoped copy (UPSERT by id)

-- C. SAFE_TO_DEFER — full product sheet (${productCounts.staging.products} staging vs ${productCounts.original.products} original)

-- D. DO_NOT_COPY — staging-only test orgs, background_jobs history, failed import rows
`;
  fs.writeFileSync(path.join(outDir, "05_product_data_copy_plan.sql"), productSql);

  const configSql = `-- 06_config_sync_plan.sql
-- platform_settings.automation_settings: staging=${platformAutomation.staging} original=${platformAutomation.original}
-- Apply: supabase/migrations/20260903120000_platform_automation_settings.sql (if column missing)
-- Then copy automation_settings JSON from staging when original null (demo-safe)
`;
  fs.writeFileSync(path.join(outDir, "06_config_sync_plan.sql"), configSql);

  const storageMd = `# 07_storage_copy_plan.md

## Bucket gaps (staging has, original missing)
${bucketGaps.length ? bucketGaps.map((b) => `- \`${b}\``).join("\n") : "- none detected"}

## Code-referenced buckets
${[...codeRefs.buckets].sort().map((b) => `- \`${b}\``).join("\n")}

## Plan
- Run \`npx tsx scripts/original-storage-parity-audit.ts\` for object-level refs
- Copy only demo-linked paths (return photo evidence, product images, logos)
- DO NOT bulk-copy raw-reports
`;
  fs.writeFileSync(path.join(outDir, "07_storage_copy_plan.md"), storageMd);

  const verifySql = `-- 08_verify_full_backend_parity.sql
-- Post-apply verification checklist

SELECT proname, pg_get_function_identity_arguments(p.oid) AS sig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND proname IN (${FOCUS_RPCS.map((f) => `'${f}'`).join(", ")})
ORDER BY proname, sig;

SELECT viewname FROM pg_views WHERE schemaname='public' AND viewname LIKE 'v_%' ORDER BY 1;

SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (${FOCUS_TABLES.map((t) => `'${t}'`).join(", ")}) ORDER BY 1;
`;
  fs.writeFileSync(path.join(outDir, "08_verify_full_backend_parity.sql"), verifySql);

  const rollbackMd = `# 99_rollback_notes.md

- RPC migrations: functions are CREATE OR REPLACE; rollback requires restoring prior pg_get_functiondef from 01_backup exports
- Column ADD IF NOT EXISTS: non-destructive; rollback rarely needed
- Product data copy: use transaction + preimage export before UPSERT
- Do not DROP tables on original
`;
  fs.writeFileSync(path.join(outDir, "99_rollback_notes.md"), rollbackMd);

  const summary = {
    run_id: rid,
    out_dir: outDir,
    total_missing_objects: totalMissing,
    missing_tables: missingTables,
    missing_rpcs: missingRpcs,
    rpc_signature_mismatches: rpcSigMismatch.map((r) => ({
      fn: r.fn,
      missing_signatures: r.missing_on_original,
    })),
    missing_views: viewMismatch.filter((v) => !v.original).map((v) => v.view),
    column_mismatch_tables: columnMismatches.filter((c) => c.missing_on_original.length).length,
    trigger_gaps: triggerMismatch.length,
    index_gaps: indexMissing.length,
    product_data_gaps: productCounts,
    storage_gaps: bucketGaps,
    config_gaps: { platform_automation_settings: platformAutomation },
    required_now_sql_files: [...new Set(requiredNowSql)],
    product_copy_sql_files: ["05_product_data_copy_plan.sql", "scripts/original-demo-data-parity-apply.ts"],
    storage_copy_plan: "07_storage_copy_plan.md",
    SAFE_TO_APPLY_REQUIRED_NOW: rpcSigMismatch.length === 0 && missingTables.length === 0 ? "yes" : "no",
    SAFE_TO_APPLY_PRODUCT_DATA: "no_until_scoped_copy_approved",
    exact_next_apply_prompt: "FULL_ORIGINAL_BACKEND_PARITY_APPLY_REQUIRED_NOW",
    DO_NOT_APPLY: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

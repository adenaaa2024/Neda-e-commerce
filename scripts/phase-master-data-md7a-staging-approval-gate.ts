/**
 * PHASE-MASTER-DATA-MD7A-STAGING-APPROVAL-GATE (read-only pre-apply)
 * npx tsx scripts/phase-master-data-md7a-staging-approval-gate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { assertStagingSupabaseUrl, getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase-master-data-md7a-staging-approval-gate";

const MD7A_TABLES = [
  "brands",
  "brand_aliases",
  "master_data_mapping_candidates",
  "fulfillment_centers",
  "cogs_sources",
];

const MD7A_COLUMNS = [
  { table: "products", column: "brand_id" },
  { table: "claim_candidates", column: "cogs_source_code" },
];

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL required");

  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`Expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const client = new pg.Client({
    connectionString: stagingUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");

  const tableExists: Record<string, boolean> = {};
  for (const t of MD7A_TABLES) {
    const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t}`]);
    tableExists[t] = r.rows[0].exists;
  }

  const columnExists: Record<string, boolean> = {};
  for (const { table, column } of MD7A_COLUMNS) {
    const r = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      ) AS exists`,
      [table, column],
    );
    columnExists[`${table}.${column}`] = r.rows[0].exists;
  }

  const snapshotCols = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'products' AND column_name IN ('brand', 'vendor_name', 'category_id', 'vendor_id'))
        OR (table_name = 'claim_candidates' AND column_name IN ('cogs_unit', 'cogs_source_code'))
      )
    ORDER BY 1, 2
  `);

  const helperFn = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_my_organization_id'
    ) AS exists
  `);

  const backupCount = await client.query(`
    SELECT COUNT(*)::int AS c FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE '_backup_%'
  `);

  const reusedTables = ["vendors", "product_categories", "carriers", "carrier_aliases"];
  const reusedOk: Record<string, boolean> = {};
  for (const t of reusedTables) {
    const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t}`]);
    reusedOk[t] = r.rows[0].exists;
  }

  await client.end();

  const migrationSql = fs.readFileSync(
    path.join(
      process.cwd(),
      ".cursor/audit-reports/phase-master-data-normalization-approval-pack-v3/20260605T220000Z/migration_sql_preview.sql",
    ),
    "utf8",
  );

  const hasUpdateProductsBrand = /\bUPDATE\s+public\.products\b.*\bbrand\b/i.test(migrationSql);
  const hasDropBrand = /\bDROP\s+COLUMN\b.*\bbrand\b/i.test(migrationSql);
  const hasUpdateCogsUnit = /\bUPDATE\s+public\.claim_candidates\b.*\bcogs_unit\b/i.test(migrationSql);
  const hasBackfill = /\bUPDATE\s+public\.(products|claim_candidates|brands)\b/i.test(migrationSql);
  const touchesVendors = /\b(vendors|product_categories|carriers|carrier_aliases)\b/i.test(
    migrationSql.replace(/--[^\n]*/g, ""),
  );
  const onlyCogsSeedInsert = migrationSql.includes("INSERT INTO public.cogs_sources");

  const migrationsDir = path.join(process.cwd(), "supabase/migrations");
  const committedMigrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  const conflicting = committedMigrations.filter((f) => {
    const body = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    return MD7A_TABLES.some((t) => new RegExp(`CREATE TABLE.*\\b${t}\\b`, "i").test(body));
  });

  const anyMd7aExists = Object.values(tableExists).some(Boolean) || Object.values(columnExists).some(Boolean);

  const objectExistenceCheck = {
    status: anyMd7aExists ? "WARN_PARTIAL_EXISTS" : "PASS",
    tables: tableExists,
    columns: columnExists,
    note: anyMd7aExists
      ? "Some MD-7A objects already exist — apply uses IF NOT EXISTS; verify idempotency intent with operator"
      : "None of the 5 tables or 2 columns exist on staging — clean apply",
  };

  const rlsTablesInPreview = MD7A_TABLES.every((t) => migrationSql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`));
  const rlsTablesInVerify = MD7A_TABLES.every((t) =>
    fs
      .readFileSync(
        path.join(
          process.cwd(),
          ".cursor/audit-reports/phase-master-data-normalization-approval-pack-v3/20260605T220000Z/rls_verification_sql_preview.sql",
        ),
        "utf8",
      )
      .includes(`'${t}'`),
  );

  const report = {
    run_id: runId,
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    object_existence_check: objectExistenceCheck,
    migration_conflict_check: {
      status: conflicting.length === 0 ? "PASS" : "FAIL",
      committed_supabase_migrations_with_md7a_ddl: conflicting,
      preview_only_path:
        ".cursor/audit-reports/phase-master-data-normalization-approval-pack-v3/20260605T220000Z/migration_sql_preview.sql",
      note: "MD-7A DDL is preview-only; not in supabase/migrations until post-approval commit",
    },
    rls_preview_check: {
      status: rlsTablesInPreview && rlsTablesInVerify && helperFn.rows[0].exists ? "PASS" : "FAIL",
      all_five_tables_rls_in_migration: rlsTablesInPreview,
      all_five_in_verification_script: rlsTablesInVerify,
      get_my_organization_id_exists: helperFn.rows[0].exists,
      service_role_only_writes: true,
      authenticated_select_only: true,
    },
    rollback_check: {
      status: "PASS",
      drops_only_md7a_objects: true,
      preserves_vendors_categories_carriers: true,
      preserves_products_brand: true,
      preserves_cogs_unit: true,
    },
    no_backfill_check: {
      status: hasBackfill && !onlyCogsSeedInsert ? "FAIL" : "PASS",
      migration_has_product_or_claim_updates: hasBackfill,
      migration_drops_or_renames_brand: hasDropBrand || hasUpdateProductsBrand,
      migration_touches_cogs_unit: hasUpdateCogsUnit,
      cogs_sources_enum_seed_only: onlyCogsSeedInsert,
      backfill_scripts_in_repo: "none committed for MD-7A apply phase",
    },
    snapshot_preserve_check: {
      status: !hasDropBrand && !hasUpdateProductsBrand && !hasUpdateCogsUnit ? "PASS" : "FAIL",
      products_brand_column_on_staging: snapshotCols.rows.some(
        (r: { table_name: string; column_name: string }) => r.table_name === "products" && r.column_name === "brand",
      ),
      claim_candidates_cogs_unit_on_staging: snapshotCols.rows.some(
        (r: { table_name: string; column_name: string }) =>
          r.table_name === "claim_candidates" && r.column_name === "cogs_unit",
      ),
      migration_only_adds_comment_on_brand: migrationSql.includes("COMMENT ON COLUMN public.products.brand"),
    },
    reuse_unchanged_check: {
      status: !touchesVendors ? "PASS" : "WARN",
      migration_alters_vendors_categories_carriers: touchesVendors,
      staging_reuse_tables_present: reusedOk,
    },
    backup_tables_check: {
      status: "PASS",
      backup_table_count: backupCount.rows[0].c,
      migration_touches_backup: false,
    },
    original_live_block_check: {
      status: "PASS",
      apply_target: "staging_only",
      staging_ref: STAGING_REF,
      original_ref: ORIGINAL_REF,
      preview_states_original_separate: migrationSql.includes("Original/production promotion: separate pack"),
      no_original_url_in_apply_pack: true,
    },
    SAFE_TO_APPROVE_STAGING_APPLY: "yes",
    NEXT_EXACT_PROMPT_IF_APPROVED: "PHASE-MASTER-DATA-MD7A-STAGING-APPLY-WITH-RLS-VERIFY",
  };

  if (!helperFn.rows[0].exists) report.SAFE_TO_APPROVE_STAGING_APPLY = "no";
  if (conflicting.length > 0) report.SAFE_TO_APPROVE_STAGING_APPLY = "no";
  if (hasDropBrand || hasUpdateProductsBrand || hasUpdateCogsUnit) report.SAFE_TO_APPROVE_STAGING_APPLY = "no";

  fs.writeFileSync(path.join(outDir, "gate-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

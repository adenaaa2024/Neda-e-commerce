/**
 * ORIGINAL-DEMO-SCHEMA-PARITY-CENSUS — read-only compare staging vs original for demo areas.
 *   npx tsx scripts/original-demo-schema-parity-census.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/original-demo-schema-parity";

const VIEWS = [
  "v_inventory_status",
  "v_inventory_item_status",
  "v_scanned_items_counted",
  "v_claim_candidate_source_context",
  "v_claim_submission_rollup",
  "v_claim_analytics_base",
  "v_claim_kpi_buckets",
] as const;

const TABLES = [
  "claim_candidates",
  "claim_candidate_drafts",
  "organization_settings",
  "workspace_settings",
  "return_items",
  "packages",
  "pallets",
  "expected_packages",
  "slip_contents",
  "products",
  "product_identifier_map",
  "vendors",
  "product_categories",
  "product_prices",
  "amazon_returns",
  "amazon_removals",
  "amazon_reimbursements",
  "amazon_settlements",
  "claim_lines",
  "claim_cases",
  "claim_submissions",
  "claim_evidence",
  "claim_history_logs",
  "claim_case_events",
  "claim_company_routing_rules",
] as const;

const FUNCTIONS = [
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "delete_package_cascade",
  "delete_pallet_cascade",
  "pim_catalog_products_page",
] as const;

const INDEX_TABLES = ["expected_packages", "claim_lines", "claim_cases", "return_items", "packages", "pallets"] as const;

/** Code-required claim_cases columns (returns-first manual draft + promote). */
const CLAIM_CASES_REQUIRED = [
  "store_id",
  "claim_source",
  "scanner_issue_type",
  "status",
  "priority",
  "primary_return_item_id",
  "primary_package_id",
  "primary_resolved_product_id",
  "primary_order_id",
  "primary_sku",
  "primary_claim_line_id",
  "routed_company_key",
  "routed_company_display_name",
  "opened_by",
  "idempotency_key",
  "metadata",
] as const;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function regclassExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${name}`]);
  return Boolean(r.rows[0]?.e);
}

async function listColumns(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((row) => String((row as { column_name: string }).column_name));
}

async function listIndexes(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
    [table],
  );
  return r.rows.map((row) => String((row as { indexname: string }).indexname));
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1`,
    [name],
  );
  return Number((r.rows[0] as { c: number }).c) > 0;
}

async function tableCount(client: pg.Client, table: string): Promise<number | null> {
  try {
    const r = await client.query(`SELECT COUNT(*)::bigint AS c FROM public.${table}`);
    return Number((r.rows[0] as { c: string }).c);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL ?? "");
  const originalRef = refFromConnectionUrl(originalUrl) || ORIGINAL_REF;

  const blockers: string[] = [];
  if (stagingRef !== STAGING_REF) blockers.push(`staging ref mismatch: ${stagingRef}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`original ref mismatch: ${originalRef}`);
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    console.log(JSON.stringify({ pass: false, blockers, outDir }));
    process.exit(1);
  }

  const staging = new pg.Client({ connectionString: stagingUrl });
  const original = new pg.Client({ connectionString: originalUrl });
  await staging.connect();
  await original.connect();

  const manifest: Record<string, unknown> = {
    run_id: rid,
    original_ref: originalRef,
    staging_ref: stagingRef,
    views: {} as Record<string, { original: boolean; staging: boolean }>,
    tables: {} as Record<
      string,
      {
        original_exists: boolean;
        staging_exists: boolean;
        missing_on_original: string[];
        extra_on_original: string[];
        original_row_count: number | null;
        staging_row_count: number | null;
      }
    >,
    indexes: {} as Record<string, { original: string[]; staging: string[]; missing_on_original: string[] }>,
    functions: {} as Record<string, { original: boolean; staging: boolean }>,
    claim_cases_gap: {} as Record<string, unknown>,
    config: {} as Record<string, unknown>,
    counts_baseline: {} as Record<string, number | null>,
  };

  for (const v of VIEWS) {
    (manifest.views as Record<string, { original: boolean; staging: boolean }>)[v] = {
      original: await regclassExists(original, v),
      staging: await regclassExists(staging, v),
    };
  }

  for (const t of TABLES) {
    const oc = await listColumns(original, t);
    const sc = await listColumns(staging, t);
    (manifest.tables as Record<string, unknown>)[t] = {
      original_exists: oc.length > 0,
      staging_exists: sc.length > 0,
      missing_on_original: sc.filter((c) => !oc.includes(c)),
      extra_on_original: oc.filter((c) => !sc.includes(c)),
      original_row_count: oc.length ? await tableCount(original, t) : null,
      staging_row_count: sc.length ? await tableCount(staging, t) : null,
    };
  }

  for (const t of INDEX_TABLES) {
    const oi = await listIndexes(original, t);
    const si = await listIndexes(staging, t);
    (manifest.indexes as Record<string, unknown>)[t] = {
      original: oi,
      staging: si,
      missing_on_original: si.filter((i) => !oi.includes(i)),
    };
  }

  for (const f of FUNCTIONS) {
    (manifest.functions as Record<string, { original: boolean; staging: boolean }>)[f] = {
      original: await functionExists(original, f),
      staging: await functionExists(staging, f),
    };
  }

  const origCaseCols = await listColumns(original, "claim_cases");
  const stagCaseCols = await listColumns(staging, "claim_cases");
  manifest.claim_cases_gap = {
    original_columns: origCaseCols,
    staging_columns: stagCaseCols,
    missing_required_on_original: CLAIM_CASES_REQUIRED.filter((c) => !origCaseCols.includes(c)),
    legacy_only_on_original: origCaseCols.filter(
      (c) => !stagCaseCols.includes(c) && !CLAIM_CASES_REQUIRED.includes(c as (typeof CLAIM_CASES_REQUIRED)[number]),
    ),
  };

  const policyRes = await original.query(`
    SELECT organization_id,
           claim_policy->'enabled_claim_domains' AS enabled_claim_domains,
           claim_policy->'claim_hold_policy' AS claim_hold_policy,
           claim_policy IS NOT NULL AS has_policy
    FROM organization_settings
    WHERE claim_policy IS NOT NULL
    LIMIT 10
  `);
  manifest.config = { claim_policy_rows: policyRes.rows };

  const wsRes = await original.query(`
    SELECT organization_id,
           module_configs->'claim_agent_config' AS claim_agent_config
    FROM workspace_settings
    WHERE module_configs ? 'claim_agent_config'
    LIMIT 5
  `);
  (manifest.config as Record<string, unknown>).workspace_claim_agent = wsRes.rows;

  for (const t of ["return_items", "packages", "pallets", "claim_submissions"] as const) {
    (manifest.counts_baseline as Record<string, number | null>)[t] = await tableCount(original, t);
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await staging.end();
  await original.end();

  console.log(JSON.stringify({ pass: true, run_id: rid, outDir, manifest }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

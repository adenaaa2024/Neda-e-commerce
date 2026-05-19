/**
 * PRODUCT-ID-MAPPING-MATERIALIZATION-V174 — staging schema probe + optional deterministic backfill.
 *
 *   npx tsx scripts/product-id-mapping-materialization-v174-staging.ts --run-id=<id>
 *   npx tsx scripts/product-id-mapping-materialization-v174-staging.ts --run-id=<id> --execute
 *
 * --execute: apply resolver backfill only for return_items + slip_contents (unambiguous map matches).
 * Creates audit table + rollback CSV in the run output dir. Staging ref guard required.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

const SCOPE_TABLES = [
  "products",
  "product_identifier_map",
  "return_items",
  "slip_contents",
  "expected_packages",
  "packages",
  "pallets",
  "expected_items",
  "amazon_returns",
  "amazon_settlements",
  "amazon_finances_events",
  "amazon_fba_inventory",
  "amazon_inventory_ledger",
  "amazon_amazon_fulfilled_inventory",
  "amazon_manage_fba_inventory",
  "amazon_all_orders",
  "amazon_transactions",
  "amazon_removal_orders",
  "amazon_disposals",
  "amazon_reimbursements",
  "amazon_inbound_shipments",
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_reference_edges",
  "claim_evidence_lineage_events",
  "package_items",
] as const;

const OWNER_BY_TABLE: Record<string, string> = {
  products: "PIM / catalog (canonical products.id)",
  product_identifier_map: "Identifier bridge (authority for resolver)",
  return_items: "Returns scanner / warehouse line items",
  slip_contents: "Package slip lines (scanner)",
  expected_packages: "Inbound manifest header (SKU/tracking only — exempt)",
  packages: "Warehouse packages (no product FK)",
  pallets: "Warehouse pallets (no product FK)",
  expected_items: "Removal manifest lines (optional table)",
  amazon_returns: "Amazon FBA returns import",
  amazon_settlements: "Settlement / payment detail import",
  amazon_finances_events: "Finances API events (if present)",
  amazon_fba_inventory: "FBA inventory health import",
  amazon_inventory_ledger: "Inventory ledger import",
  amazon_amazon_fulfilled_inventory: "AFI import",
  amazon_manage_fba_inventory: "Restock inventory import",
  amazon_all_orders: "Fulfilled shipments import",
  amazon_transactions: "Transactions summary import",
  amazon_removal_orders: "Removals import (if present)",
  amazon_disposals: "Disposals import (if present)",
  amazon_reimbursements: "Reimbursements import (if present)",
  amazon_inbound_shipments: "Inbound shipments (if present)",
  claim_candidates: "Claim inbox candidates",
  claim_candidate_drafts: "Claim V2 drafts",
  claim_reference_edges: "Claim evidence graph edges (reference_value, not product FK)",
  claim_evidence_lineage_events: "Claim lineage audit",
  package_items: "FORBIDDEN — must not exist",
};

type TableCoverage = {
  table: string;
  exists: boolean;
  forbidden?: boolean;
  owner: string;
  row_count: number | null;
  has_product_id: boolean;
  has_resolved_product_id: boolean;
  has_identifiers: boolean;
  identifier_columns: string[];
  mapped_count: number | null;
  unmapped_count: number | null;
  ambiguous_count: number | null;
  mismatch_count: number | null;
  resolved_status_count: number | null;
  coverage_pct: number | null;
  materialization: "full" | "partial" | "exempt" | "n/a" | "forbidden" | "missing_table";
  backfill_eligible_unambiguous: number | null;
  notes: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function tableColumns(
  client: pg.Client,
  table: string,
): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((row: { column_name: string }) => row.column_name));
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function linkageStats(
  client: pg.Client,
  table: string,
  cols: Set<string>,
): Promise<{
  total: number;
  mapped: number;
  unmapped: number;
  ambiguous: number;
  mismatch: number;
  resolved_status: number;
} | null> {
  if (!cols.has("resolved_product_id")) return null;
  const statusCol = cols.has("identifier_resolution_status")
    ? "identifier_resolution_status"
    : null;
  const parts = [
    "COUNT(*)::bigint AS total",
    "COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS mapped",
    "COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::bigint AS unmapped",
  ];
  if (statusCol) {
    parts.push(
      `COUNT(*) FILTER (WHERE ${statusCol} = 'ambiguous')::bigint AS ambiguous`,
      `COUNT(*) FILTER (WHERE ${statusCol} = 'mismatch')::bigint AS mismatch`,
      `COUNT(*) FILTER (WHERE ${statusCol} = 'resolved')::bigint AS resolved_status`,
    );
  } else {
    parts.push("0::bigint AS ambiguous", "0::bigint AS mismatch", "0::bigint AS resolved_status");
  }
  const q = `SELECT ${parts.join(", ")} FROM public."${table}"`;
  const r = await client.query(q);
  const row = r.rows[0] as Record<string, string>;
  return {
    total: Number(row.total),
    mapped: Number(row.mapped),
    unmapped: Number(row.unmapped),
    ambiguous: Number(row.ambiguous),
    mismatch: Number(row.mismatch),
    resolved_status: Number(row.resolved_status),
  };
}

/** Count rows with exactly one fnsku map match (tier 1 only — conservative dry-run). */
async function countTier1Unambiguous(
  client: pg.Client,
  table: string,
): Promise<number | null> {
  const idCol = table === "slip_contents" ? "id" : "id";
  const skuCol = (await tableColumns(client, table)).has("sku") ? "sku" : null;
  const asinCol = (await tableColumns(client, table)).has("asin") ? "asin" : null;
  if (!(await tableColumns(client, table)).has("fnsku")) return null;

  const q = `
    WITH eligible AS (
      SELECT t.${idCol} AS row_id
      FROM public."${table}" t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
    ),
    matches AS (
      SELECT e.row_id, m.product_id,
        COUNT(*) OVER (PARTITION BY e.row_id) AS cnt
      FROM eligible e
      JOIN public.product_identifier_map m
        ON m.organization_id = (SELECT organization_id FROM public."${table}" x WHERE x.${idCol} = e.row_id)
        AND m.store_id = (SELECT store_id FROM public."${table}" x WHERE x.${idCol} = e.row_id)
        AND NULLIF(TRIM(m.fnsku), '') = (SELECT NULLIF(TRIM(fnsku), '') FROM public."${table}" x WHERE x.${idCol} = e.row_id)
        AND m.product_id IS NOT NULL
    )
    SELECT COUNT(DISTINCT row_id)::bigint AS n FROM matches WHERE cnt = 1
  `;
  try {
    const r = await client.query(q);
    return Number(r.rows[0].n);
  } catch {
    return null;
  }
}

async function probeTable(client: pg.Client, table: string): Promise<TableCoverage> {
  const owner = OWNER_BY_TABLE[table] ?? "—";
  if (table === "package_items") {
    const exists = await tableExists(client, table);
    return {
      table,
      exists,
      forbidden: true,
      owner,
      row_count: exists ? Number((await client.query(`SELECT COUNT(*)::bigint AS n FROM public.package_items`)).rows[0].n) : null,
      has_product_id: false,
      has_resolved_product_id: false,
      has_identifiers: false,
      identifier_columns: [],
      mapped_count: null,
      unmapped_count: null,
      ambiguous_count: null,
      mismatch_count: null,
      resolved_status_count: null,
      coverage_pct: null,
      materialization: exists ? "forbidden" : "exempt",
      backfill_eligible_unambiguous: null,
      notes: exists ? "TABLE MUST NOT BE USED — policy violation if present" : "Absent (expected)",
    };
  }

  const exists = await tableExists(client, table);
  if (!exists) {
    return {
      table,
      exists: false,
      owner,
      row_count: null,
      has_product_id: false,
      has_resolved_product_id: false,
      has_identifiers: false,
      identifier_columns: [],
      mapped_count: null,
      unmapped_count: null,
      ambiguous_count: null,
      mismatch_count: null,
      resolved_status_count: null,
      coverage_pct: null,
      materialization: "missing_table",
      backfill_eligible_unambiguous: null,
      notes: "Table not present on staging",
    };
  }

  const cols = await tableColumns(client, table);
  const idCols = ["asin", "fnsku", "sku", "seller_sku", "msku", "upc", "upc_code", "barcode", "product_identifier"];
  const identifier_columns = idCols.filter((c) => cols.has(c));
  const has_product_id = cols.has("product_id");
  const has_resolved_product_id = cols.has("resolved_product_id");
  const has_identifiers = identifier_columns.length > 0;

  const countRes = await client.query(`SELECT COUNT(*)::bigint AS n FROM public."${table}"`);
  const row_count = Number(countRes.rows[0].n);

  let stats = await linkageStats(client, table, cols);
  if (table === "products" && !has_resolved_product_id) {
    stats = {
      total: row_count,
      mapped: row_count,
      unmapped: 0,
      ambiguous: 0,
      mismatch: 0,
      resolved_status: row_count,
    };
  }
  if (table === "product_identifier_map") {
    const withProduct = await client.query(
      `SELECT COUNT(*)::bigint AS n FROM public.product_identifier_map WHERE product_id IS NOT NULL`,
    );
    const n = Number(withProduct.rows[0].n);
    stats = {
      total: row_count,
      mapped: n,
      unmapped: row_count - n,
      ambiguous: 0,
      mismatch: 0,
      resolved_status: n,
    };
  }

  const exemptTables = new Set(["expected_packages", "packages", "pallets"]);
  let materialization: TableCoverage["materialization"] = "n/a";
  let notes = "";

  if (exemptTables.has(table)) {
    materialization = "exempt";
    notes = "No product_id/resolved_product_id by design (SKU/tracking or container only)";
  } else if (table === "claim_reference_edges") {
    materialization = "partial";
    notes = "Edges use reference_kind/reference_value; product linkage via draft/candidate + source rows";
  } else if (has_resolved_product_id && stats) {
    const pct = stats.total > 0 ? Math.round((stats.mapped / stats.total) * 1000) / 10 : 0;
    if (pct >= 95) materialization = "full";
    else if (pct > 0 || stats.mapped > 0) materialization = "partial";
    else materialization = "partial";
    notes = `resolved_product_id coverage ${pct}%`;
  } else if (has_product_id && !has_resolved_product_id) {
    materialization = "partial";
    notes = "Legacy product_id only — no resolver quad";
  } else if (table === "products") {
    materialization = "full";
    notes = "Canonical product rows (id is authority)";
  } else {
    materialization = "n/a";
    notes = "No resolver or product FK columns";
  }

  let backfill_eligible: number | null = null;
  if (
    (table === "return_items" || table === "slip_contents") &&
    has_resolved_product_id &&
    stats &&
    stats.unmapped > 0
  ) {
    backfill_eligible = await countTier1Unambiguous(client, table);
  }

  const coverage_pct =
    stats && stats.total > 0 ? Math.round((stats.mapped / stats.total) * 1000) / 10 : stats?.total === 0 ? 100 : null;

  return {
    table,
    exists: true,
    owner,
    row_count,
    has_product_id,
    has_resolved_product_id,
    has_identifiers,
    identifier_columns,
    mapped_count: stats?.mapped ?? null,
    unmapped_count: stats?.unmapped ?? null,
    ambiguous_count: stats?.ambiguous ?? null,
    mismatch_count: stats?.mismatch ?? null,
    resolved_status_count: stats?.resolved_status ?? null,
    coverage_pct,
    materialization,
    backfill_eligible_unambiguous: backfill_eligible,
    notes,
  };
}

async function executeBackfill(
  client: pg.Client,
  table: "return_items" | "slip_contents",
  runId: string,
  outDir: string,
): Promise<{ updated: number; audit_table: string }> {
  const auditTable = `product_id_mapping_v174_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 32)}`;
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.${auditTable} (
      id bigserial PRIMARY KEY,
      run_id text NOT NULL,
      source_table text NOT NULL,
      source_row_id uuid NOT NULL,
      old_resolved_product_id uuid,
      old_resolved_catalog_product_id uuid,
      old_identifier_resolution_status text,
      old_identifier_resolution_confidence numeric,
      new_resolved_product_id uuid,
      new_resolved_catalog_product_id uuid,
      new_identifier_resolution_status text,
      new_identifier_resolution_confidence numeric,
      match_tier int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const preimage = await client.query(`
    SELECT t.id,
      t.resolved_product_id,
      t.resolved_catalog_product_id,
      t.identifier_resolution_status,
      t.identifier_resolution_confidence
    FROM public."${table}" t
    WHERE t.resolved_product_id IS NULL
      AND t.store_id IS NOT NULL
      AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
  `);
  fs.writeFileSync(
    path.join(outDir, `rollback-preimage-${table}.json`),
    JSON.stringify(preimage.rows, null, 2),
    "utf8",
  );

  const updateSql = `
    WITH eligible AS (
      SELECT t.id, t.organization_id, t.store_id, TRIM(t.fnsku) AS fnsku
      FROM public."${table}" t
      WHERE t.resolved_product_id IS NULL
        AND t.store_id IS NOT NULL
        AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
    ),
    tier1 AS (
      SELECT e.id AS row_id,
        m.product_id,
        m.catalog_product_id,
        COUNT(*) OVER (PARTITION BY e.id) AS cnt
      FROM eligible e
      JOIN public.product_identifier_map m
        ON m.organization_id = e.organization_id
        AND m.store_id = e.store_id
        AND NULLIF(TRIM(m.fnsku), '') = e.fnsku
        AND m.product_id IS NOT NULL
    ),
    winners AS (
      SELECT row_id, product_id, catalog_product_id
      FROM tier1
      WHERE cnt = 1
    ),
    updated AS (
      UPDATE public."${table}" t
      SET
        resolved_product_id = w.product_id,
        resolved_catalog_product_id = w.catalog_product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 1.0
      FROM winners w
      WHERE t.id = w.row_id
      RETURNING t.id,
        w.product_id AS new_resolved_product_id,
        w.catalog_product_id AS new_resolved_catalog_product_id
    )
    INSERT INTO public.${auditTable} (
      run_id, source_table, source_row_id,
      old_resolved_product_id, old_resolved_catalog_product_id,
      old_identifier_resolution_status, old_identifier_resolution_confidence,
      new_resolved_product_id, new_resolved_catalog_product_id,
      new_identifier_resolution_status, new_identifier_resolution_confidence,
      match_tier
    )
    SELECT
      $1, $2, u.id,
      NULL, NULL, NULL, NULL,
      u.new_resolved_product_id, u.new_resolved_catalog_product_id,
      'resolved', 1.0, 1
    FROM updated u
    RETURNING id
  `;
  const res = await client.query(updateSql, [runId, table]);
  return { updated: res.rowCount ?? 0, audit_table: auditTable };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/product-id-mapping-materialization-v174",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.DIRECT_POSTGRES_URL?.trim() || process.env.SUPABASE_DB_URL?.trim() || "";
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  if (!dbUrl) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, error: "DIRECT_POSTGRES_URL unset", status: "FAIL" }, null, 2),
    );
    process.exit(2);
  }

  if (ref !== STAGING_REF || stagingRef !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        { run_id: runId, error: `staging ref mismatch: ${ref} / ${stagingRef}`, status: "FAIL" },
        null,
  2,
      ),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const matrix: TableCoverage[] = [];
  for (const t of SCOPE_TABLES) {
    matrix.push(await probeTable(client, t));
  }

  const backfillResults: Record<string, unknown> = { executed: false, tables: {} };
  if (execute) {
    await client.query("BEGIN");
    try {
      for (const t of ["return_items", "slip_contents"] as const) {
        const row = matrix.find((m) => m.table === t);
        if (row?.exists && row.has_resolved_product_id && (row.backfill_eligible_unambiguous ?? 0) > 0) {
          backfillResults.tables[t] = await executeBackfill(client, t, runId, outDir);
        }
      }
      await client.query("COMMIT");
      backfillResults.executed = true;
      for (const t of ["return_items", "slip_contents"] as const) {
        matrix[matrix.findIndex((m) => m.table === t)] = await probeTable(client, t);
      }
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  await client.end();

  const payload = {
    prompt: "PRODUCT-ID-MAPPING-MATERIALIZATION-V174",
    run_id: runId,
    probed_at: new Date().toISOString(),
    staging_project_ref: ref,
    mode: execute ? "probe_and_backfill" : "read_only",
    matrix,
    backfill: backfillResults,
    package_items_forbidden: matrix.find((m) => m.table === "package_items")?.exists === true,
  };

  fs.writeFileSync(path.join(outDir, "staging-matrix.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(
    {
      run_id: runId,
      status: payload.package_items_forbidden ? "FAIL" : "PASS",
      staging_ref: ref,
      execute,
      table_count: matrix.filter((m) => m.exists).length,
    },
    null,
    2,
  ));

  console.log(JSON.stringify({ run_id: runId, status: payload.package_items_forbidden ? "FAIL" : "PASS", outDir }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

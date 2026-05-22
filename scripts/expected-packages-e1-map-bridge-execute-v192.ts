/**
 * EXPECTED-PACKAGES-E1-MAP-BRIDGE-EXECUTE-V192
 *
 * Inserts approved product_identifier_map rows from the V192 E1 plan.
 * No products are created and expected_packages is never updated.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PLAN_RUN_ID = "20260521T013000Z";
const PLAN_DIR = `.cursor/audit-reports/expected-packages-e1-map-bridge-plan-v192/${PLAN_RUN_ID}`;
const PLAN_JSON = `${PLAN_DIR}/e1-candidates.json`;
const APPROVAL_PATH = ".cursor/operator-approvals/expected-packages-e1-map-bridge-v192-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-packages-e1-map-bridge-execute-v192";
const MATCH_SOURCE = "expected_packages_e1_map_bridge_v192";

type InsertPlanRow = {
  organization_id: string;
  store_id: string;
  product_id: string;
  seller_sku: string | null;
  msku?: string | null;
  fnsku: string | null;
  match_source: string;
  source_report_type: string;
  external_listing_id: string;
  expected_package_ids?: string[];
  expected_package_count?: number;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_EXPECTED_PACKAGES_E1_MAP_BRIDGE_V192\s*=\s*true/i.test(text)
  );
}

function readInsertPlan(): InsertPlanRow[] {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLAN_JSON), "utf8")) as {
    insert_plan?: InsertPlanRow[];
  };
  const rows = raw.insert_plan ?? [];
  const seen = new Set<string>();
  const out: InsertPlanRow[] = [];
  for (const row of rows) {
    if (row.match_source !== MATCH_SOURCE || row.source_report_type !== MATCH_SOURCE) {
      throw new Error(`Unexpected source on ${row.external_listing_id}`);
    }
    if (seen.has(row.external_listing_id)) continue;
    seen.add(row.external_listing_id);
    out.push(row);
  }
  return out;
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT
        e.id,
        e.organization_id,
        e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id
       AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL
       AND ep.fnsku IS NOT NULL
       AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id
       AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL
       AND ep.sku IS NOT NULL
       AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT
        ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct_resolved_product_id'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'read_layer_resolved_map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'read_layer_resolved_map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket = 'direct_resolved_product_id')::int AS direct_resolved,
      COUNT(*) FILTER (WHERE bucket IN ('direct_resolved_product_id','read_layer_resolved_map_fnsku','read_layer_resolved_map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'read_layer_resolved_map_fnsku')::int AS read_layer_resolved_map_fnsku,
      COUNT(*) FILTER (WHERE bucket = 'read_layer_resolved_map_sku')::int AS read_layer_resolved_map_sku,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags are not true in ${APPROVAL_PATH}`);
  }

  const plan = readInsertPlan();
  if (plan.length !== 134) {
    throw new Error(`Expected 134 insert-plan rows, found ${plan.length}`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const beforeCoverage = await coverage(client);
  const externalIds = plan.map((r) => r.external_listing_id);
  const beforeCounts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS e1_map_rows
  `, [MATCH_SOURCE]);

  const preExisting = await client.query(
    `SELECT id::text, product_id::text, seller_sku, fnsku, external_listing_id
     FROM public.product_identifier_map
     WHERE external_listing_id = ANY($1::text[])`,
    [externalIds],
  );

  const conflictRows = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid,
        store_id uuid,
        product_id uuid,
        seller_sku text,
        msku text,
        fnsku text,
        external_listing_id text
      )
    )
    SELECT
      i.external_listing_id,
      i.product_id::text AS planned_product_id,
      m.id::text AS existing_map_id,
      m.product_id::text AS existing_product_id,
      m.seller_sku,
      m.fnsku
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id
     AND m.store_id = i.store_id
     AND m.deleted_at IS NULL
     AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
    WHERE m.product_id IS DISTINCT FROM i.product_id
  `,
    [JSON.stringify(plan)],
  );

  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify({
    before_counts: beforeCounts.rows[0],
    before_coverage: beforeCoverage,
    pre_existing_external_listing_rows: preExisting.rows,
    conflicts: conflictRows.rows,
  }, null, 2));

  if (conflictRows.rows.length > 0) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nFound ${conflictRows.rows.length} conflicting active seller_sku map rows. No inserts executed.\n`,
    );
    throw new Error("Conflicting active product_identifier_map rows found; no inserts executed.");
  }

  const insertable = plan.filter(
    (row) => !preExisting.rows.some((r) => r.external_listing_id === row.external_listing_id),
  );

  let insertedRows: Record<string, unknown>[] = [];
  await client.query("BEGIN");
  try {
    const ins = await client.query(
      `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          organization_id uuid,
          store_id uuid,
          product_id uuid,
          seller_sku text,
          msku text,
          fnsku text,
          match_source text,
          source_report_type text,
          external_listing_id text
        )
      ),
      inserted AS (
        INSERT INTO public.product_identifier_map (
          organization_id,
          store_id,
          product_id,
          seller_sku,
          msku,
          fnsku,
          match_source,
          source_report_type,
          external_listing_id,
          is_primary,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at
        )
        SELECT
          i.organization_id,
          i.store_id,
          i.product_id,
          i.seller_sku,
          i.msku,
          i.fnsku,
          i.match_source,
          i.source_report_type,
          i.external_listing_id,
          true,
          now(),
          now(),
          now(),
          now()
        FROM input i
        WHERE NOT EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.external_listing_id = i.external_listing_id
        )
        RETURNING id::text, product_id::text, seller_sku, msku, fnsku, external_listing_id
      )
      SELECT * FROM inserted
    `,
      [JSON.stringify(insertable)],
    );
    insertedRows = ins.rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterCoverage = await coverage(client);
  const afterCounts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS e1_map_rows
  `, [MATCH_SOURCE]);
  await client.end();

  fs.writeFileSync(path.join(outDir, "inserted-rows.json"), JSON.stringify(insertedRows, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-existing.json"), JSON.stringify(preExisting.rows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback only this V192 E1 execute batch.",
      "DELETE FROM public.product_identifier_map",
      `WHERE external_listing_id IN (${insertedRows.map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`).join(", ")});`,
      "",
    ].join("\n"),
  );

  const manifest = {
    prompt: "EXPECTED-PACKAGES-E1-MAP-BRIDGE-EXECUTE-V192",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    plan_run_id: PLAN_RUN_ID,
    approved_plan_rows: plan.length,
    inserted_rows: insertedRows.length,
    skipped_existing_rows: preExisting.rows.length,
    db_writes: { product_identifier_map_inserts: insertedRows.length },
    forbidden_writes: {
      products_created: false,
      expected_packages_updated: false,
      production_touched: false,
      migrations_run: false,
      package_items_created: false,
      amazon_api_called: false,
      ai_or_openai_called: false,
    },
    before_counts: beforeCounts.rows[0],
    after_counts: afterCounts.rows[0],
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Expected Packages E1 map bridge execute V192",
      "",
      `- Approved plan rows: **${plan.length}**`,
      `- Inserted map rows: **${insertedRows.length}**`,
      `- Skipped existing rows: **${preExisting.rows.length}**`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} -> **${afterCoverage.read_layer_resolved}**`,
      `- Unresolved: ${beforeCoverage.unresolved} -> **${afterCoverage.unresolved}**`,
      `- Active map rows: ${beforeCounts.rows[0]?.active_map_rows} -> **${afterCounts.rows[0]?.active_map_rows}**`,
      "",
      "No products created. No expected_packages updated.",
    ].join("\n"),
  );
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * PHASE-9A read-only EXPLAIN timing census on staging.
 * npx tsx scripts/_phase9a-scanner-lookup-explain-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";

const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function timedExplain(
  client: pg.Client,
  label: string,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const plan = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const ms = Math.round(performance.now() - t0);
  const root = (plan.rows[0]?.["QUERY PLAN"] as unknown[])?.[0] as Record<string, unknown>;
  const planTime = Number(root?.["Execution Time"] ?? 0);
  const planRows = Number(root?.["Plan Rows"] ?? 0);
  const actualRows = Number((root?.Plan as Record<string, unknown>)?.["Actual Rows"] ?? 0);
  return {
    label,
    wall_ms: ms,
    execution_time_ms: Math.round(planTime * 100) / 100,
    plan_rows: planRows,
    actual_rows: actualRows,
    node_type: (root?.Plan as Record<string, unknown>)?.["Node Type"],
    sql: sql.trim().slice(0, 200),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL || process.env.DIRECT_POSTGRES_URL;
  if (!url?.includes("eiqfaapyumhixxoeltgu")) throw new Error("staging URL required");

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const sample = await client.query(`
    SELECT tracking_number, id_slip_contents, fnsku, sku, package_code
    FROM (
      SELECT ep.tracking_number, ep.id_slip_contents, ep.fnsku, ep.sku, NULL::text AS package_code
      FROM expected_packages ep
      WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid AND ep.tracking_number IS NOT NULL
      LIMIT 1
    ) x
    UNION ALL
    SELECT NULL, id_slip_contents, NULL, NULL, package_code FROM packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL AND package_code IS NOT NULL LIMIT 1
  `, [SAM_ORG, SAM_STORE]);

  const tn = String(sample.rows[0]?.tracking_number ?? "1Z999AA10123456784").trim();
  const slip = String(sample.rows.find((r) => r.id_slip_contents)?.id_slip_contents ?? "S123456").trim();
  const fnsku = String(sample.rows.find((r) => r.fnsku)?.fnsku ?? "X001ABC123").trim();
  const pkg = String(sample.rows.find((r) => r.package_code)?.package_code ?? "BOX-001").trim();

  const queries = [
    timedExplain(client, "v_inventory_item_status.tracking", `
      SELECT ${/* gate select subset */ ""} expected_package_id, tracking_number, total_expected, total_scanned
      FROM v_inventory_item_status
      WHERE organization_id = $1::uuid AND store_id = $2::uuid AND tracking_number = $3
      LIMIT 500`, [SAM_ORG, SAM_STORE, tn]),
    timedExplain(client, "v_inventory_item_status.fnsku", `
      SELECT expected_package_id, fnsku, total_expected, total_scanned
      FROM v_inventory_item_status
      WHERE organization_id = $1::uuid AND store_id = $2::uuid AND fnsku = $3
      LIMIT 500`, [SAM_ORG, SAM_STORE, fnsku]),
    timedExplain(client, "v_inventory_status.tracking", `
      SELECT tracking_number, slip_code, total_expected, total_scanned
      FROM v_inventory_status
      WHERE organization_id = $1::uuid AND store_id = $2::uuid AND tracking_number = $3
      LIMIT 50`, [SAM_ORG, SAM_STORE, tn]),
    timedExplain(client, "expected_packages.tracking_exact", `
      SELECT id, tracking_number, expected_scan_quantity
      FROM expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid AND tracking_number = $3
      LIMIT 1000`, [SAM_ORG, SAM_STORE, tn]),
    timedExplain(client, "expected_packages.tracking_ilike", `
      SELECT id FROM expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND tracking_number ILIKE $3
      LIMIT 800`, [SAM_ORG, SAM_STORE, `%${tn.slice(0, 8)}%`]),
    timedExplain(client, "packages.package_code", `
      SELECT id, package_code FROM packages
      WHERE organization_id = $1::uuid AND deleted_at IS NULL AND package_code ILIKE $2
      LIMIT 1`, [SAM_ORG, pkg]),
    timedExplain(client, "packages.id_slip_contents", `
      SELECT id FROM packages
      WHERE organization_id = $1::uuid AND deleted_at IS NULL AND id_slip_contents ILIKE $2
      LIMIT 1`, [SAM_ORG, slip]),
    timedExplain(client, "pallets.tracking", `
      SELECT id FROM pallets
      WHERE organization_id = $1::uuid AND deleted_at IS NULL AND tracking_number ILIKE $2
      LIMIT 1`, [SAM_ORG, tn]),
    timedExplain(client, "product_identifier_map.fnsku", `
      SELECT product_id FROM product_identifier_map
      WHERE organization_id = $1::uuid AND deleted_at IS NULL AND fnsku = $2
      LIMIT 5`, [SAM_ORG, fnsku]),
    timedExplain(client, "claim_candidates.org_list", `
      SELECT id FROM claim_candidates
      WHERE organization_id = $1::uuid
      ORDER BY created_at ASC, id ASC
      LIMIT 120`, [SAM_ORG]),
  ];

  const results = await Promise.all(queries);

  const viewSizes = await client.query(`
    SELECT relname, pg_total_relation_size(c.oid)::bigint AS bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND relname IN (
      'expected_packages','return_items','packages','v_inventory_item_status','v_scanned_items_counted'
    )
  `);

  await client.end();

  const outDir = path.join(process.cwd(), ".cursor/audit-reports/phase9a-scanner-search-performance", "20260608T200000Z");
  fs.mkdirSync(outDir, { recursive: true });
  const payload = { samples: { tn, slip, fnsku, pkg }, explain: results, relation_sizes: viewSizes.rows };
  fs.writeFileSync(path.join(outDir, "explain_census.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

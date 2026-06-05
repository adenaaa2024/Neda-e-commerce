import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const c = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const lastSynced = await c.query(
    `SELECT report_type, status, max(created_at)::text AS last_at
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
     GROUP BY report_type, status ORDER BY 1, 2`,
    [ORG],
  );
  const best = await c.query(
    `SELECT DISTINCT ON (report_type) report_type, status, created_at::text AS last_at
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND status IN ('synced','success')
     ORDER BY report_type, created_at DESC`,
    [ORG],
  );
  const orders = await c.query(
    `SELECT max(request_date)::text AS request_date, max(last_updated_date)::text AS last_updated, count(*)::int AS n
     FROM amazon_removals WHERE organization_id=$1::uuid`,
    [ORG],
  );
  const ships = await c.query(
    `SELECT max(shipment_date)::text AS shipment_date, count(*)::int AS n
     FROM amazon_removal_shipments WHERE organization_id=$1::uuid`,
    [ORG],
  );
  const ep = await c.query(
    `SELECT build_source, max(updated_at)::text AS last_updated, count(*)::int AS n
     FROM expected_packages WHERE organization_id=$1::uuid
       AND build_source IN ('detail_shipment','detail_remainder')
     GROUP BY build_source ORDER BY 1`,
    [ORG],
  );
  await c.end();
  console.log(JSON.stringify({ lastSynced: lastSynced.rows, bestSuccess: best.rows, orders: orders.rows[0], ships: ships.rows[0], ep: ep.rows }, null, 2));
}

main();

import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";

const IDS = [
  "2b5bbd1b-4dff-488e-ac18-f5d8546f002e",
  "ae6d28a9-e2bc-421b-9cb1-a13d9870d993",
];

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const c = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`SELECT * FROM expected_packages WHERE id = ANY($1::uuid[])`, [IDS]);
  for (const row of r.rows) {
    console.log("---", row.id, "---");
    console.log(JSON.stringify(row, null, 2));
  }

  const ars = await c.query(
    `SELECT id::text, tracking_number, fnsku, sku, quantity, order_id, shipment_date::text, carrier, raw_row
     FROM amazon_removal_shipments WHERE id IN ($1, $2)`,
    [r.rows[0]?.source_shipment_row_id, r.rows[1]?.source_shipment_row_id],
  );
  console.log("source shipment rows:", JSON.stringify(ars.rows, null, 2));

  await c.end();
}

main();

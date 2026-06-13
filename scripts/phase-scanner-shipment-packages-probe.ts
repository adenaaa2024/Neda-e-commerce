import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const c = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();

  const pkgs = await c.query(
    `SELECT id::text, tracking_number, package_code, id_slip_contents, pallet_id::text, status, deleted_at::text
     FROM packages WHERE organization_id=$1 AND store_id=$2 AND tracking_number=$3`,
    [ORG, STORE, TRACKING],
  );
  console.log("packages:", pkgs.rows);

  if (pkgs.rows.length) {
    const ri = await c.query(
      `SELECT id::text, package_id::text, fnsku, sku, scanned_quantity, resolved_product_id::text, deleted_at::text
       FROM return_items WHERE organization_id=$1 AND store_id=$2 AND package_id=ANY($3::uuid[]) AND upper(trim(fnsku))=$4`,
      [ORG, STORE, pkgs.rows.map((r) => r.id), FNSKU],
    );
    console.log("return_items:", ri.rows);
  }

  const ars = await c.query(
    `SELECT id::text, tracking_number, fnsku, sku, shipped_quantity, order_id, raw_row
     FROM amazon_removal_shipments WHERE id='859cdb9f-4ac5-4cf5-aa17-61b489f0370b'`,
  );
  console.log("source shipment row:", JSON.stringify(ars.rows[0], null, 2));

  const details = await c.query(
    `SELECT id::text, fnsku, sku, shipped_quantity, order_id
     FROM amazon_removal_order_details WHERE id IN ('4e8e4492-df44-4463-b2b3-d993d16ee418','7f5a0285-3087-4cdd-a030-56093be6bdab')`,
  );
  console.log("source detail rows:", details.rows);

  await c.end();
}

main();

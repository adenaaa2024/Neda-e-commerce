import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl } from "../lib/production-db-bind";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const SHIPMENT = "387003587";
const FNSKU = "X004LKS4VD";

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const c = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='expected_packages' ORDER BY ordinal_position`,
  );
  console.log("ep cols:", cols.rows.map((r) => r.column_name).join(", "));

  const ep = await c.query(
    `SELECT * FROM public.expected_packages WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upper(trim(fnsku))=$3 LIMIT 50`,
    [ORG, STORE, FNSKU],
  );
  console.log("ep count for fnsku:", ep.rows.length);
  for (const r of ep.rows) {
    const hit = JSON.stringify(r).includes(SHIPMENT);
    console.log({
      id: r.id,
      qty: r.expected_scan_quantity,
      tracking: r.tracking_number,
      slip: r.id_slip_contents,
      order: r.order_id,
      build: r.build_source,
      disposition: r.disposition,
      shipment_hit: hit,
    });
  }

  const inv = await c.query(
    `SELECT * FROM public.v_inventory_item_status WHERE organization_id=$1::uuid AND store_id=$2::uuid AND upper(trim(fnsku))=$3`,
    [ORG, STORE, FNSKU],
  );
  console.log("inv rows:", inv.rows.length);
  for (const r of inv.rows) {
    console.log({
      tracking: r.tracking_number,
      slip: r.slip_code,
      expected: r.total_expected,
      scanned: r.total_scanned,
      ep_id: r.expected_package_id,
      status: r.status,
    });
  }

  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

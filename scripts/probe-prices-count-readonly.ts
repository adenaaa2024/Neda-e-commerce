import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main() {
  loadEnvLocalIntoProcess();
  const orig = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await orig.connect();
  const pp = await orig.query(`SELECT count(*)::int AS c FROM product_prices`);
  const backup = await orig.query(`SELECT count(*)::int AS c FROM _backup_phase_ab_products_20260605t212000z`);
  await orig.end();
  console.log(JSON.stringify({ product_prices_total: pp.rows[0], backup_products_preimage: backup.rows[0] }, null, 2));
}
main().catch(console.error);

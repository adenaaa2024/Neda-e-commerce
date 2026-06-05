import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const c = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  for (const t of ["expected_packages", "product_identifier_map", "amazon_removal_shipments"]) {
    const r = await c.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [t],
    );
    console.log(t, r.rows.map((x) => x.column_name).join(", "));
  }
  await c.end();
}
main();

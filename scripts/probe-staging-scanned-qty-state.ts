import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main() {
  loadEnvLocalIntoProcess();
  const c = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const col = await c.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='return_items' AND column_name='scanned_quantity'`,
  );
  let mig: pg.QueryResult | null = null;
  try {
    mig = await c.query(
      `SELECT version FROM supabase_migrations.schema_migrations
       WHERE version LIKE '2026060818%' ORDER BY version`,
    );
  } catch {
    mig = null;
  }
  const allocDef = await c.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'allocate_expected_item_unit'
     ORDER BY p.oid DESC LIMIT 1`,
  );
  const releaseDef = await c.query(
    `SELECT pg_get_functiondef('public.release_expected_item_unit(uuid,uuid,boolean)'::regprocedure) AS def`,
  );
  await c.end();
  console.log(
    JSON.stringify(
      {
        scanned_quantity_column: col.rows[0] ?? null,
        migrations: mig?.rows ?? [],
        allocate_uses_scanned_quantity: /scanned_quantity/i.test(String(allocDef.rows[0]?.def ?? "")),
        release_uses_scanned_quantity: /scanned_quantity/i.test(String(releaseDef.rows[0]?.def ?? "")),
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

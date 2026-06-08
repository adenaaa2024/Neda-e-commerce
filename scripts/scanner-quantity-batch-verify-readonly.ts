/**
 * Read-only verify: scanned_quantity column + quantity-aware views (staging or original).
 *   npx tsx scripts/scanner-quantity-batch-verify-readonly.ts
 */
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("DIRECT_POSTGRES_URL required");

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const col = await client.query(
    `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'return_items' AND column_name = 'scanned_quantity'`,
  );

  const viewDef = await client.query(
    `SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS def`,
  );
  const def = String(viewDef.rows[0]?.def ?? "");
  const usesSum = /sum\s*\(\s*coalesce\s*\(\s*r\.scanned_quantity/i.test(def);

  const sample = await client.query(
    `SELECT
       count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_rows,
       count(*) FILTER (WHERE deleted_at IS NULL AND COALESCE(scanned_quantity, 1) = 1)::int AS qty_one,
       sum(COALESCE(scanned_quantity, 1)) FILTER (WHERE deleted_at IS NULL)::bigint AS unit_sum
     FROM return_items
     WHERE organization_id = '00000000-0000-0000-0000-000000000001'::uuid`,
  );

  await client.end();

  const out = {
    scanned_quantity_column: col.rows[0] ?? null,
    v_scanned_items_counted_uses_sum: usesSum,
    sample_org_stats: sample.rows[0],
    backward_compatible: col.rows.length > 0,
  };
  console.log(JSON.stringify(out, null, 2));
  if (!col.rows.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

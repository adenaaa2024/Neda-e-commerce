import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";

async function main() {
  loadEnvLocalIntoProcess();
  const stag = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL!,
    ssl: { rejectUnauthorized: false },
  });
  const orig = new pg.Client({
    connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL!,
    ssl: { rejectUnauthorized: false },
  });
  await stag.connect();
  await orig.connect();

  const sMapIds = (
    await stag.query(`SELECT id::text AS id FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG])
  ).rows.map((r: { id: string }) => r.id);
  const oMapSet = new Set(
    (
      await orig.query(`SELECT id::text AS id FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG])
    ).rows.map((r: { id: string }) => r.id),
  );
  const sProdIds = (
    await stag.query(`SELECT id::text AS id FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG])
  ).rows.map((r: { id: string }) => r.id);
  const oProdSet = new Set(
    (
      await orig.query(`SELECT id::text AS id FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [ORG])
    ).rows.map((r: { id: string }) => r.id),
  );

  const stagingOnlyMapIds = sMapIds.filter((id) => !oMapSet.has(id));
  const originalOnlyMapIds = [...oMapSet].filter((id) => !new Set(sMapIds).has(id));
  const stagingOnlyProductIds = sProdIds.filter((id) => !oProdSet.has(id));

  const pricesStaging = await stag.query(
    `SELECT count(*)::int AS c FROM product_prices WHERE product_id = ANY($1::uuid[])`,
    [stagingOnlyProductIds.length ? stagingOnlyProductIds : ["00000000-0000-0000-0000-000000000001"]],
  );
  const pricesOriginal = await orig.query(
    `SELECT count(*)::int AS c FROM product_prices WHERE product_id = ANY($1::uuid[])`,
    [stagingOnlyProductIds.length ? stagingOnlyProductIds : ["00000000-0000-0000-0000-000000000001"]],
  );

  const xMap = await orig.query(
    `SELECT m.id::text, m.product_id::text, m.fnsku, m.seller_sku, p.sku
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id
     WHERE m.organization_id=$1::uuid AND m.deleted_at IS NULL AND upper(trim(m.fnsku))=upper('X0030LQS8F')`,
    [ORG],
  );

  const mapsUpsertedEstimate = 4243 - stagingOnlyMapIds.length;

  console.log(JSON.stringify({
    products_gap_remaining: stagingOnlyProductIds.length,
    products_upserted_audit_target: 27,
    map_ids_staging_only_remaining: stagingOnlyMapIds.length,
    map_ids_original_only_preserved: originalOnlyMapIds.length,
    map_rows_upserted_estimate: mapsUpsertedEstimate,
    map_rows_skipped_estimate: stagingOnlyMapIds.length,
    prices_for_gap_products_staging: pricesStaging.rows[0],
    prices_for_gap_products_original: pricesOriginal.rows[0],
    X0030LQS8F_map: xMap.rows,
  }, null, 2));

  await stag.end();
  await orig.end();
}

main().catch(console.error);

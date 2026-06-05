import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";

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

  const x = await orig.query(
    `SELECT count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
            count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
     FROM expected_packages WHERE upper(trim(fnsku))=upper('X0030LQS8F')`,
  );

  const ep = await orig.query(`SELECT count(*)::int AS c FROM expected_packages WHERE resolved_product_id IS NULL`);

  const classCounts = await orig.query(`
    WITH base AS (
      SELECT ep.id FROM expected_packages ep WHERE ep.resolved_product_id IS NULL
    ),
    map_products AS (
      SELECT b.id, count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count
      FROM base b
      LEFT JOIN expected_packages ep ON ep.id = b.id
      LEFT JOIN product_identifier_map m
        ON m.deleted_at IS NULL AND m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND ((NULLIF(btrim(ep.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ep.fnsku)))
         OR (NULLIF(btrim(ep.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ep.sku))))
      GROUP BY b.id
    ),
    direct_products AS (
      SELECT b.id, count(DISTINCT p.id)::int AS product_count
      FROM base b
      LEFT JOIN expected_packages ep ON ep.id = b.id
      LEFT JOIN products p ON p.organization_id = ep.organization_id AND p.deleted_at IS NULL
       AND ((NULLIF(btrim(ep.fnsku),'') IS NOT NULL AND upper(btrim(p.fnsku))=upper(btrim(ep.fnsku)))
         OR (NULLIF(btrim(ep.sku),'') IS NOT NULL AND upper(btrim(p.sku))=upper(btrim(ep.sku))))
      GROUP BY b.id
    ),
    classified AS (
      SELECT b.id,
        CASE
          WHEN coalesce(mp.map_product_count,0) > 1 OR coalesce(dp.product_count,0) > 1 THEN 'D'
          WHEN coalesce(mp.map_product_count,0) = 1 THEN 'A'
          WHEN coalesce(dp.product_count,0) = 1 AND coalesce(mp.map_product_count,0) = 0 THEN 'B'
          ELSE 'C'
        END AS class
      FROM base b
      LEFT JOIN map_products mp ON mp.id = b.id
      LEFT JOIN direct_products dp ON dp.id = b.id
    )
    SELECT class, count(*)::int AS n FROM classified GROUP BY class ORDER BY class
  `);

  const sProd = await stag.query(
    `SELECT count(*)::int AS c FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );
  const oProd = await orig.query(
    `SELECT count(*)::int AS c FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );
  const sMap = await stag.query(
    `SELECT count(*)::int AS c FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );
  const oMap = await orig.query(
    `SELECT count(*)::int AS c FROM product_identifier_map WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG],
  );

  const fk = await orig.query(
    `SELECT count(*)::int AS c FROM product_identifier_map m
     WHERE m.organization_id=$1::uuid AND m.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id=m.product_id)`,
    [ORG],
  );

  const fnskuDup = await orig.query(`
    SELECT upper(trim(fnsku)) AS fnsku, count(DISTINCT product_id)::int AS n
    FROM product_identifier_map
    WHERE organization_id=$1::uuid AND deleted_at IS NULL AND fnsku IS NOT NULL AND btrim(fnsku) <> ''
    GROUP BY upper(trim(fnsku)) HAVING count(DISTINCT product_id) > 1
  `, [ORG]);

  console.log(JSON.stringify({
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    unresolved_ep: ep.rows[0],
    class_counts: classCounts.rows,
    X0030LQS8F: x.rows[0],
    product_counts: { staging: sProd.rows[0], original: oProd.rows[0] },
    map_counts: { staging: sMap.rows[0], original: oMap.rows[0] },
    fk_map_orphans: fk.rows[0],
    fnsku_multi_product_clusters: fnskuDup.rows,
  }, null, 2));

  await stag.end();
  await orig.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

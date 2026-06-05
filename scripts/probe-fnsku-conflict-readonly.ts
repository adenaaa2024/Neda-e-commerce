import pg from "pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const FNSKU = process.argv[2] ?? "X003UR3W83";

async function probe(url: string, label: string) {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const map = await c.query(
    `SELECT id::text, product_id::text, seller_sku, asin, deleted_at, match_source
     FROM product_identifier_map WHERE organization_id=$1::uuid AND upper(trim(fnsku))=upper($2)
     ORDER BY deleted_at NULLS FIRST, id`,
    [ORG, FNSKU],
  );
  const prod = await c.query(
    `SELECT id::text, product_name, sku, fnsku, asin FROM products
     WHERE organization_id=$1::uuid AND deleted_at IS NULL
       AND (upper(trim(fnsku))=upper($2)
         OR id IN (SELECT product_id FROM product_identifier_map WHERE organization_id=$1::uuid AND upper(trim(fnsku))=upper($2)))`,
    [ORG, FNSKU],
  );
  const ep = await c.query(
    `SELECT count(*)::int AS unresolved FROM expected_packages
     WHERE upper(trim(fnsku))=upper($1) AND resolved_product_id IS NULL`,
    [FNSKU],
  );
  console.log(label, JSON.stringify({ map: map.rows, products: prod.rows, ep_unresolved: ep.rows[0] }, null, 2));
  await c.end();
}

loadEnvLocalIntoProcess();
(async () => {
  await probe(process.env.STAGING_DIRECT_POSTGRES_URL!, "staging");
  await probe(process.env.ORIGINAL_DIRECT_POSTGRES_URL!, "original");
})();

/**
 * Read-only: distinct carrier tokens on staging for 8A seed.
 */
import pg from "pg";
import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function stagingPostgresUrl(): string {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url.includes(STAGING_REF)) {
    throw new Error(`Postgres URL must target staging ${STAGING_REF}`);
  }
  return url;
}

async function main() {
  loadEnvLocalIntoProcess();
  getStagingProjectRef();
  const client = new pg.Client({
    connectionString: stagingPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const r = await client.query(`
    WITH raw AS (
      SELECT btrim(carrier) AS token FROM expected_packages WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
      UNION ALL SELECT btrim(carrier) FROM amazon_removal_shipments WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
      UNION ALL SELECT btrim(carrier) FROM shipment_containers WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
      UNION ALL SELECT btrim(carrier_name) FROM packages WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''
      UNION ALL SELECT btrim(carrier_name) FROM pallets WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''
    ),
    norm AS (
      SELECT token,
        (SELECT operational FROM public.normalize_removal_carrier_operational(token) LIMIT 1) AS operational,
        (SELECT status FROM public.normalize_removal_carrier_operational(token) LIMIT 1) AS norm_status
      FROM raw
    )
    SELECT token, operational, norm_status, COUNT(*)::int AS cnt
    FROM norm
    GROUP BY 1,2,3
    ORDER BY cnt DESC, token
  `);
  await client.end();
  console.log(JSON.stringify({ count: r.rows.length, tokens: r.rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * EXPECTED-PACKAGES-UI-WIRE-V179 — staging smoke (read-only, Sam org/store).
 *
 *   npx tsx scripts/expected-packages-ui-wire-v179-staging-smoke.ts
 */
import pg from "pg";

import { fetchExpectedPackagesNedaRead } from "../app/returns/expected-packages-linkage-actions";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  if (ref !== STAGING_REF) {
    console.error(JSON.stringify({ ok: false, error: "staging ref guard" }));
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  await client.end();
  if ((pkgItems.rowCount ?? 0) > 0) {
    console.error(JSON.stringify({ ok: false, error: "package_items forbidden" }));
    process.exit(2);
  }

  const unfiltered = await fetchExpectedPackagesNedaRead({
    organizationId: SAM_ORG,
    storeId: SAM_STORE,
    limit: 5,
  });
  if (!unfiltered.ok) {
    console.error(JSON.stringify({ ok: false, error: unfiltered.error }));
    process.exit(1);
  }

  const sampleOrder = unfiltered.data.rows[0]?.order_id?.trim();
  const sampleTracking = unfiltered.data.rows[0]?.tracking_number?.trim();

  let filteredOk = true;
  if (sampleOrder) {
    const byOrder = await fetchExpectedPackagesNedaRead({
      organizationId: SAM_ORG,
      storeId: SAM_STORE,
      orderId: sampleOrder,
      limit: 20,
    });
    filteredOk = byOrder.ok && byOrder.data.rows.every((r) => r.order_id === sampleOrder);
  }

  const resolved = unfiltered.data.rows.filter((r) => r.product_linkage.is_resolved).length;

  console.log(
    JSON.stringify(
      {
        ok: true,
        staging_ref: STAGING_REF,
        sam_org: SAM_ORG,
        sam_store: SAM_STORE,
        package_items_absent: true,
        sample_rows: unfiltered.data.rows.length,
        linkage_readiness: unfiltered.data.linkage_readiness,
        resolved_in_sample: resolved,
        order_filter_ok: filteredOk,
        sample_order_id: sampleOrder ?? null,
        sample_tracking: sampleTracking?.slice(0, 24) ?? null,
      },
      null,
      2,
    ),
  );

  if (unfiltered.data.rows.length === 0) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

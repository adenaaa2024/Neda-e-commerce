/**
 * INVENTORY-VIEWS-UI-WIRE-V180 — staging smoke (read-only, Sam org/store).
 *
 *   npx tsx scripts/inventory-views-ui-wire-v180-staging-smoke.ts
 */
import pg from "pg";

import { fetchInventoryItemStatusForNeda } from "../app/returns/inventory-views-linkage-actions";
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

  const sample = await fetchInventoryItemStatusForNeda({
    organizationId: SAM_ORG,
    storeId: SAM_STORE,
    limit: 5,
  });
  if (!sample.ok) {
    console.error(JSON.stringify({ ok: false, error: sample.error }));
    process.exit(1);
  }

  const tn = sample.data.item_status_rows[0]?.tracking_number?.trim();
  const slip = sample.data.item_status_rows[0]?.slip_code?.trim();

  let filterOk = true;
  if (tn) {
    const filtered = await fetchInventoryItemStatusForNeda({
      organizationId: SAM_ORG,
      storeId: SAM_STORE,
      trackingNumber: tn,
      limit: 50,
    });
    filterOk =
      filtered.ok &&
      filtered.data.item_status_rows.every((r) => (r.tracking_number ?? "").includes(tn.slice(0, 8)));
  }

  const chip = tn
    ? await fetchInventoryItemStatusForNeda({
        organizationId: SAM_ORG,
        storeId: SAM_STORE,
        trackingNumber: tn,
        slipCode: slip,
        packageStatusOnly: true,
      })
    : null;

  const resolved = sample.data.item_status_rows.filter((r) => r.product_linkage.is_resolved).length;

  console.log(
    JSON.stringify(
      {
        ok: true,
        staging_ref: STAGING_REF,
        sam_org: SAM_ORG,
        sam_store: SAM_STORE,
        package_items_absent: true,
        views_present: sample.data.views_present,
        linkage_readiness: sample.data.linkage_readiness,
        sample_item_rows: sample.data.item_status_rows.length,
        resolved_in_sample: resolved,
        tracking_filter_ok: filterOk,
        package_status: chip?.ok ? chip.data.package_status?.status ?? null : null,
        sample_tracking: tn?.slice(0, 24) ?? null,
        sample_slip: slip ?? null,
      },
      null,
      2,
    ),
  );

  if (!sample.data.views_present.v_inventory_item_status) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

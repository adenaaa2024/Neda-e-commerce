/**
 * MAIN V205 — Shipment Entry / inventory read-model smoke (package_code filter).
 *
 *   npx tsx scripts/main-v205-package-code-shipment-entry-smoke.ts
 */
import pg from "pg";

import { fetchInventoryItemStatusForNeda } from "../app/returns/inventory-views-linkage-actions";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });
  if (ref !== STAGING_REF) {
    console.error(JSON.stringify({ ok: false, error: "staging ref guard" }));
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  const colCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'v_inventory_item_status'
       AND column_name = 'package_code'`,
  );
  const hasCol = (colCheck.rowCount ?? 0) > 0;

  const pkg = await client.query(
    `SELECT p.package_code, p.organization_id
     FROM public.packages p
     INNER JOIN public.return_items r ON r.package_id = p.id AND r.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.package_code IS NOT NULL AND btrim(p.package_code) <> ''
     LIMIT 1`,
  );
  await client.end();

  const sampleCode = pkg.rows[0]?.package_code ? String(pkg.rows[0].package_code) : null;
  const org = String(pkg.rows[0]?.organization_id ?? SAM_ORG);

  let packageCodeFilterOk = false;
  let rowCount = 0;
  let fetchError: string | null = null;

  if (sampleCode && hasCol) {
    const res = await fetchInventoryItemStatusForNeda({
      organizationId: org,
      storeId: SAM_STORE,
      packageCode: sampleCode,
      limit: 50,
    });
    if (res.ok) {
      rowCount = res.data.item_status_rows.length;
      packageCodeFilterOk = res.data.item_status_rows.every(
        (r) => (r.package_code ?? "").trim() === sampleCode.trim(),
      );
    } else {
      fetchError = res.error;
    }
  }

  const pass = hasCol && sampleCode != null && packageCodeFilterOk && rowCount > 0;

  console.log(
    JSON.stringify(
      {
        ok: pass,
        staging_ref: STAGING_REF,
        package_code_column_on_view: hasCol,
        sample_package_code: sampleCode,
        fetch_error: fetchError,
        rows_by_package_code: rowCount,
        package_code_filter_ok: packageCodeFilterOk,
        shipment_entry_read_path: "fetchInventoryItemStatusForNeda(packageCode)",
      },
      null,
      2,
    ),
  );

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

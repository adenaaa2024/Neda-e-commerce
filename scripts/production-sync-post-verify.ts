/**
 * Post-production-sync verification: linkage, scanner probes, health, cron.
 */
import { createRequire, type Module } from "node:module";
import { execSync } from "node:child_process";

import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadProductionSyncHealth, REMOVAL_NIGHTLY_CRON_UTC } from "../lib/production-sync-health";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const pgUrl = productionPostgresUrl();
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const recentShipments = await c.query(
    `SELECT id, tracking_number, fnsku, sku, shipment_date::text, order_id
     FROM amazon_removal_shipments
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
     ORDER BY shipment_date DESC NULLS LAST, created_at DESC
     LIMIT 8`,
    [ORG_ID, STORE_ID],
  );

  const linkage: unknown[] = [];
  for (const row of recentShipments.rows) {
    const fnsku = String(row.fnsku ?? "").trim();
    const sku = String(row.sku ?? "").trim();
    const tracking = String(row.tracking_number ?? "").trim();
    const pim = await c.query(
      `SELECT id, product_id, fnsku, seller_sku, asin
       FROM product_identifier_map
       WHERE organization_id=$1::uuid AND store_id=$2::uuid AND deleted_at IS NULL
         AND (
           ($3 <> '' AND upper(fnsku)=upper($3))
           OR ($4 <> '' AND upper(seller_sku)=upper($4))
           OR ($4 <> '' AND upper(msku)=upper($4))
           OR ($4 <> '' AND upper(asin)=upper($4))
         )
       LIMIT 5`,
      [ORG_ID, STORE_ID, fnsku, sku],
    );
    const ep = await c.query(
      `SELECT id, build_source, expected_scan_quantity, resolved_product_id, identifier_resolution_status, tracking_number
       FROM expected_packages
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND parent_expected_package_id IS NULL
         AND (
           ($3 <> '' AND upper(tracking_number)=upper($3))
           OR ($4 <> '' AND upper(fnsku)=upper($4))
           OR ($5 <> '' AND upper(sku)=upper($5))
         )
       ORDER BY updated_at DESC
       LIMIT 3`,
      [ORG_ID, STORE_ID, tracking, fnsku, sku],
    );
    const shipProd = await c.query(
      `SELECT resolved_product_id, identifier_resolution_status FROM amazon_removal_shipments WHERE id=$1::uuid`,
      [row.id],
    );
    linkage.push({
      shipment_id: row.id,
      tracking_number: tracking,
      fnsku,
      sku,
      shipment_date: row.shipment_date,
      pim_matches: pim.rows.length,
      product_ids: [...new Set(pim.rows.map((r) => r.product_id).filter(Boolean))],
      shipment_resolution: shipProd.rows[0] ?? null,
      expected_packages: ep.rows,
      unresolved:
        pim.rows.length === 0 &&
        !shipProd.rows[0]?.resolved_product_id &&
        ep.rows.every((e) => !e.resolved_product_id),
    });
  }

  const unresolvedEp = await c.query(
    `SELECT count(*)::bigint c FROM expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND build_source IN ('detail_shipment','detail_remainder')
       AND resolved_product_id IS NULL AND expected_scan_quantity > 0`,
    [ORG_ID, STORE_ID],
  );
  const unresolvedShipments = await c.query(
    `SELECT count(*)::bigint c FROM amazon_removal_shipments
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND shipment_date >= '2026-05-06'
       AND (resolved_product_id IS NULL OR identifier_resolution_status IN ('unresolved','ambiguous'))`,
    [ORG_ID, STORE_ID],
  );

  const imports = await c.query(
    `SELECT report_type, status, created_at::text, id::text
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
     ORDER BY created_at DESC LIMIT 6`,
    [ORG_ID],
  );

  const counts = await c.query(
    `SELECT
       (SELECT count(*)::bigint FROM amazon_removals WHERE organization_id=$1::uuid) AS removals,
       (SELECT count(*)::bigint FROM amazon_removal_shipments WHERE organization_id=$1::uuid) AS shipments,
       (SELECT count(*)::bigint FROM expected_packages WHERE organization_id=$1::uuid
          AND build_source IN ('detail_shipment','detail_remainder')) AS ep_derived,
       (SELECT max(shipment_date)::text FROM amazon_removal_shipments WHERE organization_id=$1::uuid) AS latest_ship`,
    [ORG_ID],
  );

  await c.end();

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const health = await loadProductionSyncHealth(supabase, ORG_ID);

  const { resolveAllocatableExpectedPackageHint } = await import("../lib/scanner/receive-expected-with-split");
  const scanner: unknown[] = [];
  for (const row of recentShipments.rows.slice(0, 5)) {
    const fnsku = String(row.fnsku ?? "").trim();
    const sku = String(row.sku ?? "").trim();
    const tracking = String(row.tracking_number ?? "").trim();
    const epHint = await resolveAllocatableExpectedPackageHint(supabase, {
      organizationId: ORG_ID,
      storeId: STORE_ID,
      fnsku,
      sku,
      packageTrackingNumber: tracking,
    });
    const pkgLookup = tracking
      ? (
          await supabase
            .from("expected_packages")
            .select("id, tracking_number, expected_scan_quantity")
            .eq("organization_id", ORG_ID)
            .eq("store_id", STORE_ID)
            .ilike("tracking_number", tracking)
            .limit(1)
        ).data
      : [];
    scanner.push({
      tracking_number: tracking,
      tracking_lookup: pkgLookup?.length ? "found" : "missing",
      expected_package_hint_id: epHint,
      shipment_lookup: row.id ? "found" : "missing",
      allocatable: epHint ? "yes" : "no",
    });
  }

  let cronCli = "";
  try {
    cronCli = execSync("npx vercel crons ls", { encoding: "utf8", cwd: process.cwd() });
  } catch {
    cronCli = "unavailable";
  }

  let vercelEnv = "";
  try {
    vercelEnv = execSync("npx vercel env ls production", { encoding: "utf8", cwd: process.cwd() });
  } catch {
    vercelEnv = "";
  }
  const nightlyCronFlag = /ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON/.test(vercelEnv);

  console.log(
    JSON.stringify(
      {
        target_ref: PRODUCTION_REF,
        domain_counts: counts.rows[0],
        recent_imports: imports.rows,
        product_linkage_sample: linkage,
        unresolved_expected_packages_with_qty: Number(unresolvedEp.rows[0]?.c),
        unresolved_recent_shipments: Number(unresolvedShipments.rows[0]?.c),
        scanner_probes: scanner,
        health_dashboard: health,
        cron: {
          schedule: REMOVAL_NIGHTLY_CRON_UTC,
          vercel_cli: cronCli.split(/\r?\n/).filter((l) => l.includes("removal-nightly")).join(" | "),
          ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON_name_on_vercel: nightlyCronFlag,
          route_deployed: cronCli.includes("not deployed") ? false : "unknown",
        },
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

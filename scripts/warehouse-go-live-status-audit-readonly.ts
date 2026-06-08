/**
 * WAREHOUSE_GO_LIVE_STATUS_AUDIT — read-only production census.
 *   npx tsx scripts/warehouse-go-live-status-audit-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT = `.cursor/audit-reports/warehouse-go-live-status-audit/${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

async function main() {
  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const out: Record<string, unknown> = { ref: PRODUCTION_REF, audited_at: new Date().toISOString() };

  const uploads7d = await client.query(
    `SELECT report_type, status,
      metadata->'source_run'->>'state' AS run_state,
      created_at::text, updated_at::text,
      metadata->'source_run'->'window'->>'start' AS w_start,
      metadata->'source_run'->'window'->>'end' AS w_end,
      LEFT(COALESCE(metadata->>'error', metadata->'source_run'->>'error', ''), 200) AS err_snip
    FROM raw_report_uploads
    WHERE organization_id = $1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
      AND created_at >= now() - interval '7 days'
    ORDER BY created_at DESC`,
    [ORG],
  );
  out.uploads_last_7d = uploads7d.rows;

  const latestSuccess = await client.query(
    `SELECT
      (SELECT MAX(created_at)::text FROM raw_report_uploads
        WHERE organization_id = $1 AND report_type = 'REMOVAL_ORDER'
          AND status = 'synced') AS last_order_sync_at,
      (SELECT MAX(created_at)::text FROM raw_report_uploads
        WHERE organization_id = $1 AND report_type = 'REMOVAL_SHIPMENT'
          AND status = 'synced') AS last_shipment_sync_at,
      (SELECT MAX(COALESCE(order_date, created_at::date))::text FROM expected_packages
        WHERE organization_id = $1 AND build_source IN ('detail_shipment','detail_remainder')) AS max_ep_source_date,
      (SELECT MAX(order_date)::text FROM amazon_removals WHERE organization_id = $1) AS max_removal_order_date,
      (SELECT MAX(COALESCE(shipment_date, order_date))::text FROM amazon_removal_shipments WHERE organization_id = $1) AS max_shipment_domain_date`,
    [ORG],
  );
  out.latest_success = latestSuccess.rows[0];

  for (const [key, sql] of [
    [
      "daily_removals_7d",
      `SELECT COALESCE(order_date, created_at::date)::text AS day, COUNT(*)::int AS rows_added
       FROM amazon_removals WHERE organization_id = $1::uuid
         AND COALESCE(order_date, created_at::date) >= current_date - 7
       GROUP BY 1 ORDER BY 1`,
    ],
    [
      "daily_shipments_7d",
      `SELECT COALESCE(shipment_date, order_date, created_at::date)::text AS day, COUNT(*)::int AS rows_added
       FROM amazon_removal_shipments WHERE organization_id = $1::uuid
         AND COALESCE(shipment_date, order_date, created_at::date) >= current_date - 7
       GROUP BY 1 ORDER BY 1`,
    ],
    [
      "daily_ep_7d",
      `SELECT COALESCE(order_date, created_at::date)::text AS day, COUNT(*)::int AS rows_added
       FROM expected_packages WHERE organization_id = $1::uuid
         AND build_source IN ('detail_shipment','detail_remainder')
         AND COALESCE(order_date, created_at::date) >= current_date - 7
       GROUP BY 1 ORDER BY 1`,
    ],
  ] as const) {
    const r = await client.query(sql, [ORG]);
    out[key] = r.rows;
  }

  const stuck = await client.query(
    `SELECT id::text, report_type, status,
      metadata->'source_run'->>'state' AS run_state, created_at::text
    FROM raw_report_uploads
    WHERE organization_id = $1 AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
      AND (
        metadata->'source_run'->>'state' IN ('polling','synthetic_upload_ready','needs_resume')
        OR status IN ('pending','processing','failed')
      )
      AND created_at >= now() - interval '14 days'
    ORDER BY created_at DESC LIMIT 40`,
    [ORG],
  );
  out.stuck_failed_recent = stuck.rows;

  const ps = await client.query(
    `SELECT automation_settings, updated_at::text FROM platform_settings WHERE id = true`,
  );
  out.platform_automation = ps.rows[0];

  const audit = await client.query(
    `SELECT automation_type, action, created_at::text, actor_email,
      LEFT(COALESCE(metadata::text, '{}'), 300) AS metadata_snip
    FROM platform_automation_audit_log
    WHERE organization_id = $1
    ORDER BY created_at DESC LIMIT 30`,
    [ORG],
  );
  out.automation_audit_log = audit.rows;

  const hasBgJobs = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'background_jobs'
     ) AS exists`,
  );
  out.background_jobs_table_exists = hasBgJobs.rows[0]?.exists === true;
  if (out.background_jobs_table_exists) {
    const peJobs = await client.query(
      `SELECT id::text, job_type, status, created_at::text, updated_at::text,
        LEFT(COALESCE(last_error, ''), 200) AS last_error
      FROM background_jobs
      WHERE organization_id = $1 AND job_type = 'product_enrichment'
      ORDER BY created_at DESC LIMIT 25`,
      [ORG],
    );
    out.product_background_jobs = peJobs.rows;
  } else {
    out.product_background_jobs = [];
    const peAudit = await client.query(
      `SELECT action, created_at::text, metadata
       FROM platform_automation_audit_log
       WHERE organization_id = $1 AND automation_type = 'product_enrichment'
       ORDER BY created_at DESC LIMIT 20`,
      [ORG],
    );
    out.product_enrichment_audit = peAudit.rows;
  }

  const prodCols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'products'
       AND column_name IN ('price', 'list_price', 'sale_price', 'updated_at')`,
  );
  const priceCol = (prodCols.rows as { column_name: string }[]).find((c) =>
    ["price", "list_price", "sale_price"].includes(c.column_name),
  )?.column_name;

  const prodStats = await client.query(
    `SELECT
      (SELECT COUNT(*)::int FROM products WHERE organization_id = $1 AND updated_at >= now() - interval '7 days') AS products_updated_7d,
      (SELECT COUNT(*)::int FROM product_identifier_map WHERE organization_id = $1 AND product_id IS NULL) AS unresolved_pim_map,
      (SELECT COUNT(*)::int FROM expected_packages WHERE organization_id = $1
        AND build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL) AS unresolved_ep_links`,
    [ORG],
  );
  out.product_stats = { ...prodStats.rows[0], price_column: priceCol ?? null };
  if (priceCol) {
    const mp = await client.query(
      `SELECT COUNT(*)::int AS n FROM products WHERE organization_id = $1 AND (${priceCol} IS NULL OR ${priceCol} = 0)`,
      [ORG],
    );
    (out.product_stats as Record<string, unknown>).missing_prices = mp.rows[0]?.n;
  }

  const store = await client.query(
    `SELECT s.id::text, s.name, m.provider,
      (m.credentials IS NOT NULL AND m.credentials::text <> 'null') AS has_marketplace_credentials
    FROM stores s
    LEFT JOIN marketplaces m ON m.id = s.marketplace_id
    WHERE s.id = $1::uuid`,
    [STORE],
  );
  out.sam_am_store = store.rows[0];

  const claims = await client.query(
    `SELECT
      (SELECT COUNT(*)::int FROM claim_cases WHERE organization_id = $1) AS claim_cases,
      (SELECT COUNT(*)::int FROM claim_submissions WHERE organization_id = $1) AS claim_submissions,
      (SELECT COUNT(*)::int FROM claim_lines WHERE organization_id = $1 AND line_grain = 'return_item') AS return_item_claim_lines,
      (SELECT claim_policy FROM organization_settings WHERE organization_id = $1) AS claim_policy`,
    [ORG],
  );
  out.claims_counts = claims.rows[0];

  const rls = await client.query(
    `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`,
  );
  out.rls_all_tables = rls.rows;
  out.rls_enabled_count = rls.rows.filter((r) => r.rls_enabled).length;
  out.rls_disabled_sensitive = rls.rows.filter(
    (r) =>
      !r.rls_enabled &&
      /^(return_items|products|claim_|expected_packages|amazon_|organization_settings|profiles)/.test(
        String(r.table_name),
      ),
  );

  const cronRuns = await client.query(
    `SELECT action, created_at::text, metadata
     FROM platform_automation_audit_log
     WHERE organization_id = $1 AND automation_type = 'removal_api_sync'
       AND action IN ('cron_tick', 'cron_run', 'manual_run', 'resume', 'schedule_save')
     ORDER BY created_at DESC LIMIT 20`,
    [ORG],
  );
  out.removal_cron_audit = cronRuns.rows;

  await client.end();

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "audit.json"), JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUT}/audit.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

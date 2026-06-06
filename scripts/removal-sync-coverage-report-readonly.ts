/**
 * Read-only day-by-day Amazon removal sync coverage (original/live DB).
 *
 *   npx tsx scripts/removal-sync-coverage-report-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const COVERAGE_START = "2025-09-01";

type DayRow = {
  day: string;
  removal_order_uploads: number;
  removal_shipment_uploads: number;
  removal_order_rows: number;
  removal_shipment_rows: number;
  expected_package_rows: number;
  upload_failed: number;
  upload_synced: number;
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(ORIGINAL_REF)) {
    throw new Error("ORIGINAL_DIRECT_POSTGRES_URL must target kxsvedvpjldygtdbylsy");
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const id = runId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/removal-sync-coverage", id);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const daily = await client.query<DayRow>(
    `WITH days AS (
       SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day
     ),
     order_uploads AS (
       SELECT created_at::date AS day, COUNT(*)::int AS c
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = 'REMOVAL_ORDER'
         AND created_at::date >= $2::date
       GROUP BY 1
     ),
     shipment_uploads AS (
       SELECT created_at::date AS day, COUNT(*)::int AS c
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = 'REMOVAL_SHIPMENT'
         AND created_at::date >= $2::date
       GROUP BY 1
     ),
     upload_status AS (
       SELECT created_at::date AS day,
              COUNT(*) FILTER (WHERE lower(status) = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE lower(status) IN ('synced', 'mapped', 'complete'))::int AS synced
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid
         AND report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
         AND created_at::date >= $2::date
       GROUP BY 1
     ),
     removals AS (
       SELECT COALESCE(order_date, created_at::date) AS day, COUNT(*)::int AS c
       FROM public.amazon_removals
       WHERE organization_id = $1::uuid
         AND COALESCE(order_date, created_at::date) >= $2::date
       GROUP BY 1
     ),
     shipments AS (
       SELECT COALESCE(shipment_date, order_date, created_at::date) AS day, COUNT(*)::int AS c
       FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid
         AND COALESCE(shipment_date, order_date, created_at::date) >= $2::date
       GROUP BY 1
     ),
     ep AS (
       SELECT COALESCE(order_date, created_at::date) AS day, COUNT(*)::int AS c
       FROM public.expected_packages
       WHERE organization_id = $1::uuid
         AND build_source IN ('detail_shipment', 'detail_remainder')
         AND COALESCE(order_date, created_at::date) >= $2::date
       GROUP BY 1
     )
     SELECT
       d.day::text AS day,
       COALESCE(ou.c, 0)::int AS removal_order_uploads,
       COALESCE(su.c, 0)::int AS removal_shipment_uploads,
       COALESCE(r.c, 0)::int AS removal_order_rows,
       COALESCE(sh.c, 0)::int AS removal_shipment_rows,
       COALESCE(e.c, 0)::int AS expected_package_rows,
       COALESCE(us.failed, 0)::int AS upload_failed,
       COALESCE(us.synced, 0)::int AS upload_synced
     FROM days d
     LEFT JOIN order_uploads ou ON ou.day = d.day
     LEFT JOIN shipment_uploads su ON su.day = d.day
     LEFT JOIN upload_status us ON us.day = d.day
     LEFT JOIN removals r ON r.day = d.day
     LEFT JOIN shipments sh ON sh.day = d.day
     LEFT JOIN ep e ON e.day = d.day
     ORDER BY d.day`,
    [ORG_ID, COVERAGE_START, endDate],
  );

  const latest = await client.query<{
    max_removal_order_date: string | null;
    max_shipment_date: string | null;
    max_ep_order_date: string | null;
  }>(
    `SELECT
       (SELECT MAX(order_date)::text FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_removal_order_date,
       (SELECT MAX(COALESCE(shipment_date, order_date))::text FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS max_shipment_date,
       (SELECT MAX(order_date)::text FROM public.expected_packages WHERE organization_id=$1::uuid AND build_source IN ('detail_shipment','detail_remainder')) AS max_ep_order_date`,
    [ORG_ID],
  );

  const recovered = await client.query<{ upload_id: string; report_type: string; failed_at: string; recovered_at: string }>(
    `WITH failed AS (
       SELECT id::text AS upload_id, report_type, created_at AS failed_at,
              metadata->'source_run'->>'idempotency_key' AS idem
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid
         AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
         AND lower(status) = 'failed'
         AND created_at::date >= $2::date
     )
     SELECT f.upload_id, f.report_type, f.failed_at::text,
            (SELECT MIN(u.created_at)::text FROM public.raw_report_uploads u
             WHERE u.organization_id = $1::uuid
               AND u.report_type = f.report_type
               AND lower(u.status) IN ('synced','mapped','complete')
               AND u.metadata->'source_run'->>'idempotency_key' = f.idem
               AND u.created_at > f.failed_at
               AND f.idem IS NOT NULL) AS recovered_at
     FROM failed f
     WHERE EXISTS (
       SELECT 1 FROM public.raw_report_uploads u
       WHERE u.organization_id = $1::uuid
         AND u.report_type = f.report_type
         AND lower(u.status) IN ('synced','mapped','complete')
         AND u.metadata->'source_run'->>'idempotency_key' = f.idem
         AND u.created_at > f.failed_at
         AND f.idem IS NOT NULL
     )`,
    [ORG_ID, COVERAGE_START],
  );

  await client.end();

  const rows = daily.rows;
  const missingOrderDays = rows.filter((r) => r.removal_order_rows === 0).map((r) => r.day);
  const missingShipmentDays = rows.filter((r) => r.removal_shipment_rows === 0).map((r) => r.day);
  const orderNoShipment = rows
    .filter((r) => r.removal_order_rows > 0 && r.removal_shipment_rows === 0)
    .map((r) => r.day);
  const shipmentNoEp = rows
    .filter((r) => r.removal_shipment_rows > 0 && r.expected_package_rows === 0)
    .map((r) => r.day);

  const cols = [
    "day",
    "removal_order_uploads",
    "removal_shipment_uploads",
    "removal_order_rows",
    "removal_shipment_rows",
    "expected_package_rows",
    "upload_failed",
    "upload_synced",
  ] as const;
  const csv = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(",")),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "coverage.csv"), csv);

  const lat = latest.rows[0] ?? {};
  const md = [
    "# Removal sync coverage (original/live)",
    "",
    `Run: \`${id}\` · DB: \`${ORIGINAL_REF}\` · Org: \`${ORG_ID}\` · Store: \`${STORE_ID}\``,
    "",
    "## Window",
    `- Start: **${COVERAGE_START}**`,
    `- End: **${endDate}**`,
    "",
    "## Latest dates",
    `- Latest removal order date: **${lat.max_removal_order_date ?? "—"}**`,
    `- Latest shipment date: **${lat.max_shipment_date ?? "—"}**`,
    `- Latest expected_packages order_date: **${lat.max_ep_order_date ?? "—"}**`,
    "",
    "## Missing days (no amazon_removals rows)",
    `- Count: **${missingOrderDays.length}**`,
    missingOrderDays.length
      ? missingOrderDays.slice(0, 40).map((d) => `- ${d}`).join("\n") +
        (missingOrderDays.length > 40 ? `\n- … and ${missingOrderDays.length - 40} more` : "")
      : "_None_",
    "",
    "## Days with orders but no shipments",
    `- Count: **${orderNoShipment.length}**`,
    orderNoShipment.length ? orderNoShipment.slice(0, 30).map((d) => `- ${d}`).join("\n") : "_None_",
    "",
    "## Days with shipments but no expected_packages",
    `- Count: **${shipmentNoEp.length}**`,
    shipmentNoEp.length ? shipmentNoEp.slice(0, 30).map((d) => `- ${d}`).join("\n") : "_None_",
    "",
    "## Recovered failed uploads (later success same idempotency_key)",
    `- Count: **${recovered.rows.length}**`,
    recovered.rows.length
      ? recovered.rows
          .map((r) => `- ${r.report_type} \`${r.upload_id}\` failed ${r.failed_at.slice(0, 10)} → recovered ${r.recovered_at?.slice(0, 10) ?? "?"}`)
          .join("\n")
      : "_None identified_",
    "",
    "## Daily counts (sample — full data in coverage.csv)",
    "",
    "| day | order uploads | shipment uploads | orders | shipments | EP | failed | synced |",
    "|-----|--------------:|-----------------:|-------:|----------:|---:|-------:|-------:|",
    ...rows
      .filter((_, i) => i % 7 === 0 || rows.length - i < 5)
      .slice(0, 50)
      .map(
        (r) =>
          `| ${r.day} | ${r.removal_order_uploads} | ${r.removal_shipment_uploads} | ${r.removal_order_rows} | ${r.removal_shipment_rows} | ${r.expected_package_rows} | ${r.upload_failed} | ${r.upload_synced} |`,
      ),
    "",
    "Full day-by-day: `coverage.csv`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "coverage.md"), md);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
    coverage_start_date: COVERAGE_START,
    coverage_end_date: endDate,
    latest_order_date: lat.max_removal_order_date,
    latest_shipment_date: lat.max_shipment_date,
    latest_expected_package_date: lat.max_ep_order_date,
    missing_days_count: missingOrderDays.length,
    missing_days_list: missingOrderDays,
    missing_shipment_days_count: missingShipmentDays.length,
    order_without_shipment_days: orderNoShipment,
    shipment_without_ep_days: shipmentNoEp,
    recovered_failed_uploads: recovered.rows,
    day_count: rows.length,
  }, null, 2));

  console.log(`Wrote ${outDir}`);
  console.log(JSON.stringify({
    latest_order_date: lat.max_removal_order_date,
    latest_shipment_date: lat.max_shipment_date,
    missing_days_count: missingOrderDays.length,
    recovered: recovered.rows.length,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

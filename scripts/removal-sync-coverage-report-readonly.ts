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
  removal_order_upload_success: number;
  removal_order_upload_failed: number;
  removal_order_upload_recovered: number;
  removal_shipment_upload_success: number;
  removal_shipment_upload_failed: number;
  removal_shipment_upload_recovered: number;
  removal_order_rows: number;
  removal_shipment_rows: number;
  expected_package_rows: number;
  expected_package_unresolved_links: number;
  upload_failed_total: number;
  upload_synced_total: number;
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

function pct(covered: number, total: number): string {
  if (total <= 0) return "0.0";
  return ((covered / total) * 100).toFixed(1);
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
       SELECT created_at::date AS day,
              COUNT(*) FILTER (WHERE lower(status) IN ('synced', 'mapped', 'complete'))::int AS success,
              COUNT(*) FILTER (WHERE lower(status) = 'failed')::int AS failed
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = 'REMOVAL_ORDER'
         AND created_at::date >= $2::date AND created_at::date <= $3::date
       GROUP BY 1
     ),
     shipment_uploads AS (
       SELECT created_at::date AS day,
              COUNT(*) FILTER (WHERE lower(status) IN ('synced', 'mapped', 'complete'))::int AS success,
              COUNT(*) FILTER (WHERE lower(status) = 'failed')::int AS failed
       FROM public.raw_report_uploads
       WHERE organization_id = $1::uuid AND report_type = 'REMOVAL_SHIPMENT'
         AND created_at::date >= $2::date AND created_at::date <= $3::date
       GROUP BY 1
     ),
     recovered_events AS (
       SELECT u.created_at::date AS day,
              u.report_type,
              COUNT(*)::int AS c
       FROM public.raw_report_uploads f
       JOIN public.raw_report_uploads u
         ON u.organization_id = f.organization_id
        AND u.report_type = f.report_type
        AND lower(u.status) IN ('synced', 'mapped', 'complete')
        AND u.metadata->'source_run'->>'idempotency_key' = f.metadata->'source_run'->>'idempotency_key'
        AND u.created_at > f.created_at
        AND f.metadata->'source_run'->>'idempotency_key' IS NOT NULL
       WHERE f.organization_id = $1::uuid
         AND f.report_type IN ('REMOVAL_ORDER', 'REMOVAL_SHIPMENT')
         AND lower(f.status) = 'failed'
         AND f.created_at::date >= $2::date
       GROUP BY 1, 2
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
       SELECT COALESCE(order_date::date, created_at::date) AS day, COUNT(*)::int AS c
       FROM public.amazon_removals
       WHERE organization_id = $1::uuid
         AND COALESCE(order_date::date, created_at::date) >= $2::date
         AND COALESCE(order_date::date, created_at::date) <= $3::date
       GROUP BY 1
     ),
     shipments AS (
       SELECT COALESCE(shipment_date::date, order_date::date, created_at::date) AS day, COUNT(*)::int AS c
       FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid
         AND COALESCE(shipment_date::date, order_date::date, created_at::date) >= $2::date
         AND COALESCE(shipment_date::date, order_date::date, created_at::date) <= $3::date
       GROUP BY 1
     ),
     ep AS (
       SELECT COALESCE(
                ars.shipment_date::date,
                ars.order_date::date,
                ep.order_date::date,
                ep.rebuild_run_at::date,
                ep.created_at::date
              ) AS day,
              COUNT(*)::int AS c,
              COUNT(*) FILTER (WHERE ep.resolved_product_id IS NULL)::int AS unresolved
       FROM public.expected_packages ep
       LEFT JOIN public.amazon_removal_shipments ars ON ars.id = ep.source_shipment_row_id
       WHERE ep.organization_id = $1::uuid
         AND ep.build_source IN ('detail_shipment', 'detail_remainder')
         AND COALESCE(
               ars.shipment_date::date,
               ars.order_date::date,
               ep.order_date::date,
               ep.rebuild_run_at::date,
               ep.created_at::date
             ) >= $2::date
         AND COALESCE(
               ars.shipment_date::date,
               ars.order_date::date,
               ep.order_date::date,
               ep.rebuild_run_at::date,
               ep.created_at::date
             ) <= $3::date
       GROUP BY 1
     )
     SELECT
       d.day::text AS day,
       COALESCE(ou.success, 0)::int AS removal_order_upload_success,
       COALESCE(ou.failed, 0)::int AS removal_order_upload_failed,
       COALESCE((SELECT c FROM recovered_events re WHERE re.day = d.day AND re.report_type = 'REMOVAL_ORDER'), 0)::int AS removal_order_upload_recovered,
       COALESCE(su.success, 0)::int AS removal_shipment_upload_success,
       COALESCE(su.failed, 0)::int AS removal_shipment_upload_failed,
       COALESCE((SELECT c FROM recovered_events re WHERE re.day = d.day AND re.report_type = 'REMOVAL_SHIPMENT'), 0)::int AS removal_shipment_upload_recovered,
       COALESCE(r.c, 0)::int AS removal_order_rows,
       COALESCE(sh.c, 0)::int AS removal_shipment_rows,
       COALESCE(e.c, 0)::int AS expected_package_rows,
       COALESCE(e.unresolved, 0)::int AS expected_package_unresolved_links,
       COALESCE(us.failed, 0)::int AS upload_failed_total,
       COALESCE(us.synced, 0)::int AS upload_synced_total
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
    max_ep_source_date: string | null;
    total_unresolved_ep: string;
  }>(
    `SELECT
       (SELECT MAX(COALESCE(order_date::date, created_at::date))::text
        FROM public.amazon_removals WHERE organization_id=$1::uuid) AS max_removal_order_date,
       (SELECT MAX(COALESCE(shipment_date::date, order_date::date, created_at::date))::text
        FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid) AS max_shipment_date,
       (SELECT MAX(COALESCE(
          ars.shipment_date::date,
          ars.order_date::date,
          ep.order_date::date,
          ep.rebuild_run_at::date,
          ep.created_at::date
        ))::text
        FROM public.expected_packages ep
        LEFT JOIN public.amazon_removal_shipments ars ON ars.id = ep.source_shipment_row_id
        WHERE ep.organization_id=$1::uuid
          AND ep.build_source IN ('detail_shipment','detail_remainder')) AS max_ep_source_date,
       (SELECT COUNT(*)::text FROM public.expected_packages
        WHERE organization_id=$1::uuid
          AND build_source IN ('detail_shipment','detail_remainder')
          AND resolved_product_id IS NULL) AS total_unresolved_ep`,
    [ORG_ID],
  );

  const failedImports = await client.query<{ day: string; report_type: string; upload_id: string; status: string }>(
    `SELECT created_at::date::text AS day, report_type, id::text AS upload_id, status
     FROM public.raw_report_uploads
     WHERE organization_id = $1::uuid
       AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
       AND lower(status) = 'failed'
       AND created_at::date >= $2::date
     ORDER BY created_at DESC
     LIMIT 100`,
    [ORG_ID, COVERAGE_START],
  );

  await client.end();

  const rows = daily.rows;
  const totalDays = rows.length;
  const missingOrderDays = rows.filter((r) => r.removal_order_rows === 0).map((r) => r.day);
  const missingShipmentDays = rows.filter((r) => r.removal_shipment_rows === 0).map((r) => r.day);
  const orderNoShipment = rows
    .filter((r) => r.removal_order_rows > 0 && r.removal_shipment_rows === 0)
    .map((r) => r.day);
  const shipmentNoEp = rows
    .filter((r) => r.removal_shipment_rows > 0 && r.expected_package_rows === 0)
    .map((r) => r.day);

  const daysWithOrder = rows.filter((r) => r.removal_order_rows > 0).length;
  const daysWithShipment = rows.filter((r) => r.removal_shipment_rows > 0).length;
  const daysWithEp = rows.filter((r) => r.expected_package_rows > 0).length;

  const lat = latest.rows[0] ?? {};

  const cols = [
    "day",
    "removal_order_upload_success",
    "removal_order_upload_failed",
    "removal_order_upload_recovered",
    "removal_shipment_upload_success",
    "removal_shipment_upload_failed",
    "removal_shipment_upload_recovered",
    "removal_order_rows",
    "removal_shipment_rows",
    "expected_package_rows",
    "expected_package_unresolved_links",
    "upload_failed_total",
    "upload_synced_total",
  ] as const;
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","))].join("\n");
  fs.writeFileSync(path.join(outDir, "coverage.csv"), csv);

  const summary = {
    coverage_start_date: COVERAGE_START,
    coverage_end_date: endDate,
    db_ref: ORIGINAL_REF,
    org_id: ORG_ID,
    store_id: STORE_ID,
    latest_removal_order_date: lat.max_removal_order_date,
    latest_removal_shipment_date: lat.max_shipment_date,
    latest_expected_package_source_date: lat.max_ep_source_date,
    missing_days_order: missingOrderDays,
    missing_days_shipment: missingShipmentDays,
    days_with_order_but_no_shipment: orderNoShipment,
    days_with_shipment_but_no_expected_packages: shipmentNoEp,
    coverage_percent_order: pct(daysWithOrder, totalDays),
    coverage_percent_shipment: pct(daysWithShipment, totalDays),
    coverage_percent_expected_packages: pct(daysWithEp, totalDays),
    total_unresolved_expected_package_links: Number(lat.total_unresolved_ep ?? 0),
    failed_imports_sample: failedImports.rows,
    day_count: totalDays,
  };

  const md = [
    "# Removal sync coverage (original/live)",
    "",
    `Run: \`${id}\` · DB: \`${ORIGINAL_REF}\` · Org: \`${ORG_ID}\` · Store: \`${STORE_ID}\``,
    "",
    "## Window",
    `- Start: **${COVERAGE_START}**`,
    `- End: **${endDate}** (${totalDays} calendar days)`,
    "",
    "## Latest dates",
    `- Latest removal order date: **${lat.max_removal_order_date ?? "—"}**`,
    `- Latest removal shipment date: **${lat.max_shipment_date ?? "—"}**`,
    `- Latest expected_packages source date: **${lat.max_ep_source_date ?? "—"}**`,
    "",
    "## Coverage percentages (days with domain rows ÷ calendar days)",
    `- Order rows (\`amazon_removals\`): **${summary.coverage_percent_order}%** (${daysWithOrder}/${totalDays})`,
    `- Shipment rows (\`amazon_removal_shipments\`): **${summary.coverage_percent_shipment}%** (${daysWithShipment}/${totalDays})`,
    `- Expected packages (derived): **${summary.coverage_percent_expected_packages}%** (${daysWithEp}/${totalDays})`,
    "",
    "## Missing days (no \`amazon_removals\` rows by order date)",
    `- Count: **${missingOrderDays.length}**`,
    missingOrderDays.length
      ? missingOrderDays.map((d) => `- ${d}`).join("\n")
      : "_None_",
    "",
    "## Missing shipment days (no \`amazon_removal_shipments\` rows)",
    `- Count: **${missingShipmentDays.length}**`,
    "",
    "## Days with orders but no shipments",
    `- Count: **${orderNoShipment.length}**`,
    orderNoShipment.length ? orderNoShipment.slice(0, 50).map((d) => `- ${d}`).join("\n") : "_None_",
    "",
    "## Days with shipments but no expected_packages",
    `- Count: **${shipmentNoEp.length}**`,
    shipmentNoEp.length ? shipmentNoEp.slice(0, 50).map((d) => `- ${d}`).join("\n") : "_None_",
    "",
    "## Unresolved expected package product links (current total)",
    `- **${summary.total_unresolved_expected_package_links}** rows with \`resolved_product_id IS NULL\` (detail_shipment / detail_remainder)`,
    "",
    "## Failed imports (recent sample)",
    failedImports.rows.length
      ? failedImports.rows
          .slice(0, 30)
          .map((r) => `- ${r.day} ${r.report_type} \`${r.upload_id.slice(0, 8)}…\` (${r.status})`)
          .join("\n")
      : "_None in window_",
    "",
    "## Daily counts",
    "",
    "| day | ord OK | ord fail | ord recv | shp OK | shp fail | shp recv | orders | shipments | EP | EP unres |",
    "|-----|-------:|---------:|---------:|-------:|---------:|---------:|-------:|----------:|---:|---------:|",
    ...rows.map(
      (r) =>
        `| ${r.day} | ${r.removal_order_upload_success} | ${r.removal_order_upload_failed} | ${r.removal_order_upload_recovered} | ${r.removal_shipment_upload_success} | ${r.removal_shipment_upload_failed} | ${r.removal_shipment_upload_recovered} | ${r.removal_order_rows} | ${r.removal_shipment_rows} | ${r.expected_package_rows} | ${r.expected_package_unresolved_links} |`,
    ),
    "",
    "Full export: `coverage.csv`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "coverage.md"), md);
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`Wrote ${outDir}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

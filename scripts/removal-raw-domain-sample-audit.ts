/**
 * REMOVAL RAW + DOMAIN SAMPLE AUDIT (read-only)
 * npx tsx scripts/removal-raw-domain-sample-audit.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORDER_UPLOAD_ID = "7a7a9a49-7edf-4ace-a77b-b17f9882f8a2";
const SHIPMENT_UPLOAD_ID = "839817be-f65f-4cb8-9fc0-2cda49a3ab67";
const OUT_BASE = ".cursor/audit-reports/removal-raw-domain-sample-audit";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function mdTable(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return "_No rows._\n";
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${cols.map((c) => String(r[c] ?? "").replace(/\|/g, "\\|").slice(0, 80)).join(" | ")} |`)
    .join("\n");
  return `${head}\n${body}\n`;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const connRef = refFromSupabaseUrl(dbUrl) ?? dbUrl.match(/\.([a-z]{20})\./)?.[1] ?? null;

  if (!dbUrl || connRef !== STAGING_REF) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }

  let branch = "unknown";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* ignore */
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const hasStaging = await tableExists(client, "amazon_staging");

  const uploads = await client.query(
    `SELECT id, organization_id, report_type, status, created_at, updated_at,
            metadata->>'sp_api_report_type' AS sp_api_report_type,
            metadata->'source_run'->'archive'->>'object_key' AS storage_object_key,
            metadata->'source_run'->>'data_start_time' AS data_start_time,
            metadata->'source_run'->>'data_end_time' AS data_end_time,
            metadata->'source_run'->>'report_id' AS sp_report_id,
            metadata
     FROM public.raw_report_uploads
     WHERE id = ANY($1::uuid[])`,
    [[ORDER_UPLOAD_ID, SHIPMENT_UPLOAD_ID]],
  );

  const stagingSamples: Record<string, unknown>[] = {};
  if (hasStaging) {
    for (const [label, uploadId] of [
      ["REMOVAL_ORDER", ORDER_UPLOAD_ID],
      ["REMOVAL_SHIPMENT", SHIPMENT_UPLOAD_ID],
    ] as const) {
      const s = await client.query(
        `SELECT id, upload_id, row_number, report_type, source_line_hash,
                left(raw_row::text, 400) AS raw_row_preview,
                created_at
         FROM public.amazon_staging
         WHERE upload_id = $1::uuid
         ORDER BY row_number NULLS LAST, created_at
         LIMIT 10`,
        [uploadId],
      );
      stagingSamples[label] = s.rows;
    }
  }

  const removalCounts = await client.query(
    `SELECT COUNT(*)::int AS total,
            MIN(order_date) AS min_order_date,
            MAX(order_date) AS max_order_date,
            MIN(created_at) AS min_created,
            MAX(created_at) AS max_created
     FROM public.amazon_removals WHERE upload_id = $1::uuid`,
    [ORDER_UPLOAD_ID],
  );

  const shipmentCounts = await client.query(
    `SELECT COUNT(*)::int AS total,
            MIN(order_date) AS min_order_date,
            MAX(order_date) AS max_order_date,
            MIN(shipment_date) AS min_shipment_date,
            MAX(shipment_date) AS max_shipment_date,
            MIN(created_at) AS min_created,
            MAX(created_at) AS max_created
     FROM public.amazon_removal_shipments WHERE upload_id = $1::uuid`,
    [SHIPMENT_UPLOAD_ID],
  );

  const arHasResolved = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removals' AND column_name='resolved_product_id'`,
  );
  const removalSamples = await client.query(
    `SELECT id, upload_id, source_staging_id, organization_id, store_id, order_id, order_type,
            sku, fnsku, disposition, order_date, status,
            requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity,
            ${arHasResolved.rowCount ? "resolved_product_id," : ""}
            left(COALESCE(raw_data::text, ''), 200) AS raw_data_preview
     FROM public.amazon_removals
     WHERE upload_id = $1::uuid
     ORDER BY order_date DESC NULLS LAST, order_id, sku
     LIMIT 10`,
    [ORDER_UPLOAD_ID],
  );

  const shipmentSamples = await client.query(
    `SELECT id, upload_id, amazon_staging_id, organization_id, store_id, order_id, order_type,
            sku, fnsku, disposition, order_date, shipment_date, tracking_number, carrier,
            requested_quantity, shipped_quantity,
            left(COALESCE(raw_row::text, ''), 200) AS raw_row_preview
     FROM public.amazon_removal_shipments
     WHERE upload_id = $1::uuid
     ORDER BY shipment_date DESC NULLS LAST, tracking_number, sku
     LIMIT 10`,
    [SHIPMENT_UPLOAD_ID],
  );

  const epCounts = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE upload_id = $1::uuid)::int AS from_order_upload,
            COUNT(*) FILTER (WHERE upload_id = $2::uuid)::int AS from_shipment_upload,
            COUNT(*) FILTER (WHERE source_detail_row_id IN (
              SELECT id FROM public.amazon_removals WHERE upload_id = $1::uuid
            ))::int AS linked_to_order_domain,
            COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS with_resolved_product
     FROM public.expected_packages ep
     WHERE upload_id = ANY($3::uuid[])
        OR source_detail_row_id IN (SELECT id FROM public.amazon_removals WHERE upload_id = $1::uuid)
        OR source_shipment_row_id IN (SELECT id FROM public.amazon_removal_shipments WHERE upload_id = $2::uuid)`,
    [ORDER_UPLOAD_ID, SHIPMENT_UPLOAD_ID, [ORDER_UPLOAD_ID, SHIPMENT_UPLOAD_ID]],
  );

  const epSamples = await client.query(
    `SELECT ep.id, ep.upload_id, ep.build_source, ep.build_status,
            ep.source_detail_row_id, ep.source_shipment_row_id,
            ep.order_id, ep.sku, ep.fnsku, ep.tracking_number,
            ep.expected_scan_quantity, ep.resolved_product_id,
            ep.identifier_resolution_status
     FROM public.expected_packages ep
     WHERE ep.source_detail_row_id IN (
       SELECT id FROM public.amazon_removals WHERE upload_id = $1::uuid
     )
     ORDER BY ep.order_id, ep.sku, ep.build_source
     LIMIT 10`,
    [ORDER_UPLOAD_ID],
  );

  const epHasProductId = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='expected_packages' AND column_name='product_id'`,
  );

  const lineage = await client.query(
    `SELECT
       u.id AS upload_id,
       u.report_type,
       ar.id AS removal_id,
       ar.order_id,
       ar.sku,
       ar.fnsku,
       ep.id AS expected_package_id,
       ep.build_source,
       ep.source_shipment_row_id,
       ep.expected_scan_quantity,
       ep.resolved_product_id,
       ep.identifier_resolution_status
     FROM public.raw_report_uploads u
     JOIN public.amazon_removals ar ON ar.upload_id = u.id
     LEFT JOIN public.expected_packages ep ON ep.source_detail_row_id = ar.id
     WHERE u.id = $1::uuid
     ORDER BY ar.order_id, ar.sku, ep.build_source NULLS LAST
     LIMIT 10`,
    [ORDER_UPLOAD_ID],
  );

  const lineageShipment = await client.query(
    `SELECT
       u.id AS upload_id,
       u.report_type,
       ars.id AS shipment_id,
       ars.tracking_number,
       ars.sku,
       ep.id AS expected_package_id,
       ep.build_source,
       ar.id AS detail_id,
       ep.resolved_product_id
     FROM public.raw_report_uploads u
     JOIN public.amazon_removal_shipments ars ON ars.upload_id = u.id
     LEFT JOIN public.expected_packages ep ON ep.source_shipment_row_id = ars.id
     LEFT JOIN public.amazon_removals ar ON ar.id = ep.source_detail_row_id
     WHERE u.id = $1::uuid
     ORDER BY ars.shipment_date DESC NULLS LAST
     LIMIT 10`,
    [SHIPMENT_UPLOAD_ID],
  );

  const stagingCounts = hasStaging
    ? await client.query(
        `SELECT upload_id, COUNT(*)::int AS staging_rows
         FROM public.amazon_staging
         WHERE upload_id = ANY($1::uuid[])
         GROUP BY upload_id`,
        [[ORDER_UPLOAD_ID, SHIPMENT_UPLOAD_ID]],
      )
    : { rows: [] };

  await client.end();

  const orderUpload = uploads.rows.find((r) => String(r.id) === ORDER_UPLOAD_ID);
  const shipUpload = uploads.rows.find((r) => String(r.id) === SHIPMENT_UPLOAD_ID);

  const summary = {
    db_ref: STAGING_REF,
    raw_table: "raw_report_uploads",
    raw_payload_storage: hasStaging
      ? "amazon_staging.raw_row (+ Supabase storage raw-reports bucket via metadata.source_run.archive.object_key)"
      : "metadata.source_run.archive.object_key only (amazon_staging missing)",
    domain_tables: ["amazon_removals", "amazon_removal_shipments"],
    derived_table: "expected_packages",
    upload_ids: { REMOVAL_ORDER: ORDER_UPLOAD_ID, REMOVAL_SHIPMENT: SHIPMENT_UPLOAD_ID },
    counts: {
      staging: stagingCounts.rows,
      amazon_removals: removalCounts.rows[0],
      amazon_removal_shipments: shipmentCounts.rows[0],
      expected_packages: epCounts.rows[0],
    },
    sample_row_counts: {
      amazon_staging_order: (stagingSamples.REMOVAL_ORDER as unknown[])?.length ?? 0,
      amazon_staging_shipment: (stagingSamples.REMOVAL_SHIPMENT as unknown[])?.length ?? 0,
      amazon_removals: removalSamples.rows.length,
      amazon_removal_shipments: shipmentSamples.rows.length,
      expected_packages: epSamples.rows.length,
      lineage_order: lineage.rows.length,
      lineage_shipment: lineageShipment.rows.length,
    },
  };

  fs.writeFileSync(path.join(outDir, "raw-uploads.json"), JSON.stringify(uploads.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon-staging-samples.json"), JSON.stringify(stagingSamples, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon-removals-samples.json"), JSON.stringify(removalSamples.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon-removal-shipments-samples.json"), JSON.stringify(shipmentSamples.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "expected-packages-samples.json"), JSON.stringify(epSamples.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "lineage-order.json"), JSON.stringify(lineage.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "lineage-shipment.json"), JSON.stringify(lineageShipment.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "counts-summary.json"), JSON.stringify(summary, null, 2));

  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    [
      "# Removal raw + domain sample audit",
      "",
      `**Run:** \`${runId}\` · **Branch:** \`${branch}\``,
      "",
      "## Database",
      "",
      `- **Ref:** \`${STAGING_REF}\``,
      `- **Raw registry:** \`raw_report_uploads\``,
      `- **Raw line storage:** \`${summary.raw_payload_storage}\``,
      "",
      "## Upload IDs",
      "",
      "| Report | Upload ID | SP-API type |",
      "|--------|-----------|-------------|",
      `| REMOVAL_ORDER | \`${ORDER_UPLOAD_ID}\` | GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA |`,
      `| REMOVAL_SHIPMENT | \`${SHIPMENT_UPLOAD_ID}\` | GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA |`,
      "",
      "## raw_report_uploads",
      "",
      mdTable(
        uploads.rows as Record<string, unknown>[],
        ["id", "report_type", "status", "sp_api_report_type", "data_start_time", "data_end_time", "storage_object_key", "created_at"],
      ),
      "",
      "## Row counts",
      "",
      "| Layer | Count | Date window (order_date) |",
      "|-------|------:|-------------------------|",
      `| amazon_staging (order upload) | ${(stagingCounts.rows as { upload_id: string; staging_rows: number }[]).find((x) => x.upload_id === ORDER_UPLOAD_ID)?.staging_rows ?? "n/a"} | — |`,
      `| amazon_staging (shipment upload) | ${(stagingCounts.rows as { upload_id: string; staging_rows: number }[]).find((x) => x.upload_id === SHIPMENT_UPLOAD_ID)?.staging_rows ?? "n/a"} | — |`,
      `| amazon_removals | ${(removalCounts.rows[0] as { total: number }).total} | ${(removalCounts.rows[0] as { min_order_date: string }).min_order_date} → ${(removalCounts.rows[0] as { max_order_date: string }).max_order_date} |`,
      `| amazon_removal_shipments | ${(shipmentCounts.rows[0] as { total: number }).total} | order: ${(shipmentCounts.rows[0] as { min_order_date: string }).min_order_date} → ${(shipmentCounts.rows[0] as { max_order_date: string }).max_order_date}; ship: ${(shipmentCounts.rows[0] as { min_shipment_date: string }).min_shipment_date} → ${(shipmentCounts.rows[0] as { max_shipment_date: string }).max_shipment_date} |`,
      `| expected_packages (linked) | ${(epCounts.rows[0] as { total: number }).total} | via rebuild lineage |`,
      "",
      "## Lineage (order upload → domain → expected)",
      "",
      mdTable(lineage.rows as Record<string, unknown>[], [
        "upload_id",
        "removal_id",
        "order_id",
        "sku",
        "expected_package_id",
        "build_source",
        "expected_scan_quantity",
        "resolved_product_id",
      ]),
      "",
      "Full JSON: `lineage-order.json`, `lineage-shipment.json`",
    ].join("\n"),
  );

  const manifest = {
    prompt_id: "REMOVAL-RAW-DOMAIN-SAMPLE-AUDIT",
    run_id: runId,
    branch,
    status: "PASS",
    db_ref: STAGING_REF,
    db_touched: false,
    ...summary,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

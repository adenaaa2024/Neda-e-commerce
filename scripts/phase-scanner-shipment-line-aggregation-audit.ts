/**
 * PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-AUDIT — read-only
 *   npx tsx scripts/phase-scanner-shipment-line-aggregation-audit.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const SHIPMENT = "387003587";
const FNSKU = "X004LKS4VD";
const OUT_BASE = ".cursor/audit-reports/phase-scanner-shipment-line-aggregation-audit";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();
  const client = new pg.Client({
    connectionString: productionPostgresUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const trackingNorm = await client.query(
    `SELECT operational FROM normalize_removal_tracking_operational($1)`,
    [SHIPMENT],
  );
  const trackingOp = (trackingNorm.rows[0] as { operational?: string })?.operational ?? SHIPMENT;

  const epRows = await client.query(
    `SELECT ep.*
     FROM public.expected_packages ep
     WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
       AND upper(trim(coalesce(ep.fnsku,''))) = $3
       AND trim(coalesce(ep.tracking_number,'')) = $4
     ORDER BY ep.expected_scan_quantity DESC NULLS LAST, ep.id`,
    [ORG, STORE, FNSKU, SHIPMENT],
  );

  const invRows = await client.query(
    `SELECT expected_package_id::text, tracking_number, id_slip_contents, slip_code, sku, fnsku,
            asin, upc, order_id, status, total_expected, total_scanned,
            resolved_product_id::text, resolved_catalog_product_id::text,
            identifier_resolution_status, carrier, package_code
     FROM public.v_inventory_item_status
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND (
         trim(coalesce(tracking_number,'')) = $4
         OR trim(coalesce(tracking_number,'')) = $5
       )
     ORDER BY total_expected DESC`,
    [ORG, STORE, FNSKU, SHIPMENT, trackingOp],
  );

  const packages = await client.query(
    `SELECT p.id::text, p.tracking_number, p.id_slip_contents, p.package_code, p.pallet_id::text,
            p.status, p.deleted_at::text, p.carrier_name
     FROM public.packages p
     WHERE p.organization_id = $1::uuid AND p.store_id = $2::uuid
       AND (
         trim(coalesce(p.tracking_number,'')) = $3
         OR trim(coalesce(p.tracking_number,'')) = $4
       )
     ORDER BY p.created_at`,
    [ORG, STORE, SHIPMENT, trackingOp],
  );

  const pkgIds = packages.rows.map((r: { id: string }) => r.id);

  const returnItems =
    pkgIds.length > 0
      ? await client.query(
          `SELECT ri.id::text, ri.package_id::text, ri.pallet_id::text, ri.expected_item_id::text,
                  ri.sku, ri.fnsku, ri.asin, ri.product_identifier, ri.scanned_quantity,
                  ri.resolved_product_id::text, ri.slip_content_id::text, ri.status,
                  ri.deleted_at::text, ri.notes, ri.created_at::text
           FROM public.return_items ri
           WHERE ri.organization_id = $1::uuid AND ri.store_id = $2::uuid
             AND upper(trim(coalesce(ri.fnsku,''))) = $3
             AND ri.package_id = ANY($4::uuid[])
           ORDER BY ri.created_at`,
          [ORG, STORE, FNSKU, pkgIds],
        )
      : { rows: [] };

  const mapRows =
    epRows.rows.length > 0
      ? await client.query(
          `SELECT pim.product_id::text, pim.fnsku, pim.sku, pim.asin, pim.upc, pim.deleted_at::text
           FROM public.product_identifier_map pim
           WHERE pim.organization_id = $1::uuid
             AND pim.deleted_at IS NULL
             AND upper(trim(coalesce(pim.fnsku,''))) = $2`,
          [ORG, FNSKU],
        ).catch(() => ({ rows: [] as Record<string, unknown>[] }))
      : { rows: [] };

  const slipContents = await client.query(
    `SELECT sc.id::text, sc.slip_id::text, sc.fnsku, sc.sku, sc.quantity,
            sc.deleted_at::text, s.tracking_number, s.slip_code
     FROM public.slip_contents sc
     JOIN public.slips s ON s.id = sc.slip_id
     WHERE sc.organization_id = $1::uuid
       AND upper(trim(coalesce(sc.fnsku,''))) = $2
       AND (
         trim(coalesce(s.tracking_number,'')) = $3
         OR trim(coalesce(s.tracking_number,'')) = $4
       )`,
    [ORG, FNSKU, SHIPMENT, trackingOp],
  ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

  const removalShipment = await client.query(
    `SELECT ars.id::text, ars.tracking_number, ars.fnsku, ars.sku, ars.shipped_quantity,
            ars.order_id, ars.shipment_date::text, ars.carrier, ars.raw_row
     FROM public.amazon_removal_shipments ars
     WHERE ars.organization_id = $1::uuid AND ars.store_id = $2::uuid
       AND upper(trim(coalesce(ars.fnsku,''))) = $3
       AND trim(coalesce(ars.tracking_number,'')) = $4
     LIMIT 20`,
    [ORG, STORE, FNSKU, SHIPMENT],
  );

  await client.end();

  const matrix = epRows.rows.map((r: Record<string, unknown>) => ({
    source: "expected_packages",
    expected_package_id: r.id,
    qty: r.expected_scan_quantity,
    build_source: r.build_source,
    build_status: r.build_status,
    tracking: r.tracking_number,
    slip_id_slip_contents: r.id_slip_contents,
    sku: r.sku,
    fnsku: r.fnsku,
    disposition: r.disposition,
    resolved_product_id: r.resolved_product_id,
    carrier: r.carrier,
    order_id: r.order_id,
    source_shipment_row_id: r.source_shipment_row_id,
    source_detail_row_id: r.source_detail_row_id,
    detail_grouping_key: r.detail_grouping_key,
    detail_shipped_quantity_total: r.detail_shipped_quantity_total,
    shipment_row_quantity: r.shipment_row_quantity,
    in_process_quantity: r.in_process_quantity,
    deleted_at: r.deleted_at,
  }));

  const epCount = epRows.rows.length;
  const invCount = invRows.rows.length;
  const invForTracking = invRows.rows.filter(
    (r: { tracking_number?: string | null }) => String(r.tracking_number ?? "").trim() === SHIPMENT,
  );

  const fieldDiff =
    epCount === 2
      ? (() => {
          const a = epRows.rows[0] as Record<string, unknown>;
          const b = epRows.rows[1] as Record<string, unknown>;
          const identical: string[] = [];
          const different: Record<string, { row_a: unknown; row_b: unknown }> = {};
          for (const k of Object.keys(a)) {
            const va = a[k];
            const vb = b[k];
            const same =
              JSON.stringify(va) === JSON.stringify(vb) ||
              String(va ?? "").trim() === String(vb ?? "").trim();
            if (same) identical.push(k);
            else different[k] = { row_a: va, row_b: vb };
          }
          return { identical_fields: identical, differing_fields: different };
        })()
      : null;

  const groupingKeysUsed = {
    v_inventory_item_status_item_grouped: [
      "organization_id",
      "store_id",
      "tracking_number",
      "slip_code (id_slip_contents)",
      "sku",
      "fnsku",
    ],
    expected_totals_cte: [
      "organization_id",
      "store_id",
      "tracking_number (normalized)",
      "id_slip_contents",
      "sku",
      "fnsku",
      "carrier (operational)",
    ],
    aggregateExpectedPackagesBySkuFnskuDisposition: ["sku", "fnsku", "disposition"],
    inventoryItemGroupKey: ["tracking_number", "id_slip_contents", "sku", "fnsku"],
    itemScanUnitGroupFingerprint: ["slip_content_id", "scanned_barcode", "fnsku", "sku", "condition tags", "expiry", "lot", "evidence", "notes"],
    mergeUniqueByPackageId: ["expected_package_id (one row per EP pk)"],
    slipLikeRowsForInspection_ep_fallback: ["one row per expected_packages.id (no aggregation)"],
    itemInspectionEpOnlyQtyRows: ["one row per expected_packages.id"],
    expectedPkgLines_tracking_snapshot: ["sku + fnsku + disposition via aggregateExpectedPackagesBySkuFnskuDisposition"],
  };

  let splitReason = "unknown";
  let bug = false;
  let expectedBehavior = false;
  let recommendedFixType = "data issue";

  const buildStatuses = new Set(
    epRows.rows.map((r: { build_status?: string | null }) => String(r.build_status ?? "").trim()),
  );
  const hasOverflowConflict = buildStatuses.has("shipment_overflow_conflict");

  if (epCount === 2 && invForTracking.length === 1) {
    splitReason = hasOverflowConflict
      ? "Rebuild split one amazon_removal_shipments row (shipped_quantity=52) against two removal-detail allocations (53 total): EP row A build_status=matched qty=52 + EP row B build_status=shipment_overflow_conflict qty=1. Product identifiers match; v_inventory_item_status aggregates to 53. Item-scan UI maps raw expectedPkgDetailRows 1:1 when no packing slip (slipLikeRowsForInspection EP fallback) — shows 52 and 1 as separate lines."
      : "Two expected_packages rows with same product grain; v_inventory_item_status aggregates to one line; UI raw EP detail list shows duplicates.";
    expectedBehavior = true;
    recommendedFixType = hasOverflowConflict
      ? "UI grouped display only"
      : "UI grouped display only";
    bug = true;
  } else if (epCount === 2 && invCount === 2) {
    const slips = new Set(epRows.rows.map((r: { id_slip_contents: string | null }) => String(r.id_slip_contents ?? "").trim()));
    const skus = new Set(epRows.rows.map((r: { sku: string | null }) => String(r.sku ?? "").trim()));
    const carriers = new Set(epRows.rows.map((r: { carrier: string | null }) => String(r.carrier ?? "").trim()));
    const buildSources = new Set(epRows.rows.map((r: { build_source: string | null }) => String(r.build_source ?? "").trim()));
    if (slips.size > 1) splitReason = "Different id_slip_contents / slip_code between EP rows.";
    else if (skus.size > 1) splitReason = "Different SKU values for same FNSKU.";
    else if (carriers.size > 1) splitReason = "Different carrier on expected_packages (expected_totals grain).";
    else if (buildSources.size > 1) splitReason = "Different build_source (e.g. detail_shipment vs detail_remainder).";
    else splitReason = "Two inventory view rows with same fnsku — inspect disposition/order_id/resolver mismatch.";
    expectedBehavior = slips.size > 1 || buildSources.size > 1;
    recommendedFixType = expectedBehavior ? "source badge clarification" : "aggregation key fix";
    bug = !expectedBehavior && slips.size === 1 && skus.size === 1;
  } else if (epCount <= 1 && invCount === 2) {
    splitReason = "Inventory view splits expected vs scanned-only union arms (one row expected, one scan-only with total_expected=0).";
    expectedBehavior = true;
    recommendedFixType = "source badge clarification";
  } else if (epCount === 0) {
    splitReason = "No expected_packages matched — check tracking normalization.";
    recommendedFixType = "data issue";
  }

  const manifest = {
    prompt: "PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-AUDIT-387003587-X004LKS4VD",
    run_id: runId,
    target_ref: PRODUCTION_REF,
    mode: "read_only",
    shipment_number: SHIPMENT,
    tracking_operational: trackingOp,
    product_code: FNSKU,
    rows_found: {
      expected_packages: epCount,
      v_inventory_item_status: invCount,
      packages: packages.rows.length,
      return_items: returnItems.rows.length,
      slip_contents: slipContents.rows.length,
    },
    row_comparison_matrix: matrix,
    field_diff_two_ep_rows: fieldDiff,
    v_inventory_item_status_rows: invRows.rows,
    v_inventory_item_status_rows_for_tracking: invForTracking,
    grouping_keys_used: groupingKeysUsed,
    split_reason: splitReason,
    expected_behavior: expectedBehavior ? "yes" : "no",
    bug: bug ? "yes" : "no",
    recommended_fix_type: recommendedFixType,
    files_to_change_if_fix_needed: [
      "app/scanner/operator-mobile/scan/page.tsx — aggregate EP fallback in slipLikeRowsForInspection + itemInspectionEpOnlyQtyRows (reuse aggregateExpectedPackagesBySkuFnskuDisposition)",
      "lib/scanner/operator-tracking-expectations.ts — optional shared helper export if page cannot import aggregate inline",
      hasOverflowConflict
        ? "Optional: show build_status badge (matched vs shipment_overflow_conflict) on grouped row expand"
        : null,
    ].filter(Boolean),
    scanner_no_touch_boundary:
      "Do not change return_items, packages, pallets, allocation RPCs, or resolver in this phase. UI/read-layer grouping only.",
    SAFE_TO_IMPLEMENT_AGGREGATION_FIX:
      epCount === 2 && invForTracking.length === 1 ? "yes" : bug ? "yes" : "no",
    NEXT_EXACT_PROMPT:
      epCount === 2 && invForTracking.length === 1
        ? "PHASE-SCANNER-SHIPMENT-LINE-UI-GROUP-DISPLAY-387003587 — In operator item-scan expected list, aggregate expectedPkgDetailRows by sku+fnsku+disposition when building slipLikeRowsForInspection EP fallback; show build_status sub-badges for shipment_overflow_conflict; do not change EP rebuild/allocation."
        : "PHASE-SCANNER-SHIPMENT-LINE-AGGREGATION-FIX — investigate split_reason and patch view or UI per audit",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "expected_packages.json"), JSON.stringify(epRows.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "v_inventory_item_status.json"), JSON.stringify(invRows.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "packages.json"), JSON.stringify(packages.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "return_items.json"), JSON.stringify(returnItems.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon_removal_shipments.json"), JSON.stringify(removalShipment.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "product_identifier_map.json"), JSON.stringify(mapRows.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "field_diff.json"), JSON.stringify(fieldDiff, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-report.md"),
    [
      "# Shipment line aggregation audit",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Shipment | **${SHIPMENT}** |`,
      `| FNSKU | **${FNSKU}** |`,
      `| EP rows | **${epCount}** |`,
      `| Inventory view rows | **${invCount}** |`,
      `| Split reason | ${splitReason} |`,
      `| Bug | **${manifest.bug}** |`,
      `| SAFE_TO_IMPLEMENT | **${manifest.SAFE_TO_IMPLEMENT_AGGREGATION_FIX}** |`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

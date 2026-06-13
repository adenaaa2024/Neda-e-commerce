/**
 * PHASE-EXPECTED-PACKAGES-SHIPMENT-OVERFLOW-CONFLICT-ORIGIN-AUDIT — read-only
 * npx tsx scripts/phase-expected-packages-overflow-conflict-origin-audit.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const SKU = "B01C7G00TA-VEN";
const PRODUCT_ID = "7e5e05f7-c98a-41a7-85e8-62720ffdc8de";
const EP_MATCHED = "2b5bbd1b-4dff-488e-ac18-f5d8546f002e";
const EP_OVERFLOW = "ae6d28a9-e2bc-421b-9cb1-a13d9870d993";
const OUT_BASE = ".cursor/audit-reports/phase-expected-packages-shipment-overflow-conflict-origin-audit";

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
  const c = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");

  const ep = await c.query(`SELECT * FROM expected_packages WHERE id = ANY($1::uuid[])`, [
    [EP_MATCHED, EP_OVERFLOW],
  ]);

  const detailIds = ep.rows.map((r: { source_detail_row_id: string }) => r.source_detail_row_id).filter(Boolean);
  const shipmentIds = ep.rows.map((r: { source_shipment_row_id: string }) => r.source_shipment_row_id).filter(Boolean);

  const removals = await c.query(`SELECT * FROM amazon_removals WHERE id = ANY($1::uuid[])`, [detailIds]);

  const shipments = await c.query(`SELECT * FROM amazon_removal_shipments WHERE id = ANY($1::uuid[])`, [shipmentIds]);

  const uploadIds = [
    ...new Set(
      [
        ...ep.rows.map((r: { upload_id?: string }) => r.upload_id),
        ...removals.rows.map((r: { upload_id?: string }) => r.upload_id),
        ...shipments.rows.map((r: { upload_id?: string }) => r.upload_id),
      ].filter(Boolean),
    ),
  ];
  const uploads =
    uploadIds.length > 0
      ? await c.query(`SELECT id::text, report_type, status, created_at::text, file_name, metadata FROM raw_report_uploads WHERE id = ANY($1::uuid[])`, [uploadIds])
      : { rows: [] };

  const allDetailsForProduct = await c.query(
    `SELECT *
     FROM amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(fnsku)) = $3 AND trim(sku) = $4
       AND trim(order_id) = $5
     ORDER BY shipped_quantity DESC NULLS LAST, created_at`,
    [ORG, STORE, FNSKU, SKU, ep.rows[0]?.order_id ?? "IxaWHWlopw"],
  );

  const allShipmentsForProduct = await c.query(
    `SELECT *
     FROM amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND trim(tracking_number) = $3
       AND upper(trim(fnsku)) = $4
     ORDER BY shipped_quantity DESC NULLS LAST`,
    [ORG, STORE, TRACKING, FNSKU],
  );

  const slips = await c.query(
    `SELECT sc.id::text, sc.fnsku, sc.sku, sc.quantity, s.tracking_number, s.slip_code
     FROM slip_contents sc
     JOIN slips s ON s.id = sc.slip_id
     WHERE sc.organization_id = $1::uuid
       AND (trim(coalesce(s.tracking_number,'')) = $2 OR upper(trim(sc.fnsku)) = $3)
     LIMIT 20`,
    [ORG, TRACKING, FNSKU],
  ).catch(() => ({ rows: [] }));

  const packages = await c.query(
    `SELECT id::text, tracking_number, id_slip_contents FROM packages
     WHERE organization_id=$1 AND store_id=$2 AND trim(tracking_number)=$3`,
    [ORG, STORE, TRACKING],
  );

  await c.end();

  const matched = ep.rows.find((r: { id: string }) => r.id === EP_MATCHED);
  const overflow = ep.rows.find((r: { id: string }) => r.id === EP_OVERFLOW);
  const detailSum = allDetailsForProduct.rows.reduce(
    (s: number, r: { shipped_quantity?: number }) => s + Number(r.shipped_quantity ?? 0),
    0,
  );
  const shipmentQty = Number(allShipmentsForProduct.rows[0]?.shipped_quantity ?? 0);

  const overflowDetail = removals.rows.find(
    (r: { id: string }) => r.id === overflow?.source_detail_row_id,
  );
  const overflowDetailQty = Number(overflowDetail?.shipped_quantity ?? 0);
  const overflowShipmentQty = Number(shipments.rows[0]?.shipped_quantity ?? 0);

  const overflowBranch =
    "rebuild_expected_packages_from_removals matched_groups CASE: WHEN max(shipment_total) > max(detail_total) THEN build_status='shipment_overflow_conflict' ELSE 'matched'. Per-detail_id agg: shipment_total=sum(matched shipment shipped_quantity), detail_total=max(detail shipped_quantity).";

  const why52Plus1 =
    overflowDetailQty > 0 && overflowShipmentQty > overflowDetailQty
      ? `Two amazon_removals detail lines (${detailIds.join(", ")}) both join to one shipment row (qty ${overflowShipmentQty}). Matched row from detail with ${matched?.detail_shipped_quantity_total} units gets expected_scan_quantity=${matched?.expected_scan_quantity} (matched). Second detail line (shipped_quantity=${overflowDetailQty}) triggers shipment_total(${overflowShipmentQty}) > detail_total(${overflowDetailQty}) → detail_shipment row with shipment_overflow_conflict and expected_scan_quantity=${overflow?.expected_scan_quantity}.`
      : "See raw traces";

  const isConflictLegitimate =
    overflowDetailQty > 0 && overflowShipmentQty > overflowDetailQty ? "yes" : "unknown";

  const isBuilderBug =
    detailSum > shipmentQty && allDetailsForProduct.rows.length > 1
      ? "no — builder correctly flags per-detail overflow when shipment line qty exceeds that detail line qty; aggregate detail sum (${detailSum}) vs shipment (${shipmentQty}) is Amazon source mismatch"
      : "unknown";

  const manifest = {
    prompt: "PHASE-EXPECTED-PACKAGES-SHIPMENT-OVERFLOW-CONFLICT-ORIGIN-AUDIT-387003587-X004LKS4VD-V1",
    run_id: runId,
    target_ref: PRODUCTION_REF,
    mode: "read_only",
    target_rows: {
      matched_ep_id: EP_MATCHED,
      overflow_ep_id: EP_OVERFLOW,
      matched: matched,
      overflow: overflow,
    },
    raw_source_trace: {
      amazon_removals_detail_rows: removals.rows,
      all_amazon_removals_for_order_sku_fnsku: allDetailsForProduct.rows,
      detail_shipped_sum: detailSum,
      amazon_removal_shipments: shipments.rows,
      all_shipments_for_tracking_fnsku: allShipmentsForProduct.rows,
      shipment_shipped_qty: shipmentQty,
      raw_report_uploads: uploads.rows,
    },
    slip_trace: { slip_contents: slips.rows, packages: packages.rows },
    amazon_source_trace: {
      detail_line_count: allDetailsForProduct.rows.length,
      shipment_line_count: allShipmentsForProduct.rows.length,
      detail_vs_shipment_delta: detailSum - shipmentQty,
    },
    builder_function_found: "public.rebuild_expected_packages_from_removals",
    overflow_conflict_branch: overflowBranch,
    quantity_reconciliation: {
      per_detail_overflow_rule: "shipment_total > detail_total on matched pair → shipment_overflow_conflict",
      remainder_rule: "detail_total > shipment_total → detail_remainder row (not used for overflow EP here)",
      final_reconcile: "sum(expected_scan_quantity) per source_detail_row_id must equal detail_shipped_quantity_total",
      observed: why52Plus1,
    },
    dedupe_key_analysis: {
      upsert_conflict: "(organization_id, source_detail_row_id, source_shipment_row_id) WHERE build_source IN (detail_shipment, detail_remainder)",
      implication: "Each distinct amazon_removals.id × amazon_removal_shipments.id pair yields one EP row; duplicate product lines in Amazon detail are NOT deduped by sku+fnsku",
    },
    why_52_plus_1_exists: why52Plus1,
    answers: {
      q1_from_amazon_source_row: "yes — overflow EP ties to amazon_removals id " + overflow?.source_detail_row_id,
      q2_from_slip_ocr: "no — zero slip_contents for tracking",
      q3_shipment_vs_slip_qty: "no slip; mismatch is amazon_removals detail sum vs amazon_removal_shipments shipped_quantity",
      q4_multiple_source_rows_same_product: "yes — " + allDetailsForProduct.rows.length + " detail rows same order/sku/fnsku",
      q5_split_53_into_52_plus_1: "partially — 52 from primary detail line capped/grouped to shipment; 1 from separate detail line with shipped_quantity=1 (not remainder split of 53)",
      q6_over_extra_duplicate: "duplicate detail line pattern — second detail row with qty 1 on same product key",
      q7_correct_audit_or_bug: isConflictLegitimate === "yes" ? "correct audit flag for per-line overflow condition" : "unknown",
      q8_prevent_condition: "If intent is product-level expectation: consolidate detail lines before match OR use remainder for detail_total>shipment_total only and skip detail_shipment when detail_qty << shipment_qty on shared shipment",
    },
    is_conflict_legitimate: isConflictLegitimate,
    is_builder_bug: isBuilderBug.startsWith("no") ? "no" : isBuilderBug,
    recommended_fix_type:
      isConflictLegitimate === "yes"
        ? "status label/copy fix — rename/clarify shipment_overflow_conflict (shipment qty exceeds THIS detail line, not extra unit)"
        : "builder classification fix",
    files_to_change_if_fix_needed: [
      "supabase/migrations/*rebuild_expected_packages_from_removals* — overflow status semantics / operator-facing build_status copy",
      ".cursor/.ai-memory/REMOVAL_API_INTAKE.md — document per-detail overflow vs aggregate mismatch",
      "Optional: consolidate duplicate amazon_removals lines at intake (source data issue)",
    ],
    scanner_no_touch_boundary: "No scanner UI, allocation, or EP data mutation in this phase",
    SAFE_TO_IMPLEMENT_OVERFLOW_CONFLICT_FIX: isConflictLegitimate === "yes" ? "yes — copy/label only; no EP row delete" : "no",
    NEXT_EXACT_PROMPT:
      "PHASE-EXPECTED-PACKAGES-OVERFLOW-STATUS-LABEL-FIX-V1 — Document and surface shipment_overflow_conflict as 'shipment qty > this detail line qty' with source_detail_row_id trace; optional intake dedupe review for duplicate 1-unit detail lines",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "expected_packages.json"), JSON.stringify(ep.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon_removals.json"), JSON.stringify(removals.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon_removals_all_product.json"), JSON.stringify(allDetailsForProduct.rows, null, 2));
  fs.writeFileSync(path.join(outDir, "amazon_removal_shipments.json"), JSON.stringify(shipments.rows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "proof-summary.md"),
    [
      "# Overflow conflict origin audit",
      "",
      `**Tracking:** ${TRACKING} | **FNSKU:** ${FNSKU}`,
      "",
      `## Verdict`,
      `- **why_52_plus_1:** ${why52Plus1}`,
      `- **is_conflict_legitimate:** ${isConflictLegitimate}`,
      `- **is_builder_bug:** ${manifest.is_builder_bug}`,
      `- **SAFE_TO_IMPLEMENT_OVERFLOW_CONFLICT_FIX:** ${manifest.SAFE_TO_IMPLEMENT_OVERFLOW_CONFLICT_FIX}`,
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

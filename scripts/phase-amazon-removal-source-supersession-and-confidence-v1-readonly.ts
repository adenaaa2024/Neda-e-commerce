/**
 * PHASE-AMAZON-REMOVAL-SOURCE-SUPERSESSION-AND-CONFIDENCE-V1 — read-only audit
 *   npx tsx scripts/phase-amazon-removal-source-supersession-and-confidence-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  CLEAN_QUANTITY_RULE,
  DISPUTED_QUANTITY_RULE,
  REMOVAL_SOURCE_SUPERSESSION_RULES,
  buildRemovalSupersessionReadinessSummary,
  classifyAllRemovalDetailRows,
  filterExpectedPackagesWithRemovalSupersession,
  groupRemovalDetailsByScope,
  removalDetailScopeKey,
  resolveRemovalScopeTruth,
  type RemovalDetailRowLike,
  type RemovalShipmentRowLike,
} from "../lib/claims/removal/removal-source-supersession-readmodel";
import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-amazon-removal-source-supersession-and-confidence-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "387003587";
const FNSKU = "X004LKS4VD";
const TRACE_ORDER = "IxaWHWlopw";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function stagingPostgresUrl(): string {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url.includes(STAGING_REF)) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }
  return url;
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  getStagingProjectRef();

  const client = new pg.Client({ connectionString: stagingPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const detailsRes = await client.query(
    `SELECT ar.id::text, ar.organization_id::text, ar.store_id::text,
            ar.order_id, ar.sku, ar.fnsku, ar.disposition, ar.order_type,
            ar.shipped_quantity, ar.in_process_quantity, ar.requested_quantity,
            ar.tracking_number, ar.upload_id::text, ar.created_at::text,
            rru.created_at::text AS upload_created_at, rru.report_type, rru.file_name
     FROM public.amazon_removals ar
     LEFT JOIN public.raw_report_uploads rru ON rru.id = ar.upload_id
     WHERE ar.organization_id = $1::uuid AND ar.store_id = $2::uuid
     ORDER BY ar.order_id, ar.fnsku, ar.created_at`,
    [ORG, STORE],
  );

  const shipmentsRes = await client.query(
    `SELECT id::text, order_id, sku, fnsku, disposition, tracking_number,
            shipped_quantity, upload_id::text, created_at::text
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [ORG, STORE],
  );

  const dupScopesRes = await client.query(
    `SELECT organization_id::text, store_id::text, order_id,
            upper(trim(coalesce(fnsku,''))) AS fnsku_norm,
            trim(coalesce(sku,'')) AS sku_norm,
            coalesce(trim(disposition),'') AS disposition_norm,
            coalesce(trim(order_type),'') AS order_type_norm,
            COUNT(*)::int AS row_count
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
     GROUP BY 1,2,3,4,5,6,7
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC
     LIMIT 200`,
    [ORG, STORE],
  );

  const partialRes = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM public.amazon_removals
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND coalesce(in_process_quantity, 0) > 0`,
    [ORG, STORE],
  );

  await client.end();

  const X004LKS4VD_trace = await loadProductionTrace();

  const details = detailsRes.rows as RemovalDetailRowLike[];
  const shipments = shipmentsRes.rows as RemovalShipmentRowLike[];
  const classified = classifyAllRemovalDetailRows(details);
  const summary = buildRemovalSupersessionReadinessSummary(details, shipments, { sample_limit: 10 });

  const groups = groupRemovalDetailsByScope(details);
  const duplicateExamples: Array<Record<string, unknown>> = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const truth = resolveRemovalScopeTruth(group, shipments, {
      tracking_number: group[0]?.tracking_number,
    });
    duplicateExamples.push({
      scope_key: removalDetailScopeKey(group[0]!),
      row_count: group.length,
      truth_class: truth.truth_class,
      source_mismatch: truth.source_mismatch,
      clean_quantity: truth.clean_quantity,
      disputed_quantity: truth.disputed_quantity,
      primary_detail_id: truth.primary_detail_id,
      physical_shipment_qty: truth.physical_shipment_qty,
      rows: truth.detail_rows.map((r) => ({
        id: r.id,
        shipped_quantity: r.shipped_quantity,
        in_process_quantity: r.in_process_quantity,
        tracking_number: r.tracking_number,
        supersession_class: r.supersession_class,
        confidence: r.confidence,
        upload_created_at: r.upload_created_at,
      })),
    });
    if (duplicateExamples.length >= 15) break;
  }

  const claimFilter = filterExpectedPackagesWithRemovalSupersession(
    (X004LKS4VD_trace.expected_packages as Record<string, unknown>[]).map((r) => ({
      id: String(r.id ?? ""),
      build_status: String(r.build_status ?? ""),
      expected_scan_quantity: Number(r.expected_scan_quantity ?? 0),
      tracking_number: String(r.tracking_number ?? ""),
      fnsku: String(r.fnsku ?? ""),
      sku: String(r.sku ?? ""),
      source_detail_row_id: String(r.source_detail_row_id ?? ""),
    })),
  );

  const affected_row_count = classified.filter(
    (r) => r.supersession_class !== "current" || r.is_partial_snapshot,
  ).length;

  const manifest = {
    prompt: "PHASE-AMAZON-REMOVAL-SOURCE-SUPERSESSION-AND-CONFIDENCE-V1",
    run_id: rid,
    target_ref: STAGING_REF,
    trace_ref: (X004LKS4VD_trace.trace_ref as string) ?? PRODUCTION_REF,
    mode: "read_only",
    supersession_rules: REMOVAL_SOURCE_SUPERSESSION_RULES,
    clean_quantity_rule: CLEAN_QUANTITY_RULE,
    disputed_quantity_rule: DISPUTED_QUANTITY_RULE,
    affected_row_count,
    duplicate_scope_group_count: dupScopesRes.rows.length,
    partial_in_process_row_count: partialRes.rows[0]?.cnt ?? 0,
    classification_counts: summary.classification_counts,
    examples: duplicateExamples.slice(0, 10),
    X004LKS4VD_trace,
    current_vs_superseded_rows: X004LKS4VD_trace.current_vs_superseded_rows,
    claim_ready_filter_result: claimFilter,
    read_model_fields_added: [
      "removal_source_supersession on SourceConnectorReadinessPayload",
      "removal_source_supersession_payload on GET /api/claims/center/sources",
      "ClassifiedRemovalDetail.supersession_class | confidence | superseded_by_id",
      "RemovalScopeTruthResult.source_mismatch | clean_quantity | disputed_quantity",
    ],
    no_db_write_verification: true,
    no_scanner_change_verification: true,
    no_expected_packages_mutation: true,
    no_allocation_logic_change: true,
    SAFE_TO_PUSH: "pending_build",
    NEXT_PROMPT:
      "PHASE-REMOVAL-SUPERSESSION-CLAIM-GENERATOR-GATE-V1 — wire filterRemovalDetailsForClaimGeneration + epRowIsClaimReadyWithSupersession into amazon_removal_api generator; still no EP rebuild",
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "X004LKS4VD_trace.json"), JSON.stringify(X004LKS4VD_trace, null, 2));
  fs.writeFileSync(
    path.join(outDir, "supersession-checklist.md"),
    [
      "# Removal source supersession V1",
      "",
      `**Run:** ${rid} | **Ref:** ${STAGING_REF}`,
      "",
      "## Counts",
      `- Affected detail rows: **${affected_row_count}**`,
      `- Duplicate scope groups: **${dupScopesRes.rows.length}**`,
      `- in_process > 0 rows: **${partialRes.rows[0]?.cnt ?? 0}**`,
      "",
      "## X004LKS4VD / 387003587",
      `- Clean qty (read-model): **${X004LKS4VD_trace.scope_truth.clean_quantity}**`,
      `- Disputed qty: **${X004LKS4VD_trace.scope_truth.disputed_quantity}**`,
      `- Source mismatch: **${X004LKS4VD_trace.scope_truth.source_mismatch}**`,
      `- Claim-ready EP qty sum: **${claimFilter.claim_ready_qty_sum}**`,
      "",
      "## SAFE_TO_PUSH",
      "See summary.json after build+smoke",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

async function loadProductionTrace(): Promise<Record<string, unknown>> {
  bindProductionSupabaseEnv();
  const pc = new pg.Client({ connectionString: productionPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await pc.connect();
  await pc.query("SET statement_timeout = '120s'");

  const orderDetails = await pc.query(
    `SELECT ar.id::text, ar.order_id, ar.sku, ar.fnsku, ar.disposition, ar.order_type,
            ar.shipped_quantity, ar.in_process_quantity, ar.tracking_number,
            ar.upload_id::text, ar.created_at::text,
            rru.created_at::text AS upload_created_at, rru.report_type, rru.file_name
     FROM public.amazon_removals ar
     LEFT JOIN public.raw_report_uploads rru ON rru.id = ar.upload_id
     WHERE ar.organization_id = $1::uuid AND ar.store_id = $2::uuid
       AND upper(trim(coalesce(ar.fnsku,''))) = $3
       AND trim(coalesce(ar.order_id,'')) = $4
     ORDER BY rru.created_at DESC NULLS LAST, ar.shipped_quantity DESC`,
    [ORG, STORE, FNSKU, TRACE_ORDER],
  );

  const traceShipments = await pc.query(
    `SELECT id::text, order_id, sku, fnsku, disposition, tracking_number,
            shipped_quantity, upload_id::text, created_at::text
     FROM public.amazon_removal_shipments
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4`,
    [ORG, STORE, FNSKU, TRACKING],
  );

  const epRes = await pc.query(
    `SELECT id::text, tracking_number, fnsku, sku, order_id,
            expected_scan_quantity, build_status, build_source,
            source_detail_row_id::text, source_shipment_row_id::text,
            detail_shipped_quantity_total, shipment_row_quantity, in_process_quantity
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(trim(coalesce(fnsku,''))) = $3
       AND trim(coalesce(tracking_number,'')) = $4
     ORDER BY expected_scan_quantity DESC`,
    [ORG, STORE, FNSKU, TRACKING],
  );

  await pc.end();

  const detailRows = orderDetails.rows as RemovalDetailRowLike[];
  const shipmentRows = traceShipments.rows as RemovalShipmentRowLike[];
  const classified = classifyAllRemovalDetailRows(detailRows);
  const scopeTruth = resolveRemovalScopeTruth(detailRows, shipmentRows, { tracking_number: TRACKING });

  return {
    trace_ref: PRODUCTION_REF,
    tracking_number: TRACKING,
    fnsku: FNSKU,
    order_id: TRACE_ORDER,
    amazon_removals_rows: orderDetails.rows,
    amazon_removal_shipments_rows: traceShipments.rows,
    scope_truth: scopeTruth,
    expected_packages: epRes.rows,
    current_vs_superseded_rows: classified.map((r) => ({
      id: r.id,
      shipped_quantity: r.shipped_quantity,
      in_process_quantity: r.in_process_quantity,
      upload_created_at: r.upload_created_at,
      supersession_class: r.supersession_class,
      confidence: r.confidence,
      superseded_by_id: r.superseded_by_id,
    })),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

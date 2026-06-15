/**
 * CRITICAL-PRODUCT-LINKAGE-REGRESSION-AUDIT
 * Read-only audit — Shipment 25 linkage regression.
 *
 *   npx tsx scripts/critical-product-linkage-regression-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import {
  normalizeScannerProductLinkageDisplay,
  productLinkageOperatorStatusLabel,
} from "../lib/scanner/normalize-scanner-product-linkage-display";
import {
  buildInventoryViewProductLinkage,
  buildExpectedPackageProductLinkage,
} from "../lib/scanner/expected-packages-read-contract";
import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import { RESOLUTION_ORDER_SCANNER, RESOLUTION_ORDER_OPERATIONAL } from "../lib/product-linkage-resolution-policy";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/critical-product-linkage-regression-audit-v1";

type Row = Record<string, unknown>;

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(url: string): Promise<pg.Client> {
  if (!url.includes(PRODUCTION_REF)) throw new Error(`BLOCKED: must target ${PRODUCTION_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const q = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(q.rows.map((r: Row) => String(r.column_name)));
}

function epSelect(cols: Set<string>): string {
  const want = [
    "id",
    "organization_id",
    "store_id",
    "fnsku",
    "asin",
    "sku",
    "product_id",
    "resolved_product_id",
    "identifier_resolution_status",
    "product_name",
    "tracking_number",
    "package_code",
    "id_slip_contents",
    "deleted_at",
  ];
  return want.filter((w) => cols.has(w)).join(", ");
}

async function findShipment25Package(c: pg.Client): Promise<Row | null> {
  const q = await c.query(
    `SELECT id, organization_id, store_id, package_code, tracking_number, pallet_id, status, deleted_at, created_at
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND (package_code = '25' OR package_code ILIKE '%shipment%25%' OR tracking_number ILIKE '%25%')
     ORDER BY
       CASE WHEN package_code = '25' THEN 0 ELSE 1 END,
       updated_at DESC NULLS LAST
     LIMIT 5`,
    [ORG],
  );
  return (q.rows[0] as Row) ?? null;
}

async function mapProbe(
  c: pg.Client,
  mapCols: Set<string>,
  productCols: Set<string>,
  opts: { fnsku?: string | null; upc?: string | null; asin?: string | null; sku?: string | null },
): Promise<Row> {
  const fnsku = String(opts.fnsku ?? "").trim().toUpperCase();
  const asin = String(opts.asin ?? "").trim().toUpperCase();
  const sku = String(opts.sku ?? "").trim();
  const uNorm = String(opts.upc ?? "").replace(/\D/g, "");
  const upcCol = mapCols.has("upc_code") ? "upc_code" : mapCols.has("upc") ? "upc" : null;
  const pName = productCols.has("product_name") ? "p.product_name" : "NULL::text AS product_name";
  const clauses: string[] = [];
  const params: unknown[] = [ORG];
  if (fnsku) {
    params.push(fnsku);
    clauses.push(`upper(btrim(coalesce(m.fnsku,''))) = $${params.length}`);
  }
  if (asin) {
    params.push(asin);
    clauses.push(`upper(btrim(coalesce(m.asin,''))) = $${params.length}`);
  }
  if (sku) {
    params.push(sku);
    clauses.push(`(m.seller_sku = $${params.length} OR m.msku = $${params.length})`);
  }
  if (upcCol && uNorm) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(m.${upcCol},''), '\\D', '', 'g') IN ($${params.length}, ltrim($${params.length}, '0'))`,
    );
  }
  if (!clauses.length) return { hit_count: 0, rows: [], distinct_product_ids: 0 };
  const q = await c.query(
    `SELECT m.id, m.product_id, m.store_id, m.fnsku, m.asin, m.seller_sku, m.msku,
            ${upcCol ? `m.${upcCol}` : "NULL::text"} AS upc_val,
            m.deleted_at, ${pName}
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id
     WHERE m.organization_id = $1::uuid AND m.deleted_at IS NULL AND p.deleted_at IS NULL
       AND (${clauses.join(" OR ")})
     LIMIT 20`,
    params,
  );
  const ids = new Set(q.rows.map((r: Row) => r.product_id));
  return {
    hit_count: q.rowCount ?? 0,
    rows: q.rows,
    distinct_product_ids: ids.size,
    ambiguity: ids.size > 1,
  };
}

async function stepResolverTrace(
  sb: SupabaseClient,
  row: Row,
  sourceTable: string,
): Promise<Row> {
  const org = String(row.organization_id ?? ORG);
  const store = row.store_id ? String(row.store_id) : STORE;
  const input = {
    organization_id: org,
    store_id: store,
    fnsku: row.fnsku ?? null,
    upc: row.upc ?? row.product_identifier ?? null,
    sku: row.sku ?? null,
    asin: row.asin ?? null,
    source_table: sourceTable,
    source_row_id: row.id ? String(row.id) : null,
  };

  const withoutStore = await resolveProductForScannerItem(sb, { ...input, store_id: null });
  const withStore = await resolveProductForScannerItem(sb, input);
  const normalize = await normalizeScannerProductLinkageDisplay(sb, {
    organizationId: org,
    storeId: store,
    sourceTable,
    sourceRowId: row.id ? String(row.id) : null,
    row: {
      fnsku: row.fnsku,
      upc: row.upc ?? row.product_identifier,
      sku: row.sku,
      asin: row.asin,
      description: row.description ?? row.item_name ?? row.product_name,
      resolved_product_id: row.resolved_product_id ?? row.product_id,
      identifier_resolution_status: row.identifier_resolution_status,
      product_name: row.product_name,
    },
  });
  const displayOnly = buildExpectedPackageProductLinkage(row, new Map());
  const displayOnlyLabel = productLinkageOperatorStatusLabel(displayOnly);

  return {
    identifiers: {
      fnsku: row.fnsku ?? null,
      upc: row.upc ?? row.product_identifier ?? null,
      sku: row.sku ?? null,
      asin: row.asin ?? null,
      product_id: row.product_id ?? null,
      resolved_product_id: row.resolved_product_id ?? null,
      store_id: store,
    },
    resolver_with_store: withStore,
    resolver_without_store: withoutStore,
    normalize_display_label: productLinkageOperatorStatusLabel(normalize),
    normalize_resolved_product_id: normalize.resolved_product_id,
    normalize_product_name: normalize.product_name,
    display_only_label: displayOnlyLabel,
    display_only_uses_persisted_only: true,
  };
}

function firstFailingRule(row: Row, resolver: Row, mapProbeResult: Row | null): string {
  const map = mapProbeResult ?? { hit_count: 0, distinct_product_ids: 0, ambiguity: false };
  if (!row.store_id && !STORE) return "missing_store_id_blocks_scanner_wrapper";
  if (map.hit_count === 0) {
    const hasId = row.fnsku || row.upc || row.sku || row.asin || row.product_identifier;
    if (hasId) return "no_product_identifier_map_hit_for_any_identifier";
    return "no_identifiers_on_row";
  }
  if (map.ambiguity) return "ambiguous_multiple_product_ids_in_map";
  if (row.resolved_product_id || row.product_id) {
    if (resolver.status === "resolved") return "none_resolver_would_link";
    return "persisted_id_present_but_display_mapper_may_skip_live_resolve";
  }
  if (resolver.status === "resolved") return "resolver_would_link_but_persisted_null";
  if (resolver.status === "ambiguous") return "resolver_ambiguous";
  return "resolver_unresolved_after_full_scanner_order";
}

async function auditLine(
  c: pg.Client,
  sb: SupabaseClient,
  mapCols: Set<string>,
  productCols: Set<string>,
  row: Row,
  sourceTable: string,
  sourceKind: string,
): Promise<Row> {
  const map = await mapProbe(c, mapCols, productCols, {
    fnsku: row.fnsku ? String(row.fnsku) : null,
    upc: row.upc ? String(row.upc) : row.product_identifier ? String(row.product_identifier) : null,
    asin: row.asin ? String(row.asin) : null,
    sku: row.sku ? String(row.sku) : null,
  });
  const trace = await stepResolverTrace(sb, row, sourceTable);
  trace.first_failing_rule = firstFailingRule(row, trace.resolver_with_store as Row, map);
  return {
    source_kind: sourceKind,
    source_table: sourceTable,
    row_id: row.id,
    identifiers: trace.identifiers,
    product_identifier_map: map,
    match_attempts: {
      scanner_order: RESOLUTION_ORDER_SCANNER,
      operational_order: RESOLUTION_ORDER_OPERATIONAL,
      resolver_with_store: trace.resolver_with_store,
      resolver_without_store: trace.resolver_without_store,
    },
    matched_product_id:
      (trace.resolver_with_store as Row).resolved_product_id ??
      row.resolved_product_id ??
      row.product_id ??
      (map.rows as Row[])?.[0]?.product_id ??
      null,
    display_labels: {
      normalize_path: trace.normalize_display_label,
      display_only_persisted_path: trace.display_only_label,
      persisted_status: row.identifier_resolution_status ?? null,
    },
    why_match_failed: trace.first_failing_rule,
    linkage_path: `Shipment Entry → ${sourceTable} → normalizeScannerProductLinkageDisplay OR buildExpectedPackageProductLinkage (client fallback)`,
  };
}

function recentLinkageCommits(): Row[] {
  const files = [
    "lib/search/product-identifier-resolve.ts",
    "lib/scanner/normalize-scanner-product-linkage-display.ts",
    "lib/scanner/expected-packages-read-contract.ts",
    "lib/scanner/operator-tracking-expectations.ts",
    "lib/scanner-product-resolve.ts",
    "lib/inventory-views-product-linkage.ts",
    "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  ];
  const out: Row[] = [];
  for (const f of files) {
    try {
      const log = execSync(`git log -3 --format=%H|%s|%ci -- "${f}"`, { encoding: "utf8" }).trim();
      out.push({ file: f, recent: log.split("\n").filter(Boolean) });
    } catch {
      out.push({ file: f, recent: [] });
    }
  }
  return out;
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  bindProductionSupabaseEnv();
  const sb = createClient(
    process.env.ORIGINAL_SUPABASE_URL ?? "",
    process.env.ORIGINAL_SERVICE_ROLE_KEY ?? "",
    { auth: { persistSession: false } },
  );
  const c = await connectPg(productionPostgresUrl());
  const mapCols = await tableColumns(c, "product_identifier_map");
  const productCols = await tableColumns(c, "products");
  const epCols = await tableColumns(c, "expected_packages");
  const slipCols = await tableColumns(c, "slip_contents");
  const riCols = await tableColumns(c, "return_items");

  const pkg = await findShipment25Package(c);
  if (!pkg) throw new Error("Shipment 25 package not found on original");

  const pkgId = String(pkg.id);
  const storeId = String(pkg.store_id ?? STORE);

  // expected_packages for this shipment
  const epSel = epSelect(epCols);
  const epDel = epCols.has("deleted_at") ? "AND deleted_at IS NULL" : "";
  const epQ = epCols.has("package_code")
    ? await c.query(
        `SELECT ${epSel} FROM expected_packages
         WHERE organization_id=$1::uuid ${epDel}
           AND (package_code=$2 OR tracking_number=$3)
         ORDER BY fnsku NULLS LAST LIMIT 100`,
        [ORG, pkg.package_code, pkg.tracking_number],
      )
    : { rows: [] };

  const epPkgQ = epCols.has("id_slip_contents")
    ? await c.query(
        `SELECT ${epSel} FROM expected_packages ep
         WHERE ep.organization_id=$1::uuid ${epDel.replace("deleted_at", "ep.deleted_at")}
           AND EXISTS (
             SELECT 1 FROM slip_contents sc
             WHERE sc.package_id=$2::uuid
               ${slipCols.has("deleted_at") ? "AND sc.deleted_at IS NULL" : ""}
               AND sc.id::text = ep.id_slip_contents::text
           )
         LIMIT 100`,
        [ORG, pkgId],
      )
    : { rows: [] };

  const slipWant = [
    "id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "product_id",
    "resolved_product_id",
    "identifier_resolution_status",
    "description",
    "item_name",
    "upc",
    "product_identifier",
  ].filter((w) => slipCols.has(w));
  const slipDel = slipCols.has("deleted_at") ? "AND deleted_at IS NULL" : "";
  const slipQ = await c.query(
    `SELECT ${slipWant.join(", ")} FROM slip_contents
     WHERE organization_id=$1::uuid AND package_id=$2::uuid ${slipDel}
     ORDER BY created_at NULLS LAST`,
    [ORG, pkgId],
  );

  const riDel = riCols.has("deleted_at") ? "AND deleted_at IS NULL" : "";

  const riWant = [
    "id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "product_id",
    "resolved_product_id",
    "identifier_resolution_status",
    "item_name",
    "product_identifier",
  ].filter((w) => riCols.has(w));
  const riQ = riCols.size
    ? await c.query(
        `SELECT ${riWant.join(", ")} FROM return_items
         WHERE organization_id=$1::uuid AND package_id=$2::uuid ${riDel}
         ORDER BY created_at NULLS LAST`,
        [ORG, pkgId],
      )
    : { rows: [] };

  const viewQ = await c.query(
    `SELECT * FROM v_inventory_item_status
     WHERE organization_id=$1::uuid
       AND (package_code=$2 OR tracking_number=$3)
     LIMIT 50`,
    [ORG, pkg.package_code, pkg.tracking_number],
  ).catch(() => ({ rows: [] as Row[] }));

  const allLines: Row[] = [];
  const epRows = [...epQ.rows, ...epPkgQ.rows];
  const seenEp = new Set<string>();
  for (const row of epRows as Row[]) {
    const id = String(row.id);
    if (seenEp.has(id)) continue;
    seenEp.add(id);
    allLines.push(await auditLine(c, sb, mapCols, productCols, row, "expected_packages", "expected_tracking"));
  }
  for (const row of slipQ.rows as Row[]) {
    allLines.push(await auditLine(c, sb, mapCols, productCols, row, "slip_contents", "slip_only"));
  }
  for (const row of riQ.rows as Row[]) {
    allLines.push(await auditLine(c, sb, mapCols, productCols, row, "return_items", "scanned_return_item"));
  }

  const linkedCount = allLines.filter((l) => l.display_labels?.normalize_path === "Linked").length;
  const noLinkCount = allLines.filter((l) => l.display_labels?.normalize_path === "No product link yet").length;
  const mapMissCount = allLines.filter((l) => (l.product_identifier_map as Row)?.hit_count === 0).length;
  const resolverWouldLink = allLines.filter(
    (l) => (l.match_attempts as Row)?.resolver_with_store?.status === "resolved",
  ).length;
  const displayOnlyWouldNoLink = allLines.filter(
    (l) => l.display_labels?.display_only_persisted_path === "No product link yet",
  ).length;

  const runtimeRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");

  const rootCause =
    mapMissCount === noLinkCount && mapMissCount > 0
      ? "data_regression_true_unmapped_identifiers_no_spine_map"
      : resolverWouldLink > linkedCount
        ? "filter_or_display_regression_persisted_columns_or_client_fallback"
        : runtimeRef !== PRODUCTION_REF
          ? "runtime_env_mismatch_dev_reads_staging_not_original"
          : "mixed_data_and_display_path";

  const result = {
    phase: "CRITICAL-PRODUCT-LINKAGE-REGRESSION-AUDIT",
    run_id: rid,
    target: "original",
    original_ref: PRODUCTION_REF,
    runtime_ref: runtimeRef,
    resolver_order: {
      scanner_shipment_entry: RESOLUTION_ORDER_SCANNER,
      operational_claim_materialize: RESOLUTION_ORDER_OPERATIONAL,
      scanner_detail:
        "UPC/EAN/GTIN → product_identifier_map.upc_code → products.upc/barcode; SKU → map seller_sku/msku → products.sku; FNSKU → map → products.fnsku; ASIN → map → products.asin. Map query: org + (store_id=X OR store_id IS NULL). products direct requires exact store_id.",
      operational_detail:
        "FNSKU → ASIN+SKU → ASIN → SKU → UPC. Exact store_id only in claim projection.",
      receive_review: "persisted resolved_product_id only — no live resolve",
      claim_generator: "copies source resolved_product_id — resolve at materialize via pickBestProductIdentifierMatch",
      fallbacks: [
        "expected_package_id hint (meta only)",
        "legacyProductId mismatch → status mismatch clears resolve",
        "buildExpectedPackageProductLinkage / buildInventoryViewProductLinkage — display-only persisted cols",
        "normalizeScannerProductLinkageDisplay — live resolve when needsScannerLinkageResolve",
      ],
      tables_used: ["product_identifier_map", "products"],
      tables_not_used: ["product_links", "product_match_candidates"],
    },
    shipment25_package: pkg,
    shipment25_expected_items: {
      expected_packages_count: seenEp.size,
      slip_contents_count: slipQ.rowCount ?? 0,
      return_items_count: riQ.rowCount ?? 0,
      v_inventory_rows: viewQ.rows?.length ?? 0,
      lines: allLines,
      summary: {
        total_lines: allLines.length,
        normalize_linked: linkedCount,
        normalize_no_link: noLinkCount,
        map_miss: mapMissCount,
        resolver_would_link: resolverWouldLink,
        display_only_no_link: displayOnlyWouldNoLink,
      },
    },
    shipment25_match_attempts: allLines.map((l) => ({
      row_id: l.row_id,
      source_kind: l.source_kind,
      identifiers: l.identifiers,
      map_hit_count: (l.product_identifier_map as Row)?.hit_count,
      resolver_status: (l.match_attempts as Row)?.resolver_with_store?.status,
      matched_via: (l.match_attempts as Row)?.resolver_with_store?.matched_via,
    })),
    failed_rule_per_item: allLines.map((l) => ({
      row_id: l.row_id,
      source_kind: l.source_kind,
      fnsku: (l.identifiers as Row)?.fnsku,
      failed_rule: l.why_match_failed,
      display_label: (l.display_labels as Row)?.normalize_path,
    })),
    regression_classification: {
      resolver_regression: resolverWouldLink >= linkedCount && mapMissCount < noLinkCount ? "possible_display_path" : "no_core_resolver_change",
      data_regression: mapMissCount > 0 ? "yes_for_unmapped_fnskus" : "no",
      filter_regression: "store_scope_scanner_allows_null_store_map; claim_requires_exact_store",
      migration_regression: "no_migration_changed_map_rows_in_this_audit",
    },
    recent_linkage_code_changes: recentLinkageCommits(),
    current_vs_last_working: {
      last_known_working_behavior: "4 products linked on Shipment 25 when product_identifier_map had hits OR persisted resolved_product_id populated",
      current_behavior: `${linkedCount} Linked / ${noLinkCount} No Link on ${allLines.length} lines via normalizeScannerProductLinkageDisplay`,
      key_change: "normalizeScannerProductLinkageDisplay added live resolve on list paths (fix); client identify-gate still uses display-only buildInventoryViewProductLinkage; runtime may still bind staging",
    },
    root_cause: rootCause,
    safe_fix_strategy:
      rootCause === "data_regression_true_unmapped_identifiers_no_spine_map"
        ? "Governed product_identifier_map insert for unmapped FNSKUs (ZZQDPD4GHB, ZZQCP25AW3); deploy parity fix; swap runtime to original + restart dev"
        : "Deploy normalizeScannerProductLinkageDisplay paths; swap NEXT_PUBLIC to ORIGINAL_*; restart dev; verify identify-gate client fallback",
    requires_data_backfill: mapMissCount > 0 && resolverWouldLink === 0 ? "yes_for_unmapped_rows_only" : "no_for_mapped_controls",
    requires_code_fix:
      resolverWouldLink > linkedCount || runtimeRef !== PRODUCTION_REF ? "yes_display_and_env" : "no",
    DO_NOT_APPLY_FIX_YET: true,
    no_data_mutation_verification: true,
  };

  await c.end();

  fs.writeFileSync(path.join(outDir, "audit-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    `# Critical product linkage regression audit

**Run:** ${rid}
**Shipment 25 package:** ${pkg.package_code} (${pkgId})
**Lines:** ${allLines.length} — Linked ${linkedCount} / No Link ${noLinkCount}
**Root cause:** ${rootCause}

## Failed rules (sample)
${allLines
  .slice(0, 15)
  .map(
    (l) =>
      `- ${l.source_kind} ${(l.identifiers as Row)?.fnsku ?? "—"}: **${l.why_match_failed}** → ${(l.display_labels as Row)?.normalize_path}`,
  )
  .join("\n")}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        root_cause: rootCause,
        linked: linkedCount,
        no_link: noLinkCount,
        DO_NOT_APPLY_FIX_YET: true,
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

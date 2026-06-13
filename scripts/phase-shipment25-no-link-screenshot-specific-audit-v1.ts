/**
 * PHASE-SHIPMENT25-NO-LINK-SCREENSHOT-SPECIFIC-AUDIT-V1
 * Read-only audit for Maysam Shipment #25 Box List screenshot items.
 *
 *   npx tsx scripts/phase-shipment25-no-link-screenshot-specific-audit-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import {
  fetchProductNamesByResolvedIds,
  productLinkageOperatorPrimaryDisplayLabel,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
} from "../lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import {
  buildNedaInventoryItemStatusRow,
  classifyViewLinkage,
} from "../lib/inventory-views-product-linkage";
import {
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-shipment25-no-link-screenshot-specific-audit-v1";

const SCREENSHOT_ITEMS = [
  {
    item: 1,
    fnsku: "ZZQDPD4GHB",
    upc: "071662213749",
    alt_fnsku: "ZQCPD4GHB",
  },
  {
    item: 2,
    fnsku: "ZZQCP25AW3",
    upc: "012044000854",
    alt_fnsku: null,
  },
];

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

function sb(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false } });
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const q = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(q.rows.map((r: Row) => String(r.column_name)));
}

async function mapSearch(
  c: pg.Client,
  cols: Set<string>,
  productCols: Set<string>,
  fnsku: string,
  upc: string,
): Promise<{ count: number; rows: Row[]; ambiguity: number }> {
  const fUpper = fnsku.trim().toUpperCase();
  const uNorm = upc.replace(/\D/g, "");
  const upcCol = cols.has("upc_code") ? "upc_code" : cols.has("upc") ? "upc" : null;
  const pName = productCols.has("product_name") ? "p.product_name" : "NULL::text AS product_name";
  const pNameAlt = productCols.has("name") ? "p.name" : "NULL::text AS name";
  const clauses = [`upper(btrim(coalesce(m.fnsku,''))) = $2`];
  const params: unknown[] = [ORG, fUpper];
  if (upcCol) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(m.${upcCol},''), '\\D', '', 'g') = $${params.length}`,
      `regexp_replace(coalesce(m.${upcCol},''), '\\D', '', 'g') = ltrim($${params.length}, '0')`,
    );
  }
  const q = await c.query(
    `SELECT m.id, m.product_id, m.organization_id, m.store_id, m.asin, m.fnsku, m.seller_sku, m.msku,
            ${upcCol ? `m.${upcCol}` : "NULL::text"} AS upc_val,
            m.deleted_at, ${pName}, ${pNameAlt}, p.deleted_at AS p_deleted_at
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id
     WHERE m.organization_id = $1::uuid AND m.deleted_at IS NULL AND p.deleted_at IS NULL
       AND (${clauses.join(" OR ")})
     ORDER BY m.last_seen_at DESC NULLS LAST
     LIMIT 20`,
    params,
  );
  const productIds = new Set(q.rows.map((r: Row) => r.product_id));
  return { count: q.rowCount ?? 0, rows: q.rows, ambiguity: productIds.size > 1 ? productIds.size : 0 };
}

async function epSearch(c: pg.Client, cols: Set<string>, fnsku: string): Promise<Row[]> {
  const fUpper = fnsku.trim().toUpperCase();
  const del = cols.has("deleted_at") ? "AND deleted_at IS NULL" : "";
  const sel = epSelectList(cols);
  if (!sel.includes("fnsku")) return [];
  const q = await c.query(
    `SELECT ${sel}
     FROM expected_packages
     WHERE organization_id = $1::uuid ${del}
       AND upper(btrim(coalesce(fnsku,''))) = $2
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 10`,
    [ORG, fUpper],
  );
  return q.rows;
}

async function viewItemSearch(c: pg.Client, cols: Set<string>, fnsku: string, upc: string): Promise<Row[]> {
  const fUpper = fnsku.trim().toUpperCase();
  const uNorm = upc.replace(/\D/g, "");
  const upcCol = cols.has("upc") ? "upc" : null;
  const clauses = [`upper(btrim(coalesce(fnsku,''))) = $2`];
  const params: unknown[] = [ORG, fUpper];
  if (upcCol) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(${upcCol},''), '\\D', '', 'g') IN ($${params.length}, ltrim($${params.length}, '0'))`,
    );
  }
  const q = await c.query(
    `SELECT *
     FROM v_inventory_item_status
     WHERE organization_id = $1::uuid AND (${clauses.join(" OR ")})
     LIMIT 10`,
    params,
  );
  return q.rows;
}

async function slipSearch(c: pg.Client, cols: Set<string>, fnsku: string, upc: string): Promise<Row[]> {
  const fUpper = fnsku.trim().toUpperCase();
  const uNorm = upc.replace(/\D/g, "");
  const upcCol = cols.has("upc") ? "upc" : cols.has("product_identifier") ? "product_identifier" : null;
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
    "item_name",
    "description",
  ];
  const sel = want.filter((w) => cols.has(w));
  if (upcCol && !sel.includes(upcCol)) sel.push(upcCol);
  if (!sel.includes("fnsku")) return [];
  const clauses = [`upper(btrim(coalesce(fnsku,''))) = $2`];
  const params: unknown[] = [ORG, fUpper];
  if (upcCol) {
    params.push(uNorm);
    clauses.push(
      `regexp_replace(coalesce(${upcCol},''), '\\D', '', 'g') IN ($${params.length}, ltrim($${params.length}, '0'))`,
    );
  }
  const q = await c.query(
    `SELECT ${sel.join(", ")}
     FROM slip_contents
     WHERE organization_id = $1::uuid AND (${clauses.join(" OR ")})
     LIMIT 10`,
    params,
  );
  return q.rows;
}

async function shipment25Context(c: pg.Client): Promise<Row[]> {
  const q = await c.query(
    `SELECT id, organization_id, store_id, package_code, tracking_number, pallet_id, status, deleted_at
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND (
         package_code ILIKE '%25%'
         OR tracking_number ILIKE '%25%'
       )
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 15`,
    [ORG],
  );
  return q.rows;
}

function epSelectList(cols: Set<string>): string {
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
  ];
  return want.filter((w) => cols.has(w)).join(", ");
}

async function epForShipment25(c: pg.Client, epCols: Set<string>, pkgRows: Row[]): Promise<Row[]> {
  const codes = pkgRows.map((r) => r.package_code).filter(Boolean);
  const tracking = pkgRows.map((r) => r.tracking_number).filter(Boolean);
  if (!codes.length && !tracking.length) return [];
  const sel = epSelectList(epCols);
  if (!sel.includes("fnsku")) return [];
  const filters: string[] = [];
  const params: unknown[] = [ORG];
  if (epCols.has("package_code") && codes.length) {
    params.push(codes);
    filters.push(`package_code = ANY($${params.length}::text[])`);
  }
  if (epCols.has("tracking_number") && tracking.length) {
    params.push(tracking);
    filters.push(`tracking_number = ANY($${params.length}::text[])`);
  }
  if (!filters.length) return [];
  const q = await c.query(
    `SELECT ${sel}
     FROM expected_packages
     WHERE organization_id = $1::uuid
       AND (${filters.join(" OR ")})
       AND upper(btrim(coalesce(fnsku,''))) IN ('ZZQDPD4GHB', 'ZZQCP25AW3', 'ZQCPD4GHB')
     LIMIT 20`,
    params,
  );
  return q.rows;
}

function pickPrimaryEp(rows: Row[]): Row | null {
  return rows[0] ?? null;
}

function pickPrimaryView(rows: Row[]): Row | null {
  return rows[0] ?? null;
}

async function simulateScannerLabel(
  sbClient: SupabaseClient,
  invRow: VInventoryStatusRow | null,
  epRow: Row | null,
): Promise<{ label: string; linkage: Row; shows_no_link: boolean }> {
  if (!invRow && !epRow) {
    return {
      label: PRODUCT_LINKAGE_UNMAPPED_LABEL,
      linkage: {},
      shows_no_link: true,
    };
  }
  const row = invRow ?? ({
    expected_package_id: String(epRow?.id ?? ""),
    organization_id: ORG,
    store_id: String(epRow?.store_id ?? STORE),
    fnsku: epRow?.fnsku ?? null,
    sku: epRow?.sku ?? null,
    asin: epRow?.asin ?? null,
    product_id: epRow?.product_id ?? null,
    resolved_product_id: epRow?.resolved_product_id ?? null,
    product_name: epRow?.product_name ?? null,
    product_display_name: epRow?.product_name ?? null,
    product_linkage_status: epRow?.identifier_resolution_status ?? null,
    identifier_resolution_status: epRow?.identifier_resolution_status ?? null,
    identifier_resolution_confidence: null,
    tracking_number: epRow?.tracking_number ?? null,
    id_slip_contents: null,
    order_id: null,
    status: null,
    carrier: null,
    total_expected: 0,
    total_scanned: 0,
  } as VInventoryStatusRow);

  const ids = [row.resolved_product_id, row.product_id].filter(Boolean) as string[];
  const nameMap = await fetchProductNamesByResolvedIds(sbClient, ids);
  const linkage = buildInventoryViewProductLinkage(row, epRow, nameMap);
  const label = productLinkageOperatorPrimaryDisplayLabel(linkage);
  return {
    label,
    linkage: linkage as unknown as Row,
    shows_no_link: label === PRODUCT_LINKAGE_UNMAPPED_LABEL,
  };
}

async function simulateNedaLabel(
  sbClient: SupabaseClient,
  viewRow: Row | null,
): Promise<{ label: string | null; contract: Row | null }> {
  if (!viewRow) return { label: null, contract: null };
  const columns = Object.keys(viewRow);
  const linkageClass = classifyViewLinkage("v_inventory_item_status", columns);
  const neda = await buildNedaInventoryItemStatusRow(sbClient, viewRow, linkageClass);
  const label = productLinkageUserStatusLabel(neda.product_linkage);
  return { label, contract: neda.product_linkage as unknown as Row };
}

async function resolverSim(
  sbClient: SupabaseClient,
  row: Row | null,
): Promise<Row> {
  if (!row) return { error: "no row" };
  const storeId = row.store_id ? String(row.store_id) : null;
  const withoutStore = await resolveScannerProductIdentifiers(sbClient, {
    organizationId: ORG,
    storeId: null,
    fnsku: row.fnsku ? String(row.fnsku) : null,
    upc: row.upc ? String(row.upc) : null,
    sku: row.sku ? String(row.sku) : null,
    asin: row.asin ? String(row.asin) : null,
  });
  const withStore = storeId
    ? await resolveScannerProductIdentifiers(sbClient, {
        organizationId: ORG,
        storeId,
        fnsku: row.fnsku ? String(row.fnsku) : null,
        upc: row.upc ? String(row.upc) : null,
        sku: row.sku ? String(row.sku) : null,
        asin: row.asin ? String(row.asin) : null,
      })
    : null;
  return { without_store: withoutStore, with_store: withStore, store_id_on_row: storeId };
}

function whyUiSaysNoLink(input: {
  map: { count: number; ambiguity: number };
  ep: Row | null;
  view: Row | null;
  scanner: { label: string; linkage: Row };
  resolver: Row;
}): string {
  if (input.map.count === 0) return "true_unmapped_no_product_identifier_map_hit";
  if (input.map.ambiguity > 1) return "ambiguous_multiple_map_product_ids";
  const resolved =
    input.view?.resolved_product_id ??
    input.ep?.resolved_product_id ??
    input.ep?.product_id ??
    input.map.rows[0]?.product_id;
  const catalogName =
    input.scanner.linkage.product_name ??
    input.view?.product_name ??
    input.ep?.product_name ??
    input.map.rows[0]?.product_name;
  if (resolved && !catalogName && input.scanner.label === PRODUCT_LINKAGE_UNMAPPED_LABEL) {
    return "ui_mapper_regression_resolved_id_without_catalog_name_hydration";
  }
  if (!resolved && input.resolver.with_store?.resolved_product_id) {
    return "operational_row_missing_resolved_product_id_resolver_would_hit_with_store";
  }
  if (!resolved && !input.resolver.with_store?.resolved_product_id && input.map.count > 0) {
    return "store_scope_or_resolver_miss_despite_map";
  }
  if (input.scanner.label === PRODUCT_LINKAGE_UNMAPPED_LABEL) {
    return "scanner_productLinkageOperatorPrimaryDisplayLabel_unmapped";
  }
  return "unknown";
}

async function auditItem(
  c: pg.Client,
  mapCols: Set<string>,
  productCols: Set<string>,
  epCols: Set<string>,
  viewCols: Set<string>,
  slipCols: Set<string>,
  originalSb: SupabaseClient,
  runtimeSb: SupabaseClient,
  item: (typeof SCREENSHOT_ITEMS)[0],
): Promise<Row> {
  const map = await mapSearch(c, mapCols, productCols, item.fnsku, item.upc);
  let altMap = { count: 0, rows: [] as Row[], ambiguity: 0 };
  if (item.alt_fnsku) altMap = await mapSearch(c, mapCols, productCols, item.alt_fnsku, item.upc);

  const epRows = await epSearch(c, epCols, item.fnsku);
  const viewRows = await viewItemSearch(c, viewCols, item.fnsku, item.upc);
  const slipRows = await slipSearch(c, slipCols, item.fnsku, item.upc);
  const ep = pickPrimaryEp(epRows);
  const view = pickPrimaryView(viewRows);

  const resolverOriginal = await resolverSim(originalSb, ep ?? view ?? slipRows[0] ?? null);
  const resolverRuntime = await resolverSim(runtimeSb, ep ?? view ?? slipRows[0] ?? null);

  const invFromView: VInventoryStatusRow | null = view
    ? ({
        expected_package_id: String(view.expected_package_id ?? view.id ?? ""),
        organization_id: String(view.organization_id ?? ORG),
        store_id: view.store_id ? String(view.store_id) : STORE,
        tracking_number: view.tracking_number ? String(view.tracking_number) : null,
        id_slip_contents: view.slip_code ? String(view.slip_code) : null,
        sku: view.sku ? String(view.sku) : null,
        fnsku: view.fnsku ? String(view.fnsku) : null,
        asin: view.asin ? String(view.asin) : null,
        order_id: view.order_id ? String(view.order_id) : null,
        status: view.status ? String(view.status) : null,
        product_name: view.product_name ? String(view.product_name) : null,
        product_display_name: view.product_display_name ? String(view.product_display_name) : null,
        product_id: view.product_id ?? null,
        resolved_product_id: view.resolved_product_id ?? null,
        resolved_catalog_product_id: view.resolved_catalog_product_id ?? null,
        product_linkage_status: view.product_linkage_status ?? null,
        identifier_resolution_status: view.identifier_resolution_status ?? null,
        identifier_resolution_confidence: view.identifier_resolution_confidence ?? null,
        carrier: null,
        total_expected: Number(view.expected_quantity ?? view.total_expected ?? 0) || 0,
        total_scanned: Number(view.scanned_quantity ?? view.total_scanned ?? 0) || 0,
      } as VInventoryStatusRow)
    : null;

  const scannerOriginal = await simulateScannerLabel(originalSb, invFromView, ep);
  const scannerRuntime = await simulateScannerLabel(runtimeSb, invFromView, ep);
  const nedaOriginal = await simulateNedaLabel(originalSb, view);
  const nedaRuntime = await simulateNedaLabel(runtimeSb, view);

  const primarySource = ep
    ? { table: "expected_packages", id: ep.id }
    : view
      ? { table: "v_inventory_item_status", id: view.id ?? view.source_row_id }
      : slipRows[0]
        ? { table: "slip_contents", id: slipRows[0].id }
        : { table: null, id: null };

  const why = whyUiSaysNoLink({
    map,
    ep,
    view,
    scanner: scannerOriginal,
    resolver: resolverOriginal,
  });

  let classification: string;
  if (map.count === 0 && altMap.count === 0) classification = "true_unmapped_product";
  else if (map.count > 0 && scannerOriginal.shows_no_link) classification = "runtime_ui_mapper_regression";
  else if (!ep?.store_id && !view?.store_id && resolverOriginal.with_store?.resolved_product_id)
    classification = "store_scope_mismatch";
  else if (map.count > 0) classification = "map_exists_linkage_should_resolve";
  else classification = "investigate";

  return {
    screenshot_item: item.item,
    fnsku: item.fnsku,
    upc: item.upc,
    alt_fnsku_checked: item.alt_fnsku,
    source_table: primarySource.table,
    source_row_id: primarySource.id,
    organization_id: ep?.organization_id ?? view?.organization_id ?? ORG,
    store_id: ep?.store_id ?? view?.store_id ?? null,
    asin: ep?.asin ?? view?.asin ?? map.rows[0]?.asin ?? null,
    sku_msku: ep?.sku ?? view?.sku ?? map.rows[0]?.seller_sku ?? map.rows[0]?.msku ?? null,
    product_id: ep?.product_id ?? view?.product_id ?? null,
    resolved_product_id: ep?.resolved_product_id ?? view?.resolved_product_id ?? null,
    product_name:
      ep?.product_name ?? view?.product_name ?? map.rows[0]?.product_name ?? slipRows[0]?.item_name ?? null,
    identifier_resolution_status:
      ep?.identifier_resolution_status ?? view?.identifier_resolution_status ?? null,
    product_linkage_status: ep?.product_linkage_status ?? view?.product_linkage_status ?? null,
    product_identifier_map: {
      match_count: map.count,
      alt_fnsku_match_count: altMap.count,
      ambiguity_count: map.ambiguity,
      matched_product_id: map.rows[0]?.product_id ?? null,
      matched_product_name: map.rows[0]?.product_name ?? map.rows[0]?.name ?? null,
      rows: map.rows.slice(0, 3),
    },
    expected_packages_rows: epRows.slice(0, 3),
    v_inventory_item_status_rows: viewRows.slice(0, 3),
    slip_contents_rows: slipRows.slice(0, 3),
    resolver_simulation_original: resolverOriginal,
    direct_db_vs_runtime: {
      runtime_project_ref: refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
      original_project_ref: PRODUCTION_REF,
      runtime_bound_to_original: refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") === PRODUCTION_REF,
      map_count_original_pg: map.count,
      scanner_label_original: scannerOriginal.label,
      scanner_label_runtime: scannerRuntime.label,
      neda_label_original: nedaOriginal.label,
      neda_label_runtime: nedaRuntime.label,
      resolver_runtime: resolverRuntime,
    },
    ui_condition: {
      scanner_path: "productLinkageOperatorPrimaryDisplayLabel(buildInventoryViewProductLinkage(...))",
      scanner_shows_no_link_original: scannerOriginal.shows_no_link,
      neda_shows_no_link_original: nedaOriginal.label === PRODUCT_LINKAGE_LABEL_NO_LINK,
      scanner_linkage_contract: scannerOriginal.linkage,
    },
    why_ui_says_no_link: why,
    classification,
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  bindProductionSupabaseEnv();

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const pgUrl = productionPostgresUrl();
  const c = await connectPg(pgUrl);
  const mapCols = await tableColumns(c, "product_identifier_map");
  const productCols = await tableColumns(c, "products");
  const epCols = await tableColumns(c, "expected_packages");
  const viewCols = await tableColumns(c, "v_inventory_item_status");
  const slipCols = await tableColumns(c, "slip_contents");
  const originalSb = sb(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!);
  const runtimeSb = sb(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const shipment25 = await shipment25Context(c);
  const epShipment25 = await epForShipment25(c, epCols, shipment25);

  const item1 = await auditItem(c, mapCols, productCols, epCols, viewCols, slipCols, originalSb, runtimeSb, SCREENSHOT_ITEMS[0]!);
  const item2 = await auditItem(c, mapCols, productCols, epCols, viewCols, slipCols, originalSb, runtimeSb, SCREENSHOT_ITEMS[1]!);

  await c.end();

  let exactRootCause: string;
  if (item1.classification === "true_unmapped_product" && item2.classification === "true_unmapped_product") {
    exactRootCause = "true_unmapped_products_no_spine_map_for_screenshot_fnskus";
  } else if (
    item1.classification === "runtime_ui_mapper_regression" ||
    item2.classification === "runtime_ui_mapper_regression"
  ) {
    exactRootCause = "ui_mapper_regression_map_or_name_present_but_scanner_shows_no_link";
  } else if (
    item1.classification === "store_scope_mismatch" ||
    item2.classification === "store_scope_mismatch"
  ) {
    exactRootCause = "store_scope_mismatch_missing_store_id_on_operational_row";
  } else if (
    (item1.product_identifier_map as Row).match_count > 0 ||
    (item2.product_identifier_map as Row).match_count > 0
  ) {
    exactRootCause = "mixed_map_hits_check_per_item_classification";
  } else {
    exactRootCause = "true_unmapped_no_product_identifier_map_for_both_screenshot_items";
  }

  const runtimeMismatch = item1.direct_db_vs_runtime?.runtime_bound_to_original === false;

  const result = {
    phase: "PHASE-SHIPMENT25-NO-LINK-SCREENSHOT-SPECIFIC-AUDIT-V1",
    run_id: rid,
    shipment_25_context: {
      packages_candidates: shipment25.slice(0, 5),
      expected_packages_for_items: epShipment25,
    },
    screenshot_item_audit: SCREENSHOT_ITEMS,
    item_1_linkage_result: item1,
    item_2_linkage_result: item2,
    direct_db_vs_runtime_payload_diff: {
      runtime_project_ref: refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
      original_project_ref: PRODUCTION_REF,
      runtime_bound_to_original: !runtimeMismatch,
      note: runtimeMismatch
        ? "Runtime still on staging; original PG audit is authoritative for screenshot"
        : "Runtime bound to original",
      item_1_scanner_label: {
        original: item1.ui_condition?.scanner_shows_no_link_original,
        runtime: item1.direct_db_vs_runtime?.scanner_label_runtime,
      },
      item_2_scanner_label: {
        original: item2.ui_condition?.scanner_shows_no_link_original,
        runtime: item2.direct_db_vs_runtime?.scanner_label_runtime,
      },
    },
    exact_root_cause: exactRootCause,
    safe_minimal_fix_if_needed:
      exactRootCause.includes("ui_mapper")
        ? [
            "Extend lib/scanner/product-linkage-display-contract.ts productLinkageOperatorPrimaryDisplayLabel to treat resolved_product_id + map hydration like dashboard fix",
            "Or hydrate product_name in buildInventoryViewProductLinkage when map hit exists",
            "No DB writes",
          ]
        : exactRootCause.includes("store_scope")
          ? ["Backfill store_id on operational rows — blocked; prefer readmodel resolver with org+store from page context"]
          : exactRootCause.includes("true_unmapped")
            ? ["Manual map insert via governed workflow only — do not auto-create products"]
            : ["Verify env bind to original if comparing against original screenshot"],
    NO_DATA_MUTATION_VERIFICATION: true,
    SAFE_TO_FIX_WITH_CODE_ONLY:
      exactRootCause.includes("ui_mapper") || exactRootCause.includes("store_scope") ? "yes" : "no",
    NEXT_PROMPT:
      exactRootCause.includes("ui_mapper")
        ? "PHASE-SCANNER-PRODUCT-LINKAGE-DISPLAY-MAPPER-MINIMAL-FIX-V1"
        : exactRootCause.includes("true_unmapped")
          ? "PHASE-SHIPMENT25-UNMAPPED-IDENTIFIER-GOVERNED-MAP-PLAN-V1"
          : "PHASE-ORIGINAL-RUNTIME-ENV-SWAP-AND-RESTART-V1",
  };

  fs.writeFileSync(path.join(outDir, "audit-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    `# Shipment #25 No Link screenshot audit

**Run:** ${rid}

## Item 1 — ${SCREENSHOT_ITEMS[0]!.fnsku} / UPC ${SCREENSHOT_ITEMS[0]!.upc}
- Map hits: ${(item1.product_identifier_map as Row).match_count}
- Classification: ${item1.classification}
- Why No Link: ${item1.why_ui_says_no_link}
- Scanner label (original sim): ${item1.direct_db_vs_runtime?.scanner_label_original}

## Item 2 — ${SCREENSHOT_ITEMS[1]!.fnsku} / UPC ${SCREENSHOT_ITEMS[1]!.upc}
- Map hits: ${(item2.product_identifier_map as Row).match_count}
- Classification: ${item2.classification}
- Why No Link: ${item2.why_ui_says_no_link}
- Scanner label (original sim): ${item2.direct_db_vs_runtime?.scanner_label_original}

## Root cause
${exactRootCause}

**SAFE_TO_FIX_WITH_CODE_ONLY:** ${result.SAFE_TO_FIX_WITH_CODE_ONLY}
`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));

  console.log(
    JSON.stringify(
      {
        run_id: rid,
        outDir,
        exact_root_cause: exactRootCause,
        item1_map: (item1.product_identifier_map as Row).match_count,
        item2_map: (item2.product_identifier_map as Row).match_count,
        item1_class: item1.classification,
        item2_class: item2.classification,
        SAFE_TO_FIX_WITH_CODE_ONLY: result.SAFE_TO_FIX_WITH_CODE_ONLY,
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

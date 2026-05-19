/**
 * PRODUCT-ID-LINKAGE-CLOSURE-V167 — read-only staging schema + linkage probes.
 * Usage: npx tsx scripts/product-id-linkage-closure-v167-probe.ts
 *
 * No migrations, writes, production, Amazon, or AI.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT,
  RETURN_SCANNER_LINKAGE_SELECT,
  RETURN_ITEMS_TABLE,
  SLIP_SCANNER_LINKAGE_SELECT,
} from "../app/returns/returns-constants";
import {
  EP_DETAIL_SELECT,
  EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT,
} from "../lib/scanner/operator-tracking-expectations";

const EP_SELECT = "sku, fnsku, disposition, expected_scan_quantity, order_id, tracking_number";
const EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT =
  EP_SELECT +
  ", identifier_resolution_status, product_match_status, product_review_required, " +
  "expected_product_id, resolved_product_id, resolved_catalog_product_id";

const TARGET_TABLES = [
  "products",
  "product_identifier_map",
  "return_items",
  "slip_contents",
  "expected_packages",
  "packages",
  "claim_reference_edges",
  "raw_report_uploads",
  "catalog_products",
  "listing_raw_rows",
] as const;

const LINKAGE_COLUMN_CANDIDATES = [
  "product_id",
  "catalog_product_id",
  "expected_product_id",
  "scanned_product_id",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
  "identifier_resolution_source",
  "identifier_resolution_meta",
  "product_match_status",
  "product_review_required",
  "product_resolved_at",
  "product_resolved_by",
  "expected_item_id",
  "asin",
  "fnsku",
  "sku",
  "upc",
  "upc_code",
  "seller_sku",
  "parsed_asin",
  "parsed_fnsku",
  "parsed_sku",
  "parsed_upc",
  "product_identifier",
] as const;

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function extractProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] ?? null;
}

type OpenApiProp = { type?: string; format?: string };
type ColumnDef = { name: string; type: string; format: string };

async function fetchOpenApiColumns(
  baseUrl: string,
  apikey: string,
  table: string,
): Promise<{ ok: boolean; columns: ColumnDef[]; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/rest/v1/`, {
      headers: {
        apikey,
        Authorization: `Bearer ${apikey}`,
        Accept: "application/openapi+json",
      },
    });
    if (!res.ok) return { ok: false, columns: [], error: `OpenAPI HTTP ${res.status}` };
    const doc = (await res.json()) as {
      definitions?: Record<string, { properties?: Record<string, OpenApiProp> }>;
    };
    const def = doc.definitions?.[table];
    if (!def?.properties) {
      return { ok: false, columns: [], error: `No OpenAPI definition for ${table}` };
    }
    const columns = Object.entries(def.properties).map(([name, p]) => ({
      name,
      type: p.type ?? "unknown",
      format: p.format ?? "",
    }));
    return { ok: true, columns };
  } catch (e) {
    return { ok: false, columns: [], error: e instanceof Error ? e.message : String(e) };
  }
}

function hasColumn(columns: ColumnDef[], name: string): boolean {
  return columns.some((c) => c.name === name);
}

function linkageMatrixForTable(columns: ColumnDef[]): Record<string, "present" | "absent"> {
  const out: Record<string, "present" | "absent"> = {};
  for (const k of LINKAGE_COLUMN_CANDIDATES) {
    out[k] = hasColumn(columns, k) ? "present" : "absent";
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.PRODUCT_ID_LINKAGE_V167_RUN_ID ?? "run-20260518-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/product-id-linkage-closure-v167",
    runId,
  );
  mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const projectRef = extractProjectRef(url);

  const report: Record<string, unknown> = {
    audit: "product-id-linkage-closure-v167",
    run_id: runId,
    date: "2026-05-18",
    mode: "read_only",
    project_ref: projectRef,
    probe_method: "PostgREST OpenAPI + limit=0/1 SELECT (service role, no writes)",
    migration_reference: "supabase/migrations/20260717120000_scanner_product_linkage_columns.sql",
    tables: {} as Record<string, unknown>,
    app_select_probes: [] as { name: string; ok: boolean; detail: string }[],
    sample_linkage_rows: {} as Record<string, unknown>,
  };

  if (!url || !key) {
    report.error = "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY";
    writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
    console.error(report.error);
    process.exit(1);
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const tablesReport: Record<string, unknown> = {};

  for (const table of TARGET_TABLES) {
    const oa = await fetchOpenApiColumns(url, key, table);
    const linkage = oa.ok ? linkageMatrixForTable(oa.columns) : {};
    tablesReport[table] = {
      open_api_ok: oa.ok,
      open_api_error: oa.error ?? null,
      column_count: oa.columns.length,
      linkage_matrix: linkage,
      columns: oa.columns,
    };
  }

  report.tables = tablesReport;
  writeFileSync(join(outDir, "columns-live.json"), JSON.stringify(tablesReport, null, 2));

  async function probeSelect(name: string, table: string, select: string): Promise<void> {
    const { error } = await supabase.from(table).select(select).limit(1);
    const probes = report.app_select_probes as { name: string; ok: boolean; detail: string }[];
    probes.push({
      name,
      ok: !error,
      detail: error ? `${error.code ?? "error"}: ${error.message}` : "select ok",
    });
  }

  const appProbes: [string, string, string][] = [
    ["return_items_list_with_linkage", RETURN_ITEMS_TABLE, RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT],
    ["return_items_linkage_only", RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT],
    ["slip_contents_linkage", "slip_contents", SLIP_SCANNER_LINKAGE_SELECT],
    ["EP_SELECT_identify", "expected_packages", EP_SELECT],
    ["EP_TRACKING_with_scanner_product", "expected_packages", EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT],
    ["EP_DETAIL_SELECT", "expected_packages", EP_DETAIL_SELECT],
    ["EP_DETAIL_with_scanner_product", "expected_packages", EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT],
    ["v_product_identity", "v_product_identity", "product_id, asin, fnsku, seller_sku, upc_code"],
    ["product_identifier_map_bridge", "product_identifier_map", "product_id, catalog_product_id, asin, fnsku, seller_sku, upc_code"],
    ["return_items_legacy_product_id", RETURN_ITEMS_TABLE, "id, product_id, asin, fnsku, sku"],
    ["return_items_identifier_resolution_source", RETURN_ITEMS_TABLE, "id, identifier_resolution_source"],
    ["slip_contents_identifier_resolution_source", "slip_contents", "id, identifier_resolution_source"],
    ["slip_contents_parsed_columns", "slip_contents", "parsed_asin, parsed_fnsku, parsed_sku, parsed_upc"],
    ["packages_list", "packages", "id, package_code, tracking_number, store_id, organization_id"],
  ];

  for (const [name, table, sel] of appProbes) {
    await probeSelect(name, table, sel);
  }

  const { data: recentResolved } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id, product_id, resolved_product_id, identifier_resolution_status, fnsku, created_at")
    .not("resolved_product_id", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: recentNullResolved } = await supabase
    .from(RETURN_ITEMS_TABLE)
    .select("id, product_id, resolved_product_id, identifier_resolution_status, fnsku, created_at")
    .is("resolved_product_id", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(3);

  const { data: slipResolved } = await supabase
    .from("slip_contents")
    .select("id, resolved_product_id, identifier_resolution_status, fnsku, upc")
    .not("resolved_product_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);

  report.sample_linkage_rows = {
    return_items_with_resolved_product_id: recentResolved ?? [],
    return_items_null_resolved_recent: recentNullResolved ?? [],
    slip_contents_with_resolved_product_id: slipResolved ?? [],
  };

  const epCols = (tablesReport.expected_packages as { columns?: ColumnDef[] })?.columns ?? [];
  const epHasProductFk = ["expected_product_id", "resolved_product_id", "resolved_catalog_product_id"].some((c) =>
    hasColumn(epCols, c),
  );

  report.expected_packages_product_fk_on_live = epHasProductFk;
  report.expected_packages_intentional_sku_tracking_only = !epHasProductFk;

  writeFileSync(join(outDir, "probe-output.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run_id: runId, outDir, project_ref: projectRef }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * V197 — PRODUCT LINKAGE TABLE CENSUS (read-only, staging)
 *
 *   npx tsx scripts/v197-product-linkage-table-census.ts
 *   npx tsx scripts/v197-product-linkage-table-census.ts --run-id=20260522T120000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v197-product-linkage-table-census";

type Category =
  | "catalog-spine"
  | "item-level"
  | "package-pallet-aggregate"
  | "report-source"
  | "claim"
  | "view-read-model";

type PersistMode = "persist-resolved" | "persist-legacy-product-id" | "read-layer-only" | "aggregate-indirect" | "n/a";

type TableSpec = {
  name: string;
  category: Category;
  owner: string;
  persist_mode: PersistMode;
  product_col?: string;
  resolved_col?: string;
  id_cols: string[];
  active_filter?: { col: string; op: "is" | "eq"; val: unknown }[];
  notes: string;
};

type CensusRow = {
  name: string;
  category: Category;
  owner: string;
  persist_mode: PersistMode;
  total_rows: number | null;
  product_id_non_null: number | null;
  resolved_product_id_non_null: number | null;
  legacy_product_id_only: number | null;
  identifier_only_rows: number | null;
  direct_or_persisted_resolved: number | null;
  read_layer_resolved: number | null;
  unresolved_rows: number | null;
  ambiguous_rows: number | null;
  linkage_primary: string;
  query_errors: string[];
  notes: string;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function loadEnv(): void {
  loadEnvLocalIntoProcess();
}

function sbClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  if (refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error(`Ref guard failed (expected ${STAGING_REF})`);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function countHead(
  sb: SupabaseClient,
  table: string,
  filters: { col: string; op: "eq" | "is" | "not"; val: unknown }[] = [],
): Promise<{ count: number | null; error: string | null }> {
  try {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    for (const f of filters) {
      if (f.op === "eq") q = q.eq(f.col, f.val as string);
      else if (f.op === "is") q = q.is(f.col, f.val);
      else q = q.not(f.col, "is", null);
    }
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: count ?? 0, error: null };
  } catch (e) {
    return { count: null, error: e instanceof Error ? e.message : String(e) };
  }
}

const TABLE_SPECS: TableSpec[] = [
  {
    name: "products",
    category: "catalog-spine",
    owner: "PIM/catalog import waves",
    persist_mode: "n/a",
    id_cols: [],
    notes: "Canonical product spine; every row is a product.",
  },
  {
    name: "product_identifier_map",
    category: "catalog-spine",
    owner: "Governed map-only / promotion executes",
    persist_mode: "n/a",
    product_col: "product_id",
    id_cols: ["seller_sku", "msku", "asin", "fnsku", "upc_code"],
    active_filter: [{ col: "deleted_at", op: "is", val: null }],
    notes: "Active map rows only (deleted_at IS NULL).",
  },
  {
    name: "return_items",
    category: "item-level",
    owner: "Returns scanner + insertReturn/updateReturn",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin", "product_identifier"],
    active_filter: [{ col: "deleted_at", op: "is", val: null }],
    notes: "Canonical scanned item lines.",
  },
  {
    name: "expected_packages",
    category: "item-level",
    owner: "Amazon expected import + Neda read model",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku"],
    notes: "Do not auto-update row product columns in bulk; read resolves via map.",
  },
  {
    name: "slip_contents",
    category: "item-level",
    owner: "Packing-slip OCR/import lines",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Small cohort; future UPC/GTIN enrichment source.",
  },
  {
    name: "amazon_amazon_fulfilled_inventory",
    category: "report-source",
    owner: "AFI import + catalog resolver waves",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["seller_sku", "fulfillment_channel_sku", "asin"],
    notes: "Primary Amazon inventory report spine.",
  },
  {
    name: "amazon_fba_inventory",
    category: "report-source",
    owner: "FBA inventory import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Trusted product_name source for expected E2.",
  },
  {
    name: "amazon_manage_fba_inventory",
    category: "report-source",
    owner: "Manage FBA inventory import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Trusted product_name source for expected E2.",
  },
  {
    name: "amazon_returns",
    category: "report-source",
    owner: "Amazon returns report import",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Return report lines; claim source candidate.",
  },
  {
    name: "amazon_settlements",
    category: "report-source",
    owner: "Settlement report import",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "asin"],
    notes: "Financial lines; product creation forbidden in gates.",
  },
  {
    name: "claim_candidates",
    category: "claim",
    owner: "Claim inbox / promotion workflow",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Legacy claim queue; links to source_table/source_row_id.",
  },
  {
    name: "claim_candidate_drafts",
    category: "claim",
    owner: "V2 claim generator staging",
    persist_mode: "persist-resolved",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Promotes to claim_candidates; needs_product_link lifecycle.",
  },
  {
    name: "shipment_box_items",
    category: "item-level",
    owner: "Shipment scan allocation tree",
    persist_mode: "read-layer-only",
    id_cols: ["sku", "fnsku"],
    notes: "No resolved_product_id column; resolve at read/submit only.",
  },
  {
    name: "shipment_boxes",
    category: "package-pallet-aggregate",
    owner: "Shipment scan tree (box)",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Container for box_items; product linkage via children.",
  },
  {
    name: "shipment_containers",
    category: "package-pallet-aggregate",
    owner: "Shipment scan tree (tracking)",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Tracking-level parent only.",
  },
  {
    name: "packages",
    category: "package-pallet-aggregate",
    owner: "Returns packages hierarchy",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Product display from child return_items / expected rows.",
  },
  {
    name: "pallets",
    category: "package-pallet-aggregate",
    owner: "Returns pallets hierarchy",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Aggregate only.",
  },
  {
    name: "v_scanned_items_counted",
    category: "view-read-model",
    owner: "Neda inventory read (scanned aggregate)",
    persist_mode: "read-layer-only",
    product_col: "product_id",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Item-level scanned view with product columns (staging DDL).",
  },
  {
    name: "v_inventory_item_status",
    category: "view-read-model",
    owner: "Neda inventory expected/scanned compare",
    persist_mode: "read-layer-only",
    resolved_col: "resolved_product_id",
    id_cols: ["sku", "fnsku", "asin"],
    notes: "Item-level expected vs scanned with product_comparison.",
  },
  {
    name: "v_inventory_status",
    category: "view-read-model",
    owner: "Neda inventory package aggregate",
    persist_mode: "aggregate-indirect",
    id_cols: [],
    notes: "Package-level counts only; intentionally product-agnostic.",
  },
];

async function censusTable(sb: SupabaseClient, spec: TableSpec): Promise<CensusRow> {
  const errors: string[] = [];
  const filters = spec.active_filter ?? [];

  const total = await countHead(sb, spec.name, filters);
  if (total.error) errors.push(`total: ${total.error}`);

  let productNonNull: number | null = null;
  if (spec.product_col) {
    const pn = await countHead(sb, spec.name, [...filters, { col: spec.product_col, op: "not", val: null }]);
    if (pn.error) errors.push(`${spec.product_col}: ${pn.error}`);
    else productNonNull = pn.count;
  }

  let resolvedNonNull: number | null = null;
  if (spec.resolved_col) {
    const rn = await countHead(sb, spec.name, [...filters, { col: spec.resolved_col, op: "not", val: null }]);
    if (rn.error) errors.push(`${spec.resolved_col}: ${rn.error}`);
    else resolvedNonNull = rn.count;
  }

  let identifierAny: number | null = null;
  if ((spec.id_cols ?? []).length > 0) {
    const perCol: number[] = [];
    for (const col of spec.id_cols ?? []) {
      const c = await countHead(sb, spec.name, [...filters, { col, op: "not", val: null }]);
      if (c.error) {
        errors.push(`${col}: ${c.error}`);
      } else if (c.count != null) {
        perCol.push(c.count);
      }
    }
    if (perCol.length) identifierAny = Math.max(...perCol);
  }

  const totalN = total.count ?? 0;
  const resolvedN = resolvedNonNull ?? 0;
  const productN = productNonNull ?? 0;
  const idN = identifierAny ?? 0;

  const directOrPersisted = resolvedN > 0 ? resolvedN : productN;
  const identifierOnly =
    total.count != null && (spec.id_cols ?? []).length > 0
      ? Math.max(0, idN - directOrPersisted)
      : null;

  let linkage = "none";
  if (spec.category === "catalog-spine") {
    linkage = spec.name === "products" ? "catalog" : "identifier-bridge";
    if (spec.name === "products") {
      return {
        name: spec.name,
        category: spec.category,
        owner: spec.owner,
        persist_mode: spec.persist_mode,
        total_rows: total.count,
        product_id_non_null: total.count,
        resolved_product_id_non_null: null,
        legacy_product_id_only: null,
        identifier_only_rows: 0,
        direct_or_persisted_resolved: total.count,
        read_layer_resolved: total.count,
        unresolved_rows: 0,
        ambiguous_rows: null,
        linkage_primary: linkage,
        query_errors: errors.length ? errors : [],
        notes: spec.notes,
      };
    }
  }
  else if (spec.category === "package-pallet-aggregate" || spec.name === "v_inventory_status") linkage = "aggregate-indirect";
  else if (spec.category === "view-read-model") linkage = resolvedN > 0 || productN > 0 ? "read-model-hydrated" : idN > 0 ? "identifier-in-view" : "none";
  else if (directOrPersisted / Math.max(totalN, 1) >= 0.5) linkage = "resolved-heavy";
  else if (productN / Math.max(totalN, 1) >= 0.3) linkage = "legacy-product-id";
  else if (idN / Math.max(totalN, 1) >= 0.3) linkage = "identifier-heavy";
  else linkage = "sparse";

  return {
    name: spec.name,
    category: spec.category,
    owner: spec.owner,
    persist_mode: spec.persist_mode,
    total_rows: total.count,
    product_id_non_null: productNonNull,
    resolved_product_id_non_null: resolvedNonNull,
    legacy_product_id_only:
      productNonNull != null && resolvedNonNull != null ? Math.max(0, productNonNull - resolvedNonNull) : null,
    identifier_only_rows: identifierOnly,
    direct_or_persisted_resolved: directOrPersisted || null,
    read_layer_resolved: null,
    unresolved_rows: null,
    ambiguous_rows: null,
    linkage_primary: linkage,
    query_errors: errors.length ? errors : [],
    notes: spec.notes,
  };
}

async function pgReadLayer(
  table: "return_items" | "expected_packages" | "slip_contents",
): Promise<{ read_layer_resolved: number; unresolved: number; ambiguous: number } | null> {
  loadEnv();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) return null;

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  const sqlByTable: Record<string, string> = {
    return_items: `
      WITH base AS (
        SELECT id, organization_id, store_id,
          NULLIF(TRIM(sku), '') AS sku, NULLIF(TRIM(fnsku), '') AS fnsku,
          NULLIF(TRIM(asin), '') AS asin, resolved_product_id
        FROM public.return_items WHERE deleted_at IS NULL
      ),
      map_fnsku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
        GROUP BY b.id
      ),
      map_sku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
        GROUP BY b.id
      ),
      classified AS (
        SELECT b.id,
          CASE
            WHEN b.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN COALESCE(mf.c,0)=1 THEN 'map'
            WHEN COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            WHEN b.sku IS NULL AND b.fnsku IS NULL AND b.asin IS NULL THEN 'no_identifier'
            ELSE 'unresolved'
          END AS bucket
        FROM base b
        LEFT JOIN map_fnsku mf ON mf.id=b.id
        LEFT JOIN map_sku ms ON ms.id=b.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
    expected_packages: `
      WITH ep AS (
        SELECT id, organization_id, store_id, NULLIF(TRIM(sku), '') AS sku,
          NULLIF(TRIM(fnsku), '') AS fnsku, resolved_product_id
        FROM public.expected_packages
      ),
      map_fnsku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
         AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku=ep.fnsku
        GROUP BY ep.id
      ),
      map_sku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=ep.organization_id AND m.store_id=ep.store_id
         AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku=ep.sku OR m.msku=ep.sku)
        GROUP BY ep.id
      ),
      classified AS (
        SELECT ep.id,
          CASE
            WHEN ep.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN COALESCE(mf.c,0)=1 THEN 'map'
            WHEN COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            ELSE 'unresolved'
          END AS bucket
        FROM ep
        LEFT JOIN map_fnsku mf ON mf.id=ep.id
        LEFT JOIN map_sku ms ON ms.id=ep.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
    slip_contents: `
      WITH base AS (
        SELECT id, organization_id, store_id,
          NULLIF(TRIM(sku), '') AS sku, NULLIF(TRIM(fnsku), '') AS fnsku,
          NULLIF(TRIM(asin), '') AS asin, resolved_product_id, product_id
        FROM public.slip_contents
      ),
      map_fnsku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
        GROUP BY b.id
      ),
      map_sku AS (
        SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM base b
        LEFT JOIN public.product_identifier_map m
          ON m.organization_id=b.organization_id AND m.store_id=b.store_id
         AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
        GROUP BY b.id
      ),
      classified AS (
        SELECT b.id,
          CASE
            WHEN b.resolved_product_id IS NOT NULL THEN 'direct'
            WHEN b.product_id IS NOT NULL THEN 'legacy'
            WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'map'
            WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
            WHEN b.sku IS NULL AND b.fnsku IS NULL AND b.asin IS NULL THEN 'no_identifier'
            ELSE 'unresolved'
          END AS bucket
        FROM base b
        LEFT JOIN map_fnsku mf ON mf.id=b.id
        LEFT JOIN map_sku ms ON ms.id=b.id
      )
      SELECT
        COUNT(*) FILTER (WHERE bucket IN ('direct','legacy','map'))::int AS read_layer_resolved,
        COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
        COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
      FROM classified`,
  };

  try {
    await client.connect();
    await client.query("SET statement_timeout = '90s'");
    const r = await client.query(sqlByTable[table]);
    await client.end();
    const row = r.rows[0] as Record<string, number>;
    return {
      read_layer_resolved: Number(row.read_layer_resolved ?? 0),
      unresolved: Number(row.unresolved ?? 0),
      ambiguous: Number(row.ambiguous ?? 0),
    };
  } catch {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return null;
  }
}

function enrichAmazonUnresolved(
  rows: CensusRow[],
  sb: SupabaseClient,
): Promise<void> {
  return (async () => {
    for (const name of [
      "amazon_amazon_fulfilled_inventory",
      "amazon_fba_inventory",
      "amazon_manage_fba_inventory",
      "amazon_returns",
    ] as const) {
      const row = rows.find((r) => r.name === name);
      if (!row || row.total_rows == null) continue;
      const unresolved = await countHead(sb, name, [
        { col: "resolved_product_id", op: "is", val: null },
        { col: "product_id", op: "is", val: null },
      ]);
      if (!unresolved.error) {
        row.unresolved_rows = unresolved.count;
      }
    }
    const settlements = rows.find((r) => r.name === "amazon_settlements");
    if (settlements && settlements.total_rows != null) {
      const u = await countHead(sb, "amazon_settlements", [{ col: "resolved_product_id", op: "is", val: null }]);
      if (!u.error) {
        settlements.unresolved_rows = u.count;
        settlements.read_layer_resolved = settlements.resolved_product_id_non_null ?? 0;
      }
    }
  })();
}

function buildNextWaves(rows: CensusRow[]): string {
  const lines: string[] = [
    "# V197 — Next safe product-linkage waves",
    "",
    "Staging ref: `eiqfaapyumhixxoeltgu`. Read-only census; no executes in this prompt.",
    "",
  ];

  const mapOnly: string[] = [];
  const promote: string[] = [];
  const api: string[] = [];
  const manual: string[] = [];
  const noLink: string[] = [];

  for (const r of rows) {
    const unresolved = r.unresolved_rows ?? (r.total_rows != null ? Math.max(0, (r.total_rows ?? 0) - (r.read_layer_resolved ?? r.direct_or_persisted_resolved ?? 0)) : null);
    if (r.category === "package-pallet-aggregate" || r.name === "v_inventory_status" || r.name === "products") {
      noLink.push(`- **${r.name}** — ${r.notes}`);
      continue;
    }
    if (unresolved != null && unresolved > 0) {
      if (r.name === "expected_packages") {
        mapOnly.push(`- **expected_packages E1B** — ~28 trusted existing-product map-missing (per V194 plan)`);
        promote.push(`- **expected_packages E2** — trusted import product_name promotion (governed, 19 done)`);
        api.push(`- **expected_packages API evidence** — ~46 identifier-only rows`);
        manual.push(`- **expected_packages manual** — ~6 ambiguous trusted-source rows`);
      } else if (r.name.startsWith("amazon_")) {
        if (r.persist_mode === "read-layer-only") {
          api.push(`- **${r.name}** — ${unresolved} unresolved; financial/report lines, API evidence only`);
        } else {
          mapOnly.push(`- **${r.name} map/resolver refresh** — ${unresolved} rows without resolved_product_id`);
        }
      } else if (r.name === "slip_contents") {
        manual.push(`- **slip_contents** — ${unresolved} unresolved; small cohort, manual + governed UPC path`);
      } else if (r.name === "shipment_box_items") {
        manual.push(`- **shipment_box_items** — identifiers only; read-layer resolver at scan/submit`);
      } else if (r.category === "claim") {
        manual.push(`- **${r.name}** — ${unresolved} without resolved_product_id; fix upstream source linkage first`);
      }
    }
  }

  lines.push("## Map-only (safe next)", "", ...(mapOnly.length ? mapOnly : ["- (see expected_packages E1B + AFI/map refresh)"]), "");
  lines.push("## Product promotion from trusted import", "", ...(promote.length ? promote : ["- (expected_packages E2 complete on staging)"]), "");
  lines.push("## API evidence (gated)", "", ...(api.length ? api : ["- None prioritized beyond expected_packages identifier-only"]), "");
  lines.push("## Manual review", "", ...(manual.length ? manual : ["- Claim rows blocked on upstream source"]), "");
  lines.push("## Do not link / aggregate-only", "", ...noLink, "");
  return lines.join("\n");
}

function buildBlockers(rows: CensusRow[]): string {
  return [
    "# V197 — Blockers",
    "",
    "## Environment",
    "",
    "- Census is staging-only (`eiqfaapyumhixxoeltgu`).",
    "- Original/production (`kxsvedvpjldygtdbylsy`) not queried.",
    "",
    "## Query / compute",
    "",
    ...rows
      .filter((r) => r.query_errors.length > 0)
      .map((r) => `- **${r.name}**: ${r.query_errors.join("; ")}`),
    ...(rows.some((r) => r.query_errors.length) ? [] : ["- No Supabase count errors on scoped tables."]),
    "",
    ...rows
      .filter((r) => r.read_layer_resolved == null && r.category === "item-level")
      .map(
        (r) =>
          `- **${r.name}**: read-layer ambiguous/unresolved not computed via Postgres (timeout or skip); use Supabase column counts only.`,
      ),
    "",
    "## Policy",
    "",
    "- `package_items` forbidden.",
    "- Legacy `returns` table forbidden.",
    "- No auto-create from title/OCR/UI.",
    "- `amazon_settlements` product creation disabled in resolver gates.",
    "",
  ].join("\n");
}

const PRIORITY_WEIGHT: Record<string, number> = {
  expected_packages: 1_000_000,
  return_items: 900_000,
  slip_contents: 800_000,
  amazon_amazon_fulfilled_inventory: 700_000,
  claim_candidate_drafts: 600_000,
  claim_candidates: 550_000,
  shipment_box_items: 500_000,
  v_inventory_item_status: 400_000,
  amazon_manage_fba_inventory: 300_000,
  amazon_returns: 250_000,
  amazon_settlements: 50_000,
};

function topUnresolved(rows: CensusRow[]): { name: string; unresolved_rows: number; category: Category; priority: number }[] {
  return rows
    .filter((r) => r.category !== "catalog-spine" && r.name !== "v_inventory_status")
    .map((r) => {
      const unresolved =
        r.unresolved_rows ??
        Math.max(0, (r.total_rows ?? 0) - (r.read_layer_resolved ?? r.direct_or_persisted_resolved ?? 0));
      const weight = PRIORITY_WEIGHT[r.name] ?? (r.category === "report-source" ? 100 : 10);
      return { name: r.name, unresolved_rows: unresolved, category: r.category, priority: weight * 1000 + unresolved };
    })
    .filter((r) => r.unresolved_rows > 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 5);
}

async function main(): Promise<void> {
  loadEnv();
  const id = runId();
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const sb = sbClient();
  const rows: CensusRow[] = [];

  for (const spec of TABLE_SPECS) {
    rows.push(await censusTable(sb, spec));
  }

  for (const t of ["return_items", "expected_packages", "slip_contents"] as const) {
    const row = rows.find((r) => r.name === t);
    if (!row) continue;
    const rl = await pgReadLayer(t);
    if (rl) {
      row.read_layer_resolved = rl.read_layer_resolved;
      row.unresolved_rows = rl.unresolved;
      row.ambiguous_rows = rl.ambiguous;
    }
  }

  await enrichAmazonUnresolved(rows, sb);

  for (const r of rows) {
    if (r.unresolved_rows == null && r.total_rows != null) {
      const resolved = r.read_layer_resolved ?? r.direct_or_persisted_resolved ?? 0;
      r.unresolved_rows = Math.max(0, r.total_rows - resolved);
    }
  }

  const matrix = rows.map((r) => ({
    name: r.name,
    category: r.category,
    owner: r.owner,
    persist_mode: r.persist_mode,
    total_rows: r.total_rows,
    product_id_non_null: r.product_id_non_null,
    resolved_product_id_non_null: r.resolved_product_id_non_null,
    legacy_product_id_only: r.legacy_product_id_only,
    identifier_only_rows: r.identifier_only_rows,
    direct_or_persisted_resolved: r.direct_or_persisted_resolved,
    read_layer_resolved: r.read_layer_resolved,
    unresolved_rows: r.unresolved_rows,
    ambiguous_rows: r.ambiguous_rows,
    linkage_primary: r.linkage_primary,
    query_errors: r.query_errors,
    notes: r.notes,
  }));

  fs.writeFileSync(path.join(outDir, "product-linkage-matrix.json"), JSON.stringify(matrix, null, 2));

  const md = [
    "# V197 — Product linkage table census (staging)",
    "",
    `**Run id:** \`${id}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Mode:** read-only (no DB writes)`,
    "",
    "## By category",
    "",
    "### Catalog spine",
    "",
    "| Table | Rows | Notes |",
    "|-------|-----:|-------|",
    ...rows
      .filter((r) => r.category === "catalog-spine")
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows ?? "?"} | ${r.notes.replace(/\|/g, "\\|")} |`,
      ),
    "",
    "### Item-level",
    "",
    "| Table | Total | Resolved/persisted | Read-layer resolved | Unresolved | Ambiguous | Persist |",
    "|-------|------:|-------------------:|--------------------:|-----------:|----------:|---------|",
    ...rows
      .filter((r) => r.category === "item-level")
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows ?? "?"} | ${r.direct_or_persisted_resolved ?? "?"} | ${r.read_layer_resolved ?? "—"} | ${r.unresolved_rows ?? "?"} | ${r.ambiguous_rows ?? "—"} | ${r.persist_mode} |`,
      ),
    "",
    "### Report / import sources",
    "",
    "| Table | Total | resolved_product_id | product_id | Unresolved |",
    "|-------|------:|--------------------:|-----------:|-----------:|",
    ...rows
      .filter((r) => r.category === "report-source")
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows ?? "?"} | ${r.resolved_product_id_non_null ?? "?"} | ${r.product_id_non_null ?? "?"} | ${r.unresolved_rows ?? "?"} |`,
      ),
    "",
    "### Claim",
    "",
    "| Table | Total | resolved_product_id | product_id | Unresolved |",
    "|-------|------:|--------------------:|-----------:|-----------:|",
    ...rows
      .filter((r) => r.category === "claim")
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows ?? "?"} | ${r.resolved_product_id_non_null ?? "?"} | ${r.product_id_non_null ?? "?"} | ${r.unresolved_rows ?? "?"} |`,
      ),
    "",
    "### Package / pallet / shipment aggregate",
    "",
    "| Table | Rows | Linkage |",
    "|-------|-----:|---------|",
    ...rows
      .filter((r) => r.category === "package-pallet-aggregate")
      .map((r) => `| ${r.name} | ${r.total_rows ?? "?"} | ${r.linkage_primary} |`),
    "",
    "### Inventory views (read models)",
    "",
    "| View | Rows | product_id | resolved_product_id |",
    "|------|-----:|------------|---------------------|",
    ...rows
      .filter((r) => r.category === "view-read-model")
      .map(
        (r) =>
          `| ${r.name} | ${r.total_rows ?? "?"} | ${r.product_id_non_null ?? "—"} | ${r.resolved_product_id_non_null ?? "—"} |`,
      ),
    "",
    "## Source of truth",
    "",
    "| Layer | Owner |",
    "|-------|--------|",
    "| `products` | Canonical product row (`products.id`) |",
    "| `product_identifier_map` | Deterministic identifier bridge |",
    "| Operational persist | `return_items.resolved_product_id`, import resolver columns on Amazon tables |",
    "| Read-layer only | `expected_packages`, `shipment_box_items`, inventory views |",
    "| UI contract | `ProductLinkageDisplayContract` on all hydrated reads |",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "table-census.md"), md);
  fs.writeFileSync(path.join(outDir, "next-safe-waves.md"), buildNextWaves(rows));
  fs.writeFileSync(path.join(outDir, "blockers.md"), buildBlockers(rows));

  const top = topUnresolved(rows);
  const manifest = {
    prompt: "V197 — PRODUCT LINKAGE TABLE CENSUS",
    run_id: id,
    staging_ref: STAGING_REF,
    status: rows.some((r) => r.query_errors.length) ? "CONDITIONAL_PASS" : "PASS",
    table_count: rows.length,
    products_total: rows.find((r) => r.name === "products")?.total_rows ?? null,
    active_map_rows: rows.find((r) => r.name === "product_identifier_map")?.total_rows ?? null,
    top_unresolved: top,
    forbidden: {
      db_mutations: false,
      production_touched: false,
      amazon_api: false,
      ai_openai: false,
      package_items: false,
      legacy_returns_table: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify({ run_id: id, outDir, status: manifest.status, top_unresolved: manifest.top_unresolved }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
